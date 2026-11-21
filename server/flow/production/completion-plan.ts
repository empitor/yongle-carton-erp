import { z } from 'zod';
import { AppError, many, rows } from '../../core/index.js';
import { productionCompletionSchema, taskLeftUnits, type FlowDocView } from '../../../shared/business/index.js';
import { UNITS_PER_QUANTITY, quantityUnits, quantityString } from '../../../shared/core/index.js';
import { purchaseOrderLinks } from '../../operations/index.js';
import type { FlowCommands } from '../documents/base.js';
import { StockViews } from '../stock/stock-views.js';

/*
 * 批量登记完工的方案（只读，不写库）：核对用户已确认的事实、选出本批生产任务、算每张任务的合格和废品、
 * 把声明的原料对应到库存品、按任务分配领退料。batch-completion.ts 按这份方案逐张保存、核对入库。
 */

export type CompletionInput = z.output<typeof productionCompletionSchema>;
/** requireFacts：助手登记时完工日期和每个任务的实际产量都必须是用户说的，不按今天、剩余任务量默认。 */
export type CompletionOptions = { requireFacts?: boolean };
type Task = FlowDocView<'task'>;
/** 分到一张完工单上的一种领料（数量文字） */
type MaterialShare = { stockId: number; issued: string; returned: string };
/** 本批的一行：挂的生产任务（不挂任务的打样、补做是 null）、产品、这次的合格和废品（千分整数）、分到的领退料 */
export type CompletionRow = { task: Task | null; productId: number; good: number; scrap: number; materials: MaterialShare[] };
/** 分领料只看的几项：挂的任务、合格和废品、分到的领退料 */
type AllocationRow = { task: { id: number } | null; good: number; scrap: number; materials: MaterialShare[] };

/** 良品率按实际产量算到几位小数 */
const RATE_DECIMALS = 4;
/** 给的良品率和按实际产量算的差在这以内（百分点）算对得上 */
const RATE_TOLERANCE = 0.01;

