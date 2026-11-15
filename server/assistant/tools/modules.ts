// 只管：按业务模块读记录——助手能读写的模块名单、中文名、模块对应的单据种类，
// 取列表 recordRows、按编号取一条 recordRow、记录在页面上的链接 recordLink。
import { z } from 'zod';
import type { Actor } from '../../core/index.js';
import { flowKinds, type FlowDocView, type FlowKind, type StockItemView } from '../../../shared/business/index.js';
import { businessList, businessRecords } from '../../business/index.js';
import { requireActor, type ToolContext } from './context.js';

export const assistantModules = [
  'customers',
  'products',
  'orders',
  'suppliers',
  'purchases',
  'raw_inventory',
  'finished_inventory',
  'arrivals',
  'production_tasks',
  'production_records',
  'deliveries',
  'movements',
] as const;
export type Module = (typeof assistantModules)[number];
export const moduleNames: Record<Module, string> = {
  customers: '客户',
  products: '产品',
  orders: '订单',
  suppliers: '供应商',
  purchases: '采购单',
  raw_inventory: '原材料库存',
  finished_inventory: '成品库存',
  arrivals: '到货',
  production_tasks: '生产任务',
  production_records: '完工记录',
  deliveries: '送货',
  movements: '流水',
};
export const flowMap: Record<string, (typeof flowKinds)[number]> = {
  arrivals: 'arrival',
  production_tasks: 'task',
  production_records: 'production',
  deliveries: 'delivery',
};
export const moduleSchema = z.enum(assistantModules);

/** 档案、订单、采购单这几个模块（直接是业务汇总的记录） */
type BusinessModule = 'customers' | 'products' | 'orders' | 'suppliers' | 'purchases';
const businessModules: readonly Module[] = ['customers', 'products', 'orders', 'suppliers', 'purchases'];
const isBusinessModule = (m: Module): m is BusinessModule => businessModules.includes(m);
/** 流水的单据来源记在 source_kind 上，单据的是 flow_<种类> */
const FLOW_SOURCE = 'flow_';

