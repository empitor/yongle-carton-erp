// 只管：records.search、records.summarize 的筛选——能用的筛选键（给模型看的参数结构和执行时的校验同一份），
// 和按筛选条件挑记录：各模块共用的条件读记录上的字段，订单、采购单、单据各自的状态、待办、日期范围用各自的类型。
import { z } from 'zod';
import { type Actor } from '../../core/index.js';
import { ISO_DATE_LENGTH, dateSchema, deliverableOrder, displayOrderStatuses, orderViews, shippingProgresses, stockKinds, type FlowKind } from '../../../shared/core/index.js';
import { SEARCH_MAX_LENGTH, arrivalProgresses, arrivalProgressText, matchesFlowSaying, matchesFlowStatus, orderInRange, orderStatusMatches, pendingPurchase, purchaseBusinessStatuses, purchaseState } from '../../../shared/business/index.js';
import { MONTHS_MAX, fieldList, isFields, positive, type Fields, type ToolContext } from './context.js';
import { stockKindOf } from '../../../shared/assistant/index.js';
import { recordRows, type Module, type ModuleRows } from './modules.js';

/** 状态叫法最多几个字（按单号、名称、规格找的字和列表筛选同一个上限 SEARCH_MAX_LENGTH） */
const STATUS_MAX_CHARS = 40;
/** 查哪些记录：没归档的、已归档的、全部（records.get 也用） */
export const recordLifecycles = ['active', 'archived', 'all'] as const;

/**
 * 查记录、汇总能用的筛选键：给模型看的参数结构和执行时的校验用同一份，写错键时报错里列出能用的，不接受别名。
 * 按单号、名称、规格找都用 q。
 */
const filterShape = {
  q: z.string().max(SEARCH_MAX_LENGTH).optional(),
  customerId: positive.optional(),
  unassigned: z.boolean().optional().describe('产品专用：只看还没定所属客户的产品'),
  supplierId: positive.optional(),
  productId: positive.optional(),
  stockId: positive.optional(),
  status: z
    .string()
    .max(STATUS_MAX_CHARS)
    .optional()
    .describe('状态，用页面上的叫法。订单可选：' + displayOrderStatuses.join('、')),
  businessStatus: z.enum(purchaseBusinessStatuses).optional(),
  arrivalProgress: z.enum(arrivalProgresses).optional(),
  shippingProgress: z.enum(shippingProgresses).optional(),
  pending: z.boolean().optional(),
  start: dateSchema.optional(),
  end: dateSchema.optional(),
  months: z.number().int().min(1).max(MONTHS_MAX).optional(),
  archived: z.boolean().optional(),
  lifecycle: z.enum(recordLifecycles).optional(),
  view: z.enum([...orderViews, 'all']).optional(),
  kind: z.enum(stockKinds).optional(),
  direction: z.enum(['in', 'out']).optional(),
};
export const FILTER_KEYS_HINT = '能用的筛选键：' + Object.keys(filterShape).join('、') + '；按单号、名称、规格找用 q，日期用 start、end。';
export const filterSchema = z.strictObject(filterShape, {
  error: (issue) =>
    issue.code === 'unrecognized_keys' ? '筛选条件里没有“' + issue.keys.join('、') + '”。' + FILTER_KEYS_HINT : undefined,
});
export type RecordFilters = z.output<typeof filterSchema>;

/** 各模块共用的条件按字段名读记录（Fields：模块不同，字段不同） */
const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** 各模块的判断：状态合不合（没给状态的不看它）、待办（null 用通用的）、日期范围（null 用通用的） */
type Specific = { status: boolean; pending: boolean | null; inView: boolean | null };
/** 通用的状态比法：记录上的状态、发货进度、到货进度、采购业务状态有一个是这个字就算 */
const statusFields = (r: Fields, status: string) =>
  r.status === status || r.shippingProgress === status || r.arrivalProgress === status || r.businessStatus === status;