/** 助手登记：完工日期要用用户说的，不默认今天（每个任务的产量在 taskRows 里查） */
export function checkFacts(options: CompletionOptions, v: CompletionInput) {
  if (options.requireFacts && !v.date)
    throw new AppError(
      '实际完工日期要用用户说的日期（说“今天”就传今天的日期）；用户没说就先问，不默认今天。',
    );
}
/** 本批要读的任务编号：“全部待完工”先在 SQL 里按状态筛出编号，指定的就是给的编号；都没有是只登记不挂任务的完工 */
function taskScope(flow: FlowCommands, v: CompletionInput): readonly number[] | null {
  if (v.allActive)
    return many(flow.store.db, rows.flow_documents.pick({ id: true }), "SELECT id FROM flow_documents WHERE kind='task' AND status='confirmed'").map(
      (r) => r.id,
    );
  return v.taskIds?.length ? v.taskIds : null;
}
/** 本批的生产任务：指定的按编号读，“全部待完工”读还有剩余量的 */
export function pickTasks(flow: FlowCommands, v: CompletionInput): Task[] {
  const scope = taskScope(flow, v);
  // 只登记不挂任务的完工：没有任务要读
  if (!scope) {
    if (v.quantities?.length) throw new AppError('实际产量必须逐项对应本批任务。');
    return [];
  }
  // list 按编号读时归档过滤、排序（日期、编号倒序）和视图都和全量列表一样，不存在、已归档、不是生产任务的编号读不到。
  const found = flow.list('task', false, undefined, scope),
    byId = new Map(found.map((t) => [t.id, t])),
    // 剩余量和登记完工窗口同一个算法（shared/business/task-progress.ts）：直接入库和只登记同一个口径，
    // 同一任务不能反复登记全部剩余量
    picked = v.allActive
      ? found.filter((t) => t.status === 'confirmed' && taskLeftUnits(t) > 0)
      : scope.map((id) => byId.get(id));
  const tasks = checkedTasks(v, found, picked);
  if (
    v.quantities?.some((q) => !tasks.some((t) => t.id === q.taskId)) ||
    new Set(v.quantities?.map((q) => q.taskId)).size !== (v.quantities?.length || 0)
  )
    throw new AppError('实际产量必须逐项对应本批任务。');
  return tasks;
}
/** 选出的任务都要读得到、已下达、没做完、还有没登记的剩余量，不重复 */
function checkedTasks(v: CompletionInput, found: Task[], picked: (Task | undefined)[]): Task[] {
  // “全部待完工”剩下的都已登记成待入库：说清楚在等核对入库，不说成没有任务
  if (v.allActive && !picked.length && found.some((t) => t.status === 'confirmed' && quantityUnits(t.completed) < quantityUnits(t.quantity)))
    throw new AppError('没做完的生产任务剩下的数量都已经登记过完工，在等核对入库；请先到完工记录里核对入库，不要重复登记。', 409);
  if (
    !picked.length ||
    picked.some(
      (t) =>
        !t ||
        t.status !== 'confirmed' ||
        quantityUnits(t.completed) >= quantityUnits(t.quantity),
    )
  )
    throw new AppError('所选生产任务不存在、已完工或不可执行，请重新查询。', 409);
  // 上面已经拦下读不到的编号，这里只剩读到的任务
  const tasks = picked.filter((t) => t !== undefined);
  const full = tasks.find((t) => taskLeftUnits(t) <= 0);
  if (full)
    throw new AppError(
      '生产任务 ' + full.number + ' 剩下的数量已经登记过完工，在等核对入库；请先到完工记录里核对入库，不要重复登记。',
      409,
    );
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length)
    throw new AppError('生产任务重复。');
  return tasks;
}
/** 实际良品、废品数和良品率要对得上；100% 良品就不能有废品。挂任务和不挂任务的行同一个规则 */
function checkRate(rate: number | undefined, good: number, scrap: number) {
  if (rate !== undefined) {
    const total = good + scrap,
      actual = total ? Number(((good * 100) / total).toFixed(RATE_DECIMALS)) : 100;
    if (Math.abs(actual - rate) > RATE_TOLERANCE)
      throw new AppError(`良品率与实际良品/废品数量不一致（按实际产量为${actual.toFixed(2)}%），请核对。`, 409);
  }
  if (rate === 100 && scrap !== 0) throw new AppError('100%良品与非零废品数量矛盾，请核对实际产量。', 409);
}
/** 不挂任务的完工（打样、补做）：合格要大于 0，良品率给了要对得上；领料先留空 */
function untaskedRows(v: CompletionInput): CompletionRow[] {
  return (v.untasked || []).map((u) => {
    const good = quantityUnits(u.goodQuantity),
      scrap = quantityUnits(u.scrapQuantity);
    checkRate(v.goodRatePct, good, scrap);
    if (!good) throw new AppError('不挂任务的完工合格数要大于 0。', 409);
    return { task: null, productId: u.productId, good, scrap, materials: [] };
  });
}
/** 一张任务这次的合格、废品数（没给实际产量的按剩余量、100% 良品）；领料先留空 */
function taskRow(options: CompletionOptions, v: CompletionInput, task: Task): CompletionRow {
  const q = v.quantities?.find((q) => q.taskId === task.id),
    remaining = taskLeftUnits(task);
  if (options.requireFacts && !q)
    throw new AppError(
      '生产任务 ' +
        task.number +
        ' 缺少实际良品和废品数量：用户没说就先问，不按剩余任务量默认全部良品。',
      409,
    );
  // 人工批量完工：未传良品率且未传实际产量时按100%处理；不能把缺省值当成“非100%”拒绝。
  // 助手登记（requireFacts）走到这里时一定有实际产量。
  const rate = v.goodRatePct ?? (q ? undefined : 100);
  if (!q && rate !== 100)
    throw new AppError(
      '良品率不是100%时，须提供实际良品、废品数量，不能猜测投入量和舍入。',
      409,
    );
  const good = q ? quantityUnits(q.goodQuantity) : remaining,
    scrap = q ? quantityUnits(q.scrapQuantity) : 0;
  checkRate(q ? v.goodRatePct : rate, good, scrap);
  // 和登记完工窗口同一套叫法：合格、还差（还差已扣掉已登记、待核对入库的）
  if (!good) throw new AppError('生产任务 ' + task.number + ' 的合格数要大于 0，请核对实际产量。', 409);
  if (good > remaining)
    throw new AppError(
      '生产任务 ' + task.number + ' 的合格数不能超过还差的 ' + quantityString(remaining) + ' ' + task.unit +
        (quantityUnits(task.pendingCompleted || '0')
          ? '（已扣掉已登记、待核对入库的 ' + task.pendingCompleted + ' ' + task.unit + '）'
          : '') +
        '，请核对实际产量。',
      409,
    );
  return { task, productId: task.productId, good, scrap, materials: [] };
}
/** 每张任务这次的合格、废品数，加上不挂任务的几行；领料先留空 */
export function taskRows(options: CompletionOptions, v: CompletionInput, tasks: readonly Task[]): CompletionRow[] {
  return [...tasks.map((task) => taskRow(options, v, task)), ...untaskedRows(v)];
}
/**
 * 关联这批任务订单的采购单（采购单头或明细关联的订单，同 purchases().orderIds 的口径），和这些采购单上的库存品。
 * 只读用得到的采购单，一次查完；归档的照样不读，和全量列表同一口径。
 */
