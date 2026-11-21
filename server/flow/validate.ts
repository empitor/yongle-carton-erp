import type { Actor } from '../core/index.js';
import { AppError, isLocalAdministrator } from '../core/index.js';
import { FINISHED_UNIT, RAW_UNIT, UNITS_PER_QUANTITY, deliverableOrder, finishedUnitMessage, rawUnitMessage, today, quantityUnits, quantityString, MAX_STOCK_UNITS } from '../../shared/core/index.js';
import { arrivalSchema, flowInput, type FlowDocument, type FlowDocView, type FlowKind } from '../../shared/business/index.js';
import { fail, taskOf } from './base.js';
import type { ArrivalLine, Check, DeliveryLine, FlowCheck, FlowCommands, StockChange, StockItemRow } from './base.js';
import { checkArrival } from './validate-arrival.js';
import { checkDelivery } from './validate-delivery.js';
import { storedDocuments } from './read.js';

/*
 * 单据保存、核对、确认前的业务校验：按单据种类分开写，FlowService 和更正的方案（*-correction-plan.ts）都调 validateFlow。
 * 返回库存会怎么变（changes）、提示（warnings）、补全后的明细（lines）和补全明细后的单据（document）。
 */

/** 单据输入按种类整理好、带上种类；生产任务、送货单没写计划日的按单据日期（保存、送货更正都经过这里） */
function inputDocument(kind: FlowKind, raw: unknown): FlowDocument {
  switch (kind) {
    case 'arrival':
      return { ...flowInput(kind, raw), kind };
    case 'task': {
      const v = flowInput(kind, raw);
      return { ...v, plannedDate: v.plannedDate || v.date, kind };
    }
    case 'production':
      return { ...flowInput(kind, raw), kind };
    case 'delivery': {
      const v = flowInput(kind, raw);
      return { ...v, plannedDate: v.plannedDate || v.date, kind };
    }
  }
}
/** 到货明细：单位只有“张”，不能每一行都是 0，数量是 0 的行要有库存品 */
function checkArrivalLines(lines: ArrivalLine[]) {
  if (lines.some((l) => l.item.unit !== RAW_UNIT)) throw new AppError(rawUnitMessage);
  if (lines.every((l) => !quantityUnits(l.quantity)))
    throw new AppError('到货单不能每一行都是 0。整张都没到的话，请撤销这次到货，或者直接删除这张到货单。');
  // 数量是 0 的行只能是到货更正留下的，那样的行一定有库存品。数量是 0 又没选库存品的行什么货都没有：
  // 收下它，要么凭空建出一个空的库存品，要么留下一行以后没法做到货更正的明细，所以直接说清楚
  const empty = lines.findIndex((l) => !quantityUnits(l.quantity) && !l.stockId);
  if (empty >= 0)
    throw new AppError('第 ' + (empty + 1) + ' 行的数量是 0，又没有选库存品。这一行没到货就删掉这一行，到了货请填数量。');
}
/**
 * 单据输入：新建、改待核对单据、更正出替代单都走这里。
 * flowInput 已把生产任务的“个”、没写归成“只”，到货明细的空、没写归成“张”；归一后还是别的单位的拒收，不换算。
 * 到货明细的数量必须大于 0（按 arrivalSchema 核对）。只有一种例外，zeroLines：到货更正把某一行改成 0
 * （这一行其实没到货）以后，替代单里留着这一行，再更正时照样收下 0，但不能每一行都是 0。
 */