const generic = (r: Fields, f: RecordFilters): Specific => ({ status: !!f.status && statusFields(r, f.status), pending: null, inView: null });
/** 筛选的现场：模块、筛选条件、按所属产品或采购单关联出来的库存品编号（没有是 null） */
export type FilterScope = { module: Module; f: RecordFilters; partyIds: Set<number> | null };

const isInventory = (module: Module) => !!stockKindOf(module);

/** 按单号、名称、规格找：这些字段和明细里的品名、规格、备注拼起来，含这个字就算 */
function textMatch(r: Fields, q: string) {
  if (!q) return true;
  const lines = fieldList(r.lines).map((l) => {
    const item = isFields(l.item) ? l.item : undefined;
    return [l.productName, l.name, l.specification, l.notes, item?.name, item?.specification, item?.material, item?.flute].join(' ');
  });
  const fields = [r.name, r.productName, r.itemName, r.itemSpecification, r.purchaseNumber, r.customerOrderNumber, r.flowNumber, r.actor_name];
  return [...fields, r.number, r.customerName, r.supplierName, r.notes, r.specification, r.material, r.flute, ...lines]
    .join(' ')
    .toLowerCase()
    .includes(q);
}
/** 客户、供应商：库存品按所属产品或采购单关联出来，别的看记录上的编号；产品支持 unassigned=true 只看没定客户的 */
function partyMatch(r: Fields, s: FilterScope) {
  const { f, partyIds, module } = s;
  if (partyIds) return partyIds.has(Number(r.id));
  if (module === 'products' && f.unassigned && r.customerId != null) return false;
  const customerIds = Array.isArray(r.customerIds) ? r.customerIds : [];
  return (
    (!f.customerId || r.customerId === f.customerId || customerIds.includes(f.customerId)) &&
    (!f.supplierId || r.supplierId === f.supplierId)
  );
}
function stockMatch(r: Fields, s: FilterScope) {
  const { f, module } = s;
  if (!f.stockId) return true;
  if (isInventory(module)) return r.id === f.stockId;
  if (module === 'movements') return Number(r.item_id) === f.stockId;
  return (
    r.finishedStockId === f.stockId ||
    fieldList(r.lines).some((l) => l.stockId === f.stockId) ||
    fieldList(r.materials).some((m) => m.stockId === f.stockId)
  );
}
const statusMatch = (f: RecordFilters, specific: Specific) => !f.status || specific.status;
function pendingMatch(r: Fields, f: RecordFilters, specific: Specific) {
  if (!f.pending) return true;
  if (specific.pending !== null) return specific.pending;
  return r.status === 'draft' || (r.status === 'confirmed' && r.kind === 'task' && Number(r.completed || 0) < Number(r.quantity));
}
/** 日期范围：库存余额不受日期筛选；订单按它自己的视图，别的按单据日期或创建日期 */
function dateMatch(r: Fields, s: FilterScope, specific: Specific) {
  if (isInventory(s.module)) return true;
  if (specific.inView !== null) return specific.inView;
  const { f } = s,
    date = text(r.orderDate) || text(r.date) || String(r.createdAt || '').slice(0, ISO_DATE_LENGTH);
  return (!f.start || date >= f.start) && (!f.end || date <= f.end);
}
function fieldMatch(r: Fields, f: RecordFilters) {
  return (
    (!f.businessStatus || r.businessStatus === f.businessStatus) &&
    (!f.arrivalProgress || r.arrivalProgress === f.arrivalProgress) &&
    (!f.shippingProgress || r.shippingProgress === f.shippingProgress) &&
    (f.lifecycle !== 'archived' || !!r.archived) &&
    (f.lifecycle !== 'active' || !r.archived) &&
    (!f.kind || r.kind === f.kind) &&
    (!f.direction || (f.direction === 'in' ? Number(r.delta_units) > 0 : Number(r.delta_units) < 0)) &&
    (!f.productId || r.productId === f.productId || fieldList(r.lines).some((l) => l.productId === f.productId))
  );
}
function rowMatches(r: Fields, s: FilterScope, specific: Specific) {
  return (
    fieldMatch(r, s.f) &&
    textMatch(r, (s.f.q || '').toLowerCase()) &&
    partyMatch(r, s) &&
    stockMatch(r, s) &&
    statusMatch(s.f, specific) &&
    pendingMatch(r, s.f, specific) &&
    dateMatch(r, s, specific)
  );
}