function linkedStock(flow: FlowCommands, tasks: readonly Task[]) {
  const orderIds = new Set(tasks.flatMap((t) => t.orderIds));
  const purchases = new StockViews(flow.store).purchases(
    false,
    many(
      flow.store.db,
      z.object({ id: rows.purchases.shape.id }),
      'SELECT DISTINCT purchase_id AS id FROM (' + purchaseOrderLinks + ') WHERE order_id IN (SELECT value FROM json_each(?))',
      JSON.stringify([...orderIds]),
    ).map((r) => r.id),
  );
  return new Set(
    purchases.filter((p) => p.orderIds.some((id) => orderIds.has(id))).flatMap((p) => p.lines.map((l) => l.stockItemId)),
  );
}
/** 声明的原料对应到库存品（没指定的按这批任务订单的采购明细唯一对应），核对整张、退料不超领料、直接入库时库存够 */
export function matchMaterials(flow: FlowCommands, v: CompletionInput, tasks: readonly Task[], pending: boolean) {
  // 生产任务单位都只有“只”（数据库约束），按比例分摊共享原料不会混单位
  // 库存品只读声明的原料、关联采购明细上的，一次查完。
  // 成品库存不在这里读：一个产品只有一个，登记每张任务时按产品对应（OperationsService.finishedStockFor）。
  const linked = linkedStock(flow, tasks);
  const items = flow.ops.items(false, [
    ...new Set<number>(
      [...v.materials.map((m) => m.stockId), ...linked].filter((id): id is number => id != null),
    ),
  ]);
  const materials = v.materials.map((m) => {
    const matches = items.filter(
      (i) =>
        i.kind === 'raw' &&
        i.unit === m.unit &&
        (m.stockId ? i.id === m.stockId : linked.has(i.id)),
    );
    if (matches.length !== 1)
      throw new AppError(
        '原料未唯一匹配，请查询关联采购及规格；存在多种原料时才需要选择。',
        409,
      );
    const issued = quantityUnits(m.issued),
      returned = quantityUnits(m.returned);
    if (issued % UNITS_PER_QUANTITY || returned % UNITS_PER_QUANTITY || returned > issued)
      throw new AppError('生产领退料须整张，退料不得超过领料。');
    // 库存够不够和单张完工同一个规则：核对入库（扣库存）时才拦；只登记成待入库时不拦，核对入库时再拦
    if (!pending && issued > flow.ops.balance(matches[0].id))
      throw new AppError('原料库存不足，整批未提交。', 409);
    return { stockId: matches[0].id, issued, returned };
  });
  if (new Set(materials.map((m) => m.stockId)).size !== materials.length)
    throw new AppError('同一原料不能重复声明。');
  return materials;
}
/** 整批的一种原料（千分整数） */
type BatchMaterial = ReturnType<typeof matchMaterials>[number];
/** 逐任务给定的领料照用：每张任务都要有、不重复（有不挂任务的行不能逐任务给） */
function explicitShares(v: CompletionInput, rows: AllocationRow[]) {
  if (rows.some((r) => !r.task))
    throw new AppError('有不挂任务的完工时，领料按产量比例分（allocation 用 shared-proportional）。');
  if (
    v.distribution?.length !== rows.length ||
    new Set(v.distribution.map((d) => d.taskId)).size !== rows.length
  )
    throw new AppError('逐任务分配必须完整且不重复。');
  for (const row of rows) {
    const d = v.distribution.find((d) => d.taskId === row.task?.id);
    if (!d) throw new AppError('缺少任务原料分配。');
    row.materials = d.materials;
  }
}
/** 一种原料的整张数按各行产量（合格加废品）比例分：最大余数法，合计不变 */
function proportional(rows: AllocationRow[], total: bigint, units: number) {
  const sheets = BigInt(units / UNITS_PER_QUANTITY),
    parts = rows.map((r, index) => {
      const value = sheets * (BigInt(r.good) + BigInt(r.scrap));
      return { index, n: value / total, remainder: value % total };
    });
  let left = sheets - parts.reduce((n, p) => n + p.n, 0n);
  for (const p of [...parts].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  )) {
    if (left-- <= 0n) break;
    p.n++;
  }
  return parts.map((p) => Number(p.n) * UNITS_PER_QUANTITY);
}
/** 用户明确整批实际领用量时，按产量比例、最大余数法分配整张；保留整批总量，不逐型号向上取整。 */
function proportionalShares(rows: AllocationRow[], materials: BatchMaterial[]) {
  const total = rows.reduce((n, r) => n + (BigInt(r.good) + BigInt(r.scrap)), 0n);
  for (const material of materials) {
    const net = proportional(rows, total, material.issued - material.returned),
      returned = proportional(rows, total, material.returned);
    rows.forEach((r, i) => {
      if (net[i] + returned[i] > 0)
        r.materials.push({
          stockId: material.stockId,
          issued: quantityString(net[i] + returned[i]),
          returned: quantityString(returned[i]),
        });
    });
  }
}
/** 分完核对：每种原料各行的领、退合计等于整批，每张完工单至少一项实际领料 */
function checkShares(rows: AllocationRow[], materials: BatchMaterial[]) {
  for (const material of materials)
    for (const field of ['issued', 'returned'] as const) {
      const sum = rows.reduce(
        (n, r) =>
          n +
          r.materials
            .filter((m) => m.stockId === material.stockId)
            .reduce((n, m) => n + quantityUnits(m[field]), 0),
        0,
      );
      if (sum !== material[field])
        throw new AppError('逐任务领退料总数与整批实际数量不一致。', 409);
    }
  if (
    rows.some(
      (r) =>
        !r.materials.length ||
        r.materials.some((m) => !materials.some((x) => x.stockId === m.stockId)),
    )
  )
    throw new AppError(
      '分配须对应实际原料，每张完工单至少一项实际领料；请提供实际共享领料归属。',
      409,
    );
}
/** 原料分到每张任务：逐任务给定的照用，否则按产量比例用最大余数法分整张；分完核对总数 */
export function allocate(v: CompletionInput, rows: AllocationRow[], materials: BatchMaterial[]) {
  if (v.allocation === 'explicit') explicitShares(v, rows);
  else proportionalShares(rows, materials);
  checkShares(rows, materials);
}
