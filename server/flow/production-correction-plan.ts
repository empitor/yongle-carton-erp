import type { z } from 'zod';
import type { Actor } from '../core/index.js';
import { AppError, isLocalAdministrator, requireSuperModeFor } from '../core/index.js';
import {
  correctionCommit,
  flowDocNames,
  productionCorrectionExtraSchema,
  productionCorrectionPreviewSchema,
  type productionCorrectionViewSchema,
  type CorrectionDetail,
  type FlowDocument,
  type FlowDocView,
} from '../../shared/business/index.js';
import { FINISHED_UNIT, quantityString, quantityUnits } from '../../shared/core/index.js';
import { fail, taskOf, type FlowCommands } from './base.js';
import { commitInput, type CorrectionContext, type CorrectionKind } from './correction-movements.js';
import { touchFlowDocument } from './document-store.js';
import { updateOrders } from './order-progress.js';
import { documentInput, validateFlow } from './validate.js';

/*
 * 更正完工单（更正的核心在 correction.ts）：已入库的完工单合格数、报废数、领料登记错了。
 * 和“撤销这次完工”同一级，要超级管理员模式；本机管理员另能改完工日期、产品（换成品库存）、挂哪张生产任务。
 * 撤销按整批扣回成品，货已经发出去一部分时撤不了；更正按净变化扣，替代单接手原单的成品批次（stock-batches 规则 1）。
 */
type Input = z.infer<typeof productionCorrectionPreviewSchema>;
type Stored = FlowDocument<'production'>;
/** 一行领料的数量：领用、退料 */
type Issue = Pick<Stored['materials'][number], 'issued' | 'returned'>;
/** 更正后的一行领料：沿用原单第几行（新加的是 null）、哪种纸板、领用、退料 */
type MaterialRow = Issue & { index: number | null; stockId: number };
/** 预览里完工自己的内容（结构在 shared/business/flow-correction-views.ts） */
type View = CorrectionDetail<z.output<typeof productionCorrectionViewSchema>>;

const units = (v: unknown) => quantityUnits(String(v ?? '0'));
const text = (n: number) => quantityString(n);

/** 原完工单按内容应有的库存变化：成品入合格数，每种纸板领 − 退，按库存品合计 */
function stocked(stored: FlowDocument<'production'>) {
  const m = new Map<number, number>(),
    add = (id: number, n: number) => m.set(id, (m.get(id) || 0) + n);
  // 没记成品库存的完工单（不会有，核对入库时就拦了）不算成品这一项，和流水对账时照样对不上
  if (units(stored.goodQuantity) && stored.finishedStockId !== null) add(stored.finishedStockId, units(stored.goodQuantity));
  for (const r of stored.materials || []) add(r.stockId, units(r.returned) - units(r.issued));
  return m;
}

/** 更正后的整张领料表：不给 materials 就沿用原单；带 index 的沿用原单那一行（没写的退料、纸板照旧），不带的是新加的 */
function replacementMaterials(stored: Stored, input: Input): { rows: MaterialRow[]; used: Set<number> } {
  const used = new Set<number>();
  if (!input.materials) {
    stored.materials.forEach((_m, i) => used.add(i));
    return { rows: stored.materials.map((m, index) => ({ index, stockId: m.stockId, issued: m.issued, returned: m.returned })), used };
  }
  const rows = input.materials.map((m) => {
    if (m.index === undefined) {
      if (!m.stockId) return fail('新加的领料行要选纸板。');
      return { index: null, stockId: m.stockId, issued: m.issued, returned: m.returned ?? '0' };
    }
    const base = stored.materials.at(m.index);
    if (!base) return fail('更正明细和原完工单对不上，请刷新后重填。', 409);
    if (used.has(m.index)) fail('更正明细重复。');
    used.add(m.index);
    return { index: m.index, stockId: m.stockId ?? base.stockId, issued: m.issued, returned: m.returned ?? base.returned };
  });
  return { rows, used };
}

const sameMaterials = (a: readonly MaterialRow[], b: Stored['materials']) =>
  a.length === b.length &&
  a.every((m, i) => m.stockId === b[i].stockId && units(m.issued) === units(b[i].issued) && units(m.returned) === units(b[i].returned));

/** 改完工日期、产品、生产任务要本机管理员（taskId 写 null 是不挂任务） */
function headerOf(original: FlowDocView<'production'>, stored: Stored, input: Input, actor: Actor) {
  const head = {
    date: input.date ?? original.date,
    productId: input.productId ?? stored.productId,
    taskId: input.taskId === undefined ? (stored.taskId ?? null) : input.taskId,
  };
  const changed = head.date !== original.date || head.productId !== stored.productId || head.taskId !== (stored.taskId ?? null);
  if (changed && !isLocalAdministrator(actor))
    throw new AppError('超级管理员模式下能改合格数、报废数和领料；改完工日期、产品、生产任务要本机管理员来做。', 403, 'permission');
  return { ...head, changed };
}