export function documentInput<K extends FlowKind>(kind: K, raw: unknown, zeroLines?: boolean): FlowDocument<K>;
export function documentInput(kind: FlowKind, raw: unknown, zeroLines = false): FlowDocument {
  if (kind === 'arrival' && !zeroLines) arrivalSchema.parse(raw);
  const v = inputDocument(kind, raw);
  if (v.kind === 'task' && v.unit !== FINISHED_UNIT) throw new AppError(finishedUnitMessage);
  if (v.kind === 'arrival') checkArrivalLines(v.lines);
  return v;
}
/** 按种类核对，到货、送货的明细补全后放回单据 */
function checkKind(ctx: Check, v: FlowDocument): Pick<FlowCheck, 'lines' | 'document'> {
  switch (v.kind) {
    case 'arrival': {
      const lines: ArrivalLine[] = [];
      checkArrival({ ...ctx, lines }, v);
      return { lines, document: { ...v, lines } };
    }
    case 'delivery': {
      const lines: DeliveryLine[] = [];
      checkDelivery({ ...ctx, lines }, v);
      return { lines, document: { ...v, lines } };
    }
    case 'task':
      checkTask(ctx, v);
      return { lines: [], document: v };
    case 'production':
      checkProduction(ctx, v);
      return { lines: [], document: v };
  }
}
/**
 * v 是单据内容或单据视图，返回的 document 和它同样（到货、送货换成补全后的明细）。
 * excludingId：这张单据自己的编号（改、核对、确认它时），超计划、订货单的核对不把它自己算进去。
 * skipRemaining：不按采购剩余数量、订单剩余可发数量核对；其余校验（供应商、客户、库存品、规格、日期等）照旧。
 * 两种情况用：更正出替代单（原单的数量还算在已到货、已发里，方案按净变化另查）；
 * 本机管理员拆分送货单时新建的那张，行是从原单原样搬过来的，不是新增的发货。
 * maintenance：已归档的档案也能用，单据状态不卡。默认只有本机管理员；更正对谁都传 true，
 * 因为更正时沿用的是原单已有的供应商、客户、订单、库存品，后来归档了也得能更正（*-correction-plan.ts）。
 * registered：登记到货（register-arrival.ts）按订货单分配后存的。
 */
type CheckOptions = { excludingId?: number; skipRemaining?: boolean; maintenance?: boolean; registered?: boolean };
export function validateFlow<D extends FlowDocument>(flow: FlowCommands, v: D, actor: Actor, confirm: boolean, options?: CheckOptions): FlowCheck<D>;
export function validateFlow(flow: FlowCommands, v: FlowDocument, actor: Actor, confirm: boolean, options: CheckOptions = {}): FlowCheck {
  const { excludingId, skipRemaining = false, maintenance = isLocalAdministrator(actor), registered = false } = options;
  const stockIds =
    v.kind === 'production'
      ? [...(v.finishedStockId === null ? [] : [v.finishedStockId]), ...v.materials.map((m) => m.stockId)]
      : v.kind === 'task'
        ? []
        : v.lines.flatMap((l) => (l.stockId ? [l.stockId] : []));
  const items = new Map(flow.ops.items(true, stockIds).map((i) => [i.id, i])),
    changes: StockChange[] = [],
    warnings: string[] = [];
  const item = (id: number | null, k: string) => {
    // 到货行没选库存品、按采购明细关联的补上时，开头没读到它，这里补读
    if (id !== null && !items.has(id)) for (const found of flow.ops.items(true, [id])) items.set(found.id, found);
    const it = id === null ? undefined : items.get(id);
    if (!it || it.kind !== k || (it.archived && !maintenance))
      fail('请选择正常的' + (k === 'raw' ? '原材料' : '成品') + '库存品。');
    return it;
  };
  const change = (it: StockItemRow, delta: number, reason: string, lineId?: number, orderId?: number) => {
    changes.push({
      stockId: it.id,
      name: it.name,
      unit: it.unit,
      deltaUnits: delta,
      reason,
      purchaseLineId: lineId || null,
      orderId: orderId || null,
    });
  };
  const checked = checkKind({ flow, actor, maintenance, confirm, excludingId, skipRemaining, registered, item, change, changes, warnings }, v);
  if (confirm) checkBalances(changes, (id) => items.get(id));
  return { changes, warnings: [...new Set(warnings)], ...checked };
}

/** 确认时按库存品合计：核对后不能负库存、不能超出能保存的数（库存品都是核对时取过的，stockOf 取得到） */
function checkBalances(changes: StockChange[], stockOf: (id: number) => StockItemRow | undefined) {
  const grouped = new Map<number, number>();
  for (const c of changes) if (c.stockId) grouped.set(c.stockId, (grouped.get(c.stockId) || 0) + c.deltaUnits);
  for (const [id, delta] of grouped) {
    const it = stockOf(id);
    if (!it) return fail('库存品不存在，请刷新后重新核对。', 409);
    const after = it.balanceUnits + delta;
    if (after < 0) fail(it.name + '库存不足，不能确认。', 409);
    if (!Number.isSafeInteger(after) || after > MAX_STOCK_UNITS) fail('库存数量超出可保存范围。');
  }
}

/** 生产任务：产品和关联的订单都要在 */
function checkTask(ctx: Check, v: FlowDocument<'task'>) {
  const { flow, maintenance } = ctx;
  if (!flow.store.product(v.productId, maintenance)) fail('产品不存在或已归档。');
  if (new Set(v.orderIds).size !== v.orderIds.length) fail('关联客户订单重复。');
  for (const id of v.orderIds) {
    const order = flow.store.order(id, maintenance);
    if (
      !order ||
      (!maintenance && !deliverableOrder(order)) ||
      !order.lines.some((l) => l.productId === v.productId)
    )
      fail('生产任务只能关联包含当前产品的正常待完成客户订单。');
  }
}