/** 档案、订单、采购单：业务汇总的记录，补上归档标记 */
function businessRows<E extends BusinessModule>(ctx: ToolContext, entity: E, archived: boolean, ids?: readonly number[]) {
  const records = ids ? businessRecords(ctx.store, entity, ids, archived) : businessList(ctx.store, entity, archived);
  return records.map((r) => ({ ...r, archived: ctx.store.archived(entity, r.id) }));
}
const inventoryKind = (module: 'raw_inventory' | 'finished_inventory') => (module === 'raw_inventory' ? 'raw' : 'finished');
function inventoryRows(ctx: ToolContext, module: 'raw_inventory' | 'finished_inventory', archived: boolean, id?: number): StockItemView[] {
  return ctx.ops.repo.items(archived, id).filter((i) => i.kind === inventoryKind(module));
}
/** 流水：补上产品、客户、供应商编号（筛选用）；来源单据只读流水用到的那几张 */
function movementRows(ctx: ToolContext) {
  const movements = ctx.ops.repo.movements();
  const items = new Map(ctx.ops.repo.items(true).map((i) => [i.id, i]));
  const orders = new Map(ctx.store.orders(true).map((o) => [o.id, o]));
  const purchases = new Map(ctx.ops.repo.purchases(true).flatMap((p) => p.lines.map((l) => [l.id, p] as const)));
  const fromFlowDocument = (r: (typeof movements)[number]) => String(r.source_kind).startsWith(FLOW_SOURCE);
  const documentIds = [...new Set(movements.filter(fromFlowDocument).map((r) => Number(r.source_id)))];
  const documents = new Map(
    ctx.flow
      .list(undefined, true, undefined, documentIds)
      .map((d) => [d.id, { customerId: d.kind === 'delivery' ? d.customerId : undefined, supplierId: d.kind === 'arrival' ? d.supplierId : undefined }]),
  );
  return movements.map((r) => {
    const fromFlow = fromFlowDocument(r) ? documents.get(Number(r.source_id)) : undefined;
    return {
      ...r,
      productId: items.get(Number(r.item_id))?.productId,
      customerId: orders.get(Number(r.customer_order_id))?.customerId || fromFlow?.customerId,
      supplierId: purchases.get(Number(r.purchase_line_id))?.supplierId || fromFlow?.supplierId,
    };
  });
}
/** 到货记录给助手看的样子（rows 和 row 共用）。 */
function arrivalRows(records: ReturnType<ToolContext['flow']['arrivalRecords']>) {
  return records.map((r) => ({
    ...r.document,
    ...r,
    receiptRecordId: r.id,
    id: r.flowId,
    kind: 'arrival' as const,
    archived: false,
    lines: r.lines.map((l) => ({ ...l, purchaseLineId: l.lineId })),
  }));
}
/** 单据上和别的记录的关联（各种单据各有几项） */
type FlowLinks = { orderIds?: readonly number[]; taskId?: number | null; productId?: number; customerId?: number; supplierId?: number };
function flowLinks(d: FlowDocView): FlowLinks {
  switch (d.kind) {
    case 'task':
      return { orderIds: d.orderIds, productId: d.productId };
    case 'production':
      return { taskId: d.taskId, productId: d.productId };
    case 'delivery':
      return { customerId: d.customerId };
    case 'arrival':
      return { supplierId: d.supplierId };
  }
}
/** 生产任务、完工、送货单补上关联名称：按单据里出现的编号批量读，不全量加载后再找。 */
function flowRows<K extends FlowKind>(ctx: ToolContext, docs: FlowDocView<K>[]) {
  const ids = (list: unknown[]) => [...new Set(list.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  const linked = docs.map((d) => ({ d, links: flowLinks(d) }));
  const taskIds = ids(linked.filter(({ links }) => !links.orderIds && links.taskId).map(({ links }) => links.taskId));
  const tasks = new Map(ctx.flow.list('task', true, undefined, taskIds).map((t) => [t.id, t]));
  const orderIdsOf = (links: FlowLinks): readonly number[] => links.orderIds || tasks.get(Number(links.taskId))?.orderIds || [];
  const orders = new Map(
    ctx.store.ordersByIds(ids(linked.flatMap(({ links }) => [...orderIdsOf(links)])), true).map((o) => [o.id, o.customerId]),
  );
  const names = (records: { id: number; name: string }[]) => new Map(records.map((x) => [x.id, x.name]));
  const products = names(businessRecords(ctx.store, 'products', ids(linked.map(({ links }) => links.productId)), true)),
    customers = names(businessRecords(ctx.store, 'customers', ids(linked.map(({ links }) => links.customerId)), true)),
    suppliers = names(businessRecords(ctx.store, 'suppliers', ids(linked.map(({ links }) => links.supplierId)), true));
  return linked.map(({ d, links }) => ({
    ...d,
    customerIds: [...new Set([links.customerId, ...orderIdsOf(links).map((id) => orders.get(id))].filter(Boolean))],
    productName: products.get(Number(links.productId)),
    customerName: customers.get(Number(links.customerId)),
    supplierName: suppliers.get(Number(links.supplierId)),
  }));
}

/** 各模块的记录列表长什么样 */
export type ModuleRows = {
  [M in BusinessModule]: ReturnType<typeof businessRows<M>>;
} & {
  raw_inventory: ReturnType<typeof inventoryRows>;
  finished_inventory: ReturnType<typeof inventoryRows>;
  arrivals: ReturnType<typeof arrivalRows>;
  production_tasks: ReturnType<typeof flowRows<'task'>>;
  production_records: ReturnType<typeof flowRows<'production'>>;
  deliveries: ReturnType<typeof flowRows<'delivery'>>;
  movements: ReturnType<typeof movementRows>;
};
/** 按编号取一条：和列表里那条一样；已归档的到货单不在到货记录里，按单据读，是单据的样子 */
export type ModuleRecords = { [M in Exclude<Module, 'arrivals'>]: ModuleRows[M][number] } & {
  arrivals: ModuleRows['arrivals'][number] | ReturnType<typeof flowRows<'arrival'>>[number];
};
export type ModuleRecord = ModuleRecords[Module];
/** 记录的版本号（流水没有版本） */
export const recordVersion = (r: ModuleRecord) => ('version' in r ? r.version : undefined);

export function recordRows<M extends Module>(ctx: ToolContext, module: M, actor: Actor, archived?: boolean): ModuleRows[M];
export function recordRows(ctx: ToolContext, module: Module, actor: Actor, archived = false): ModuleRows[Module] {
  requireActor(actor);
  if (isBusinessModule(module)) return businessRowsOf(ctx, module, archived);
  switch (module) {
    case 'raw_inventory':
    case 'finished_inventory':
      return inventoryRows(ctx, module, archived);
    case 'arrivals':
      return arrivalRows(ctx.flow.arrivalRecords());
    case 'production_tasks':
      return flowRows(ctx, ctx.flow.list('task', archived));
    case 'production_records':
      return flowRows(ctx, ctx.flow.list('production', archived));
    case 'deliveries':
      return flowRows(ctx, ctx.flow.list('delivery', archived));
    case 'movements':
      return movementRows(ctx);
  }
}
/** 档案、订单、采购单按模块分开取（每个模块各自的记录类型） */
function businessRowsOf(ctx: ToolContext, module: BusinessModule, archived: boolean, ids?: readonly number[]): ModuleRows[BusinessModule] {
  switch (module) {
    case 'customers':
      return businessRows(ctx, module, archived, ids);
    case 'products':
      return businessRows(ctx, module, archived, ids);
    case 'orders':
      return businessRows(ctx, module, archived, ids);
    case 'suppliers':
      return businessRows(ctx, module, archived, ids);
    case 'purchases':
      return businessRows(ctx, module, archived, ids);
  }
}
/** 单据的编号是正整数；流水是 UUID */
function numericId(id: number | string) {
  const n = Number(id);
  return Number.isSafeInteger(n) && n > 0 && String(n) === String(id) ? n : null;
}
/**
 * 按主键取一条，结构和 rows() 里那条完全一样。档案、库存品、单据都按编号直接查，
 * 不全量加载后再 find；只有流水（UUID）还走 rows()。
 */
export function recordRow<M extends Module>(ctx: ToolContext, module: M, actor: Actor, archived: boolean, id: number | string): ModuleRecords[M] | undefined;
export function recordRow(ctx: ToolContext, module: Module, actor: Actor, archived: boolean, id: number | string): ModuleRecord | undefined {
  requireActor(actor);
  const n = numericId(id);
  // 到货：按到货单编号。到货记录里没有已归档的到货单，要读已归档的（比如恢复）按单据读
  if (module === 'arrivals') {
    const row = arrivalRows(ctx.flow.arrivalRecords({}, { flowIds: n ? [n] : [] })).find((r) => String(r.id) === String(id));
    return row ?? (archived && n ? flowRows(ctx, ctx.flow.list('arrival', true, undefined, [n]))[0] : undefined);
  }
  if (module === 'movements') return movementRows(ctx).find((r) => String(r.id) === String(id));
  if (!n) return undefined;
  if (isBusinessModule(module)) return businessRowsOf(ctx, module, archived, [n])[0];
  switch (module) {
    case 'raw_inventory':
    case 'finished_inventory':
      return inventoryRows(ctx, module, archived, n)[0];
    case 'production_tasks':
      return flowRows(ctx, ctx.flow.list('task', archived, undefined, [n]))[0];
    case 'production_records':
      return flowRows(ctx, ctx.flow.list('production', archived, undefined, [n]))[0];
    case 'deliveries':
      return flowRows(ctx, ctx.flow.list('delivery', archived, undefined, [n]))[0];
  }
}
/** 记录在页面上的链接要用的几项 */
type Linkable = { id: number | string; archived?: boolean; name?: string; number?: string; receiptRecordId?: string };
export function recordLink(module: Module, row: Linkable) {
  if (module === 'arrivals') return '#warehouse?arrivals=1&receipt=' + encodeURIComponent(row.receiptRecordId || 'flow-' + row.id);
  const archivedTail = row.archived ? '&archived=1' : '';
  if (module === 'deliveries') return '#warehouse?kind=finished&deliveries=1&doc=' + row.id + archivedTail;
  if (flowMap[module]) return '#production?doc=' + row.id + archivedTail;
  if (module === 'movements') return '#warehouse?flow=1';
  if (module === 'raw_inventory' || module === 'finished_inventory')
    return '#warehouse?kind=' + inventoryKind(module) + '&q=' + encodeURIComponent(String(row.name)) + archivedTail;
  return '#' + module + '?q=' + encodeURIComponent(String(row.number || row.name)) + archivedTail;
}