/** 换上的纸板要没归档；换挂的生产任务要已下达、没归档（产品对不上由单据核对说） */
function checkNewLinks(flow: FlowCommands, stored: Stored, document: Stored, taskId: number | null) {
  const keptStock = new Set(stored.materials.map((m) => m.stockId)),
    newStock = [...new Set(document.materials.map((m) => m.stockId).filter((id) => !keptStock.has(id)))];
  if (flow.ops.repo.items(false, newStock).length !== newStock.length) fail('换上的纸板库存品已归档或不存在，请选正常的原材料库存品。');
  if (!taskId || taskId === stored.taskId) return;
  const task = flow.get(taskId);
  if (task.kind !== 'task' || task.status !== 'confirmed' || task.archived) fail('换挂的生产任务要是已下达、没归档的。');
}

/** 生产任务的已入库：现在的（含原单）− 原单合格数 + 替代单合格数；原任务、新任务各一条 */
function taskImpactOf(flow: FlowCommands, stored: Stored, taskId: number | null, good: string) {
  const ids = [...new Set([stored.taskId, taskId].filter((id): id is number => id != null))];
  return ids.map((id) => {
    const t = taskOf(flow, id),
      after = units(t.completed) - (id === stored.taskId ? units(stored.goodQuantity) : 0) + (id === taskId ? units(good) : 0);
    return { id, number: t.number, unit: t.unit, planned: t.quantity, before: t.completed, after: text(after) };
  });
}

/** 预览里每种纸板领用、退料的前后；删掉的原单领料行更正后是 0 */
function materialView(flow: FlowCommands, stored: Stored, materials: ReturnType<typeof replacementMaterials>) {
  const items = new Map(
    flow.ops.repo.items(true, [...new Set([...stored.materials, ...materials.rows].map((m) => m.stockId))]).map((i) => [i.id, i]),
  );
  const row = (index: number | null, stockId: number, before: Issue | undefined, after: Issue) => ({
    index,
    stockId,
    name: items.get(stockId)?.name ?? '',
    unit: items.get(stockId)?.unit ?? '',
    issued: { before: before ? text(units(before.issued)) : null, after: text(units(after.issued)) },
    returned: { before: before ? text(units(before.returned)) : null, after: text(units(after.returned)) },
  });
  return [
    ...materials.rows.map((m) => row(m.index, m.stockId, m.index === null ? undefined : stored.materials.at(m.index), m)),
    ...stored.materials.flatMap((m, index) => (materials.used.has(index) ? [] : [row(index, m.stockId, m, { issued: '0', returned: '0' })])),
  ];
}

function plan(flow: FlowCommands, original: FlowDocView<'production'>, stored: Stored, input: Input, actor: Actor) {
  const head = headerOf(original, stored, input, actor),
    good = input.goodQuantity ?? stored.goodQuantity,
    scrap = input.scrapQuantity ?? stored.scrapQuantity ?? '0';
  if (!units(good) && !units(scrap)) fail('合格、报废都是 0，等于这次完工没有发生，请改用“撤销这次完工”。', 409);
  const materials = replacementMaterials(stored, input);
  const same = units(good) === units(stored.goodQuantity) && units(scrap) === units(stored.scrapQuantity) && sameMaterials(materials.rows, stored.materials);
  if (!head.changed && same) fail('更正内容和原完工单一样，不用提交。');
  const document = documentInput('production', {
    date: head.date,
    notes: stored.notes ?? '',
    taskId: head.taskId,
    productId: head.productId,
    finishedStockId: head.productId === stored.productId ? stored.finishedStockId : null,
    goodQuantity: good,
    scrapQuantity: scrap,
    operator: stored.operator,
    materials: materials.rows.map(({ stockId, issued, returned }) => ({ stockId, issued, returned })),
  });
  // 换了产品就换成品库存（没有就建、归档了就恢复；预览在预演里做，做完撤回）
  if (head.productId !== stored.productId) document.finishedStockId = flow.finishedStockOf(document, actor, '完工单 ' + original.number);
  // 按入库的规则校验（产品、成品、任务、领退料整张）；沿用的产品、纸板、任务后来归档了也照样能更正
  const checked = validateFlow(flow, document, actor, false, { excludingId: original.id, maintenance: true });
  checkNewLinks(flow, stored, document, head.taskId);
  const taskImpact = taskImpactOf(flow, stored, head.taskId, good);
  const productName = (id: number) => flow.store.product(id, true)?.name ?? '';
  const view: View = {
    original,
    unit: FINISHED_UNIT,
    date: { before: original.date, after: head.date },
    product: { before: { id: stored.productId, name: productName(stored.productId) }, after: { id: head.productId, name: productName(head.productId) } },
    good: { before: text(units(stored.goodQuantity)), after: text(units(good)) },
    scrap: { before: text(units(stored.scrapQuantity)), after: text(units(scrap)) },
    materials: materialView(flow, stored, materials),
    taskImpact,
  };
  return {
    document,
    date: head.date,
    changes: checked.changes,
    warnings: checked.warnings,
    view,
    digest: { taskImpact, finishedStockId: document.finishedStockId },
    data: { taskIds: taskImpact.map((t) => t.id), taskImpact },
  };
}