/** 完工挂的生产任务（没挂是 null）：做的是本次完工的产品；不是本机管理员的，任务要已下达、没归档 */
function productionTask(ctx: Check, v: FlowDocument<'production'>) {
  if (!v.taskId) return null;
  const task = taskOf(ctx.flow, v.taskId, '所选的不是生产任务，请重新选择生产任务。');
  // 任务和成品的单位都只有“只”（数据库约束），不用再比。哪里对不上就说哪里，并说下一步
  if (task.productId !== v.productId)
    fail('所选生产任务 ' + task.number + ' 做的是别的产品，和本次完工的产品不同，请重新选择生产任务。');
  if (!ctx.maintenance && (task.status !== 'confirmed' || task.archived)) {
    const state = task.archived ? '已归档' : task.status === 'cancelled' ? '已取消' : '已撤销';
    fail('所选生产任务 ' + task.number + state + '，不能登记完工，请重新选择生产任务。');
  }
  return task;
}

/** 领退料：同一原材料只登记一次，按整张（原材料只有“张”，数据库约束），确认时领料不超过实际库存 */
function checkMaterials(ctx: Check, v: FlowDocument<'production'>) {
  const { confirm, item, change } = ctx;
  if (new Set(v.materials.map((m) => m.stockId)).size !== v.materials.length) fail('同一原材料只能登记一次。');
  for (const m of v.materials) {
    const raw = item(m.stockId, 'raw'),
      issued = quantityUnits(m.issued),
      returned = quantityUnits(m.returned);
    if (issued % UNITS_PER_QUANTITY || returned % UNITS_PER_QUANTITY) fail('领料、退料按整张登记。');
    if (confirm && issued > raw.balanceUnits) fail(raw.name + '库存不足，领料数量超过实际库存。', 409);
    change(raw, -issued, '生产领料');
    if (returned) change(raw, returned, '生产退料');
  }
}

/**
 * 超计划只提示不拦（单张完工的口径）；“已完工”和登记完工窗口一样，算上别的已登记、待核对入库的完工单，不算这张自己。
 * 更正已入库的完工单时，这张自己已经算在任务的已入库里，也扣掉（规则只在这里，界面不再自己扣）
 */
function overPlanWarning(ctx: Check, task: FlowDocView<'task'>, good: number) {
  const { flow, excludingId } = ctx;
  const own = excludingId === undefined ? undefined : storedDocuments(flow.store, [excludingId]).at(0),
    ownDoc = own?.status === 'confirmed' && own.document.kind === 'production' ? own.document : null,
    done = quantityUnits(task.completed) - (ownDoc?.taskId === task.id ? quantityUnits(ownDoc.goodQuantity) : 0),
    waiting = flow.waitingGood([task.id], excludingId).get(task.id) || 0;
  if (done + waiting + good > quantityUnits(task.quantity))
    ctx.warnings.push(
      '本次完工后将超过生产计划数量（生产任务 ' + task.number + ' 计划 ' + task.quantity + ' ' + task.unit +
        '，已核对入库 ' + quantityString(done) + ' ' + task.unit +
        (waiting ? '，另有 ' + quantityString(waiting) + ' ' + task.unit + '已登记、待核对入库' : '') +
        '），请核对实际产量。',
    );
}

/** 完工单：日期、产品和成品库存、生产任务、领退料（整张、不超库存），超计划只提示 */
function checkProduction(ctx: Check, v: FlowDocument<'production'>) {
  const { flow, maintenance, item, change } = ctx;
  // 保存（待入库）和核对入库都拦，和登记完工（batch-completion）同一个 today()、同一句话
  if (v.date > today()) fail('完工日期不能晚于今天。');
  if (!flow.store.product(v.productId, maintenance)) fail('产品不存在或已归档。');
  const finished = item(v.finishedStockId, 'finished');
  if (finished.productId !== v.productId) fail('成品库存品必须关联本次生产产品。');
  const task = productionTask(ctx, v);
  checkMaterials(ctx, v);
  const good = quantityUnits(v.goodQuantity);
  if (!good && !quantityUnits(v.scrapQuantity)) fail('请登记合格成品或报废数量。');
  if (good) change(finished, good, '生产完工入库');
  if (task) overPlanWarning(ctx, task, good);
}