/**
 * 订单：状态和范围的判断和页面订单列表同一份（shared/business/order-filter.ts），状态只认页面上的叫法
 * （records-read.ts 先核对过）；待办是还能送的订单
 */
function orderSpecific(r: ModuleRows['orders'][number], f: RecordFilters): Specific {
  return {
    status: orderStatusMatches(r, f.status),
    pending: deliverableOrder(r),
    inView: orderInRange(r, {
      view: f.view === 'all' ? undefined : f.view,
      start: f.start,
      end: f.end,
      retainPending: !!f.months && f.view === 'current',
    }),
  };
}
/** 采购单：页面上的叫法（待到货 / 已到齐），到货进度也认页面叫法 */
function purchaseSpecific(r: ModuleRows['purchases'][number], f: RecordFilters): Specific {
  return {
    status: !!f.status && (statusFields(r, f.status) || purchaseState(r) === f.status || arrivalProgressText(r.arrivalProgress) === f.status),
    pending: pendingPurchase(r),
    inView: null,
  };
}
/**
 * 单据：界面叫法（和列表的状态筛选同一个比法）；人说的旧叫法（已确认收货、已冲销这类）按存的状态认
 * （shared/business/physical-flow.ts 的 matchesFlowSaying），界面上不再显示这些词
 */
function flowSpecific(r: Parameters<typeof matchesFlowStatus>[0] & Fields, kind: FlowKind, f: RecordFilters): Specific {
  const wanted = f.status;
  if (!wanted) return generic(r, f);
  return { ...generic(r, f), status: statusFields(r, wanted) || (matchesFlowSaying(r, kind, wanted) ?? matchesFlowStatus(r, kind, wanted)) };
}

/** 筛出来的记录，带着模块（汇总按模块用各自的类型） */
export type MatchedRows = { [M in Module]: { module: M; rows: ModuleRows[M] } }[Module];
/** 按筛选条件挑记录：读这个模块的全部记录，逐条按共用条件和模块自己的判断筛 */
export function matchingRows(ctx: ToolContext, actor: Actor, archived: boolean, s: FilterScope): MatchedRows {
  const pick = <R extends Fields>(rows: R[], specific: (r: R) => Specific) => rows.filter((r) => rowMatches(r, s, specific(r)));
  const { module, f } = s;
  const plain = (r: Fields) => generic(r, f);
  switch (module) {
    case 'orders':
      return { module, rows: pick(recordRows(ctx, module, actor, archived), (r) => orderSpecific(r, f)) };
    case 'purchases':
      return { module, rows: pick(recordRows(ctx, module, actor, archived), (r) => purchaseSpecific(r, f)) };
    case 'arrivals':
      return { module, rows: pick(recordRows(ctx, module, actor, archived), (r) => flowSpecific(r, 'arrival', f)) };
    case 'production_tasks':
      return { module, rows: pick(recordRows(ctx, module, actor, archived), (r) => flowSpecific(r, 'task', f)) };
    case 'production_records':
      return { module, rows: pick(recordRows(ctx, module, actor, archived), (r) => flowSpecific(r, 'production', f)) };
    case 'deliveries':
      return { module, rows: pick(recordRows(ctx, module, actor, archived), (r) => flowSpecific(r, 'delivery', f)) };
    case 'customers':
      return { module, rows: pick(recordRows(ctx, module, actor, archived), plain) };
    case 'products':
      return { module, rows: pick(recordRows(ctx, module, actor, archived), plain) };
    case 'suppliers':
      return { module, rows: pick(recordRows(ctx, module, actor, archived), plain) };
    case 'raw_inventory':
      return { module, rows: pick(recordRows(ctx, module, actor, archived), plain) };
    case 'finished_inventory':
      return { module, rows: pick(recordRows(ctx, module, actor, archived), plain) };
    case 'movements':
      return { module, rows: pick(recordRows(ctx, module, actor, archived), plain) };
  }
}