type ProductionPlan = ReturnType<typeof plan>;

/** 摘要里一种纸板的领用前后（退料有过或有了才说退料） */
function materialText(m: View['materials'][number]) {
  const returnedBefore = m.returned.before ?? '0',
    returned = m.returned.after !== '0' || returnedBefore !== '0' ? '，退料 ' + returnedBefore + ' → ' + m.returned.after + ' ' + m.unit : '';
  return m.name + ' 领用 ' + (m.issued.before ?? '0') + ' → ' + m.issued.after + ' ' + m.unit + returned;
}

function finish(ctx: CorrectionContext<'production', ProductionPlan['view'], ProductionPlan['data']>) {
  const { flow, plan, at } = ctx,
    { taskIds, taskImpact } = plan.data;
  for (const id of taskIds) touchFlowDocument(flow.store, id, at);
  updateOrders(flow, taskIds.flatMap((id) => taskOf(flow, id).orderIds || []));
  // 读回核验：生产任务的已入库要和预览说的一样
  if (taskImpact.some((t) => taskOf(flow, t.id).completed !== t.after))
    throw new AppError('更正后生产任务已入库数量核验不一致，事务已回滚。', 409);
  const v = plan.view,
    unit = v.unit;
  const parts = [
    ...(v.good.before !== v.good.after ? ['合格 ' + v.good.before + ' ' + unit + ' → ' + v.good.after + ' ' + unit] : []),
    ...(v.scrap.before !== v.scrap.after ? ['报废 ' + v.scrap.before + ' ' + unit + ' → ' + v.scrap.after + ' ' + unit] : []),
    ...v.materials.filter((m) => m.issued.before !== m.issued.after || m.returned.before !== m.returned.after).map(materialText),
    ...(v.date.before !== v.date.after ? ['完工日期 ' + v.date.before + ' → ' + v.date.after] : []),
    ...(v.product.before.id !== v.product.after.id ? ['产品 ' + v.product.before.name + ' → ' + v.product.after.name] : []),
    ...plan.stockImpact.filter((s) => s.deltaUnits).map((s) => s.name + '库存净变化 ' + s.delta + ' ' + s.unit + '，现有 ' + s.after + ' ' + s.unit),
    ...taskImpact.map((t) => '生产任务 ' + t.number + ' 已入库 ' + t.after + ' / ' + t.planned + ' ' + t.unit),
  ];
  return { summary: parts.join('；') + '。', result: { taskImpact } };
}

/** 提交结果里完工多带的（结构在 shared/business/flow-correction-views.ts，同一请求号重发时按它读回）：生产任务的已入库前后 */
type ProductionResult = z.output<typeof productionCorrectionExtraSchema>;

export const productionCorrection: CorrectionKind<'production', Input, ProductionPlan['view'], ProductionPlan['data'], ProductionResult> = {
  kind: 'production',
  name: flowDocNames.production,
  effective: '已入库完工单',
  schema: productionCorrectionPreviewSchema,
  commit: commitInput(correctionCommit(productionCorrectionPreviewSchema)),
  result: productionCorrectionExtraSchema,
  // 和“撤销这次完工”同一级；进不了模式的账号直接说没有权限
  allow: (actor) => void requireSuperModeFor(actor, '更正完工'),
  stocked,
  plan,
  // 确认人、确认时间沿用原单；产品名跟着（换了的）产品走。操作人、批次备注已经在替代单内容里
  inherit: (flow, stored, plan) => ({
    productName: flow.store.product(plan.document.productId, true)?.name,
    confirmedBy: stored.confirmedBy,
    confirmedAt: stored.confirmedAt,
  }),
  finish,
};
