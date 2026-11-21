// 只管：按业务模块读记录——取列表 recordRows、按编号取一条 recordRow、记录在页面上的链接 recordLink（页面报的记录种类和助手模块的换算在 page-record.ts）。
// 模块名单、中文名和全站记录种类的对照在 shared/assistant/assistant-modules.ts；档案、库存品和单据按业务汇总的
// module-records.ts 读（和数据管理同一份，单据补好关联的名称），这里只加助手筛选要用的几项（归档标记、关联的客户）。
import { z } from 'zod';
import type { Actor } from '../../core/index.js';
import type { FlowDocView, FlowKind, StockItemView } from '../../../shared/business/index.js';
import { flowEntityPrefix } from '../../../shared/business/index.js';
import { assistantModules, flowKindOfModule, stockKindOf, type AssistantModule } from '../../../shared/assistant/index.js';
import { entityRecords, namedDocuments, type NamedDocument } from '../../business/index.js';
import { movementScope, suppliersOfPurchaseLines } from '../../operations/index.js';
import { requireActor, type ToolContext } from './context.js';

export type Module = AssistantModule;
export const moduleSchema = z.enum(assistantModules);

/** 档案、订单、采购单这几个模块（直接是删除归档按类型读的记录） */
type BusinessModule = 'customers' | 'products' | 'orders' | 'suppliers' | 'purchases';
const businessModules: readonly Module[] = ['customers', 'products', 'orders', 'suppliers', 'purchases'];
const isBusinessModule = (m: Module): m is BusinessModule => businessModules.includes(m);
type InventoryModule = 'raw_inventory' | 'finished_inventory';
/** 去重的正整数编号 */
const ids = (list: unknown[]) => [...new Set(list.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];

/** 档案、订单、采购单：按模块读记录的那一份，补上归档标记（一次批量取） */
function businessRows<E extends BusinessModule>(ctx: ToolContext, entity: E, archived: boolean, only?: readonly number[]) {
  const archivedIds = ctx.store.archivedIds(entity);
  return entityRecords(ctx.store, entity, archived, only).map((r) => ({ ...r, archived: archivedIds.has(r.id) }));
}
/** 原材料、成品库存：库存品按种类分开 */
function inventoryRows(ctx: ToolContext, module: InventoryModule, archived: boolean, only?: readonly number[]): StockItemView[] {
  return entityRecords(ctx.store, 'stock_items', archived, only).filter((i) => i.kind === stockKindOf(module));
}
/** 流水：补上产品、客户、供应商编号（筛选用）；库存品、订单、采购明细、来源单据只读流水用到的那几条 */
function movementRows(ctx: ToolContext, movements = ctx.flow.views.movements()) {
  const items = new Map(ctx.ops.items(true, ids(movements.map((r) => r.item_id))).map((i) => [i.id, i]));
  const orders = new Map(ctx.store.ordersByIds(ids(movements.map((r) => r.customer_order_id)), true).map((o) => [o.id, o]));
  const lineSuppliers = suppliersOfPurchaseLines(ctx.store, ids(movements.map((r) => r.purchase_line_id)));
  const fromFlowDocument = (r: (typeof movements)[number]) => String(r.source_kind).startsWith(flowEntityPrefix); // 流水的单据来源是 flow_<种类>
  const documentIds = ids(movements.filter(fromFlowDocument).map((r) => r.source_id));
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
      supplierId: lineSuppliers.get(Number(r.purchase_line_id)) || fromFlow?.supplierId,
    };
  });
}
/** 一笔流水：按它的库存品和日期圈出那几笔（采购库存的 movementScope），不读全部流水 */
function movementRow(ctx: ToolContext, id: string) {
  const scope = movementScope(ctx.store, id);
  return scope ? movementRows(ctx, ctx.flow.views.movements(scope)).find((r) => r.id === id) : undefined;
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
/** 单据挂的订单（生产任务自己的；完工单看它的生产任务的） */
function orderIdsOf(d: FlowDocView, tasks: Map<number, readonly number[]>): readonly number[] {
  if (d.kind === 'task') return d.orderIds;
  return d.kind === 'production' ? (tasks.get(Number(d.taskId)) ?? []) : [];
}
/** 完工单的生产任务、送货单的客户（别的单据没有） */
const taskOf = (d: FlowDocView) => (d.kind === 'production' ? d.taskId : undefined);
const customerOf = (d: FlowDocView) => (d.kind === 'delivery' ? d.customerId : undefined);
/**
 * 生产任务、完工、送货、到货单：按模块读记录的那一份（补好了产品、客户、供应商名），再补上关联的客户编号
 * （送货单的客户、挂的订单的客户，按客户筛选用）。按单据里出现的编号批量读，不全量加载后再找。
 */
function flowRows<K extends FlowKind>(ctx: ToolContext, kind: K, archived: boolean, only?: readonly number[]) {
  const docs: NamedDocument<K>[] = namedDocuments(ctx.flow, kind, archived, only);
  const taskIds = ids(docs.map(taskOf));
  const tasks = new Map(ctx.flow.list('task', true, undefined, taskIds).map((t) => [t.id, t.orderIds]));
  const orders = new Map(ctx.store.ordersByIds(ids(docs.flatMap((d) => [...orderIdsOf(d, tasks)])), true).map((o) => [o.id, o.customerId]));
  return docs.map((d) => ({
    ...d,
    customerIds: [...new Set([customerOf(d), ...orderIdsOf(d, tasks).map((id) => orders.get(id))].filter(Boolean))],
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
      return flowRows(ctx, 'task', archived);
    case 'production_records':
      return flowRows(ctx, 'production', archived);
    case 'deliveries':
      return flowRows(ctx, 'delivery', archived);
    case 'movements':
      return movementRows(ctx);
  }
}
/** 档案、订单、采购单按模块分开取（每个模块各自的记录类型） */
function businessRowsOf(ctx: ToolContext, module: BusinessModule, archived: boolean, only?: readonly number[]): ModuleRows[BusinessModule] {
  switch (module) {
    case 'customers':
      return businessRows(ctx, module, archived, only);
    case 'products':
      return businessRows(ctx, module, archived, only);
    case 'orders':
      return businessRows(ctx, module, archived, only);
    case 'suppliers':
      return businessRows(ctx, module, archived, only);
    case 'purchases':
      return businessRows(ctx, module, archived, only);
  }
}
/** 单据的编号是正整数；流水是 UUID */
function numericId(id: number | string) {
  const n = Number(id);
  return Number.isSafeInteger(n) && n > 0 && String(n) === String(id) ? n : null;
}
/**
 * 按主键取一条，结构和 rows() 里那条完全一样。档案、库存品、单据都按编号直接查，流水按它的库存品和日期圈出来，
 * 都不全量加载后再 find。
 */
export function recordRow<M extends Module>(ctx: ToolContext, module: M, actor: Actor, archived: boolean, id: number | string): ModuleRecords[M] | undefined;
export function recordRow(ctx: ToolContext, module: Module, actor: Actor, archived: boolean, id: number | string): ModuleRecord | undefined {
  requireActor(actor);
  const n = numericId(id);
  // 到货：按到货单编号。到货记录里没有已归档的到货单，要读已归档的（比如恢复）按单据读
  if (module === 'arrivals') {
    const row = arrivalRows(ctx.flow.arrivalRecords({}, { flowIds: n ? [n] : [] })).find((r) => String(r.id) === String(id));
    return row ?? (archived && n ? flowRows(ctx, 'arrival', true, [n])[0] : undefined);
  }
  if (module === 'movements') return movementRow(ctx, String(id));
  if (!n) return undefined;
  if (isBusinessModule(module)) return businessRowsOf(ctx, module, archived, [n])[0];
  switch (module) {
    case 'raw_inventory':
    case 'finished_inventory':
      return inventoryRows(ctx, module, archived, [n])[0];
    case 'production_tasks':
      return flowRows(ctx, 'task', archived, [n])[0];
    case 'production_records':
      return flowRows(ctx, 'production', archived, [n])[0];
    case 'deliveries':
      return flowRows(ctx, 'delivery', archived, [n])[0];
  }
}
/** 记录在页面上的链接要用的几项 */
type Linkable = { id: number | string; archived?: boolean; name?: string; number?: string; receiptRecordId?: string };
export function recordLink(module: Module, row: Linkable) {
  if (module === 'arrivals') return '#warehouse?arrivals=1&receipt=' + encodeURIComponent(row.receiptRecordId || 'flow-' + row.id);
  const archivedTail = row.archived ? '&archived=1' : '';
  if (module === 'deliveries') return '#warehouse?kind=finished&deliveries=1&doc=' + row.id + archivedTail;
  if (flowKindOfModule(module)) return '#production?doc=' + row.id + archivedTail;
  if (module === 'movements') return '#warehouse?flow=1';
  const stockKind = stockKindOf(module);
  if (stockKind) return '#warehouse?kind=' + stockKind + '&q=' + encodeURIComponent(String(row.name)) + archivedTail;
  return '#' + module + '?q=' + encodeURIComponent(String(row.number || row.name)) + archivedTail;
}
