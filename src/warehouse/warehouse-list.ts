import type { ArrivalDaily, DeliveryDaily, FlowDocView, PurchaseView } from '../../shared/business/index';
import { flowStatusText, matchesFlowStatus } from '../../shared/business/index';
import { today } from '../../shared/core/index';
import { shipDate } from '../flow/flow-dates';

/**
 * 到货、送货列表的规则：状态叫法、哪些还要处理、列表里的日期、筛选和排序。只算数据，不引 React、不发请求。
 * 行是服务端 /flow/daily 的记录；“已归档”这一档是 /flow 的单据，同一套规则。
 */

export type WarehouseKind = 'arrival' | 'delivery';
export type WarehouseScope = 'open' | 'all' | 'archived';
/** 台账（/flow/daily）的一条到货、送货记录 */
export type WarehouseRecord = ArrivalDaily | DeliveryDaily;
/** 列表的一行：台账的记录，或“已归档”这一档读到的单据（/flow） */
export type WarehouseRow = WarehouseRecord | FlowDocView<WarehouseKind>;
/** 到货页对照的采购单（/purchases 的一项）：找行对应的采购单、列采购单号，详情里列它的到货批次 */
export type WarehousePurchase = PurchaseView;

/** 列表规则要看的一行明细：到货看采购单和纸板，送货看订单和产品（台账记录的到货行只带 purchaseId，单据的行带 purchaseLineId） */
type ListLine = {
  purchaseId?: number | null;
  purchaseLineId?: number | null;
  purchaseNumber?: string;
  orderNumber?: string;
  item?: { name: string; unit: string };
  productName?: string;
  unit?: string;
  quantity: string;
};
/**
 * 列表规则要看的字段：台账记录和已归档的单据都能交进来，各自没有的那几项就是没有。
 * 到货带供应商、到货记录带 flowId 和 effective；送货带客户和出库、送达时间；台账记录带 pending、cancelled 标记。
 * 台账记录上的 completed 是“办完没有”（不是生产任务的完工数），这里不看。
 */
type ListRow = {
  id: number | string;
  flowId?: number;
  status: string;
  date?: string;
  pending?: boolean;
  cancelled?: boolean;
  effective?: boolean;
  replacedBy?: unknown;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  plannedDate?: string | null;
  actualDate?: string | null;
  supplierId?: number;
  customerId?: number;
  supplierName?: string;
  customerName?: string;
  lines: readonly ListLine[];
};
/** 找采购单：按到货明细在对照的采购单里找 */
export type PurchaseLookup = (l: ListLine) => WarehousePurchase | undefined;

/** 已归档这一档的行是单据本身（/flow 读到的），不是台账记录：没有台账记录的 pending 标记 */
export const isFlowDoc = (r: WarehouseRow): r is FlowDocView<WarehouseKind> => !('pending' in r);
/** “已归档”这一档：/flow 读到的单据里这一种的 */
export const isWarehouseDoc =
  (kind: WarehouseKind) =>
  (r: FlowDocView): r is FlowDocView<WarehouseKind> =>
    r.kind === kind;

/** 到货、送货记录的状态叫法：全站同一个 flowStatusText（shared/business/flow/physical-flow.ts）。 */
export const statusOf = (kind: WarehouseKind, r: ListRow) => flowStatusText({ ...r, kind });
/** 记录对应的单据编号：到货记录带 flowId，送货记录的编号就是单据编号 */
export const docIdOf = (r: ListRow) => Number(r.flowId ?? r.id);
/** 还要处理的：待送货、送货中（还没确认送达）；待入库。 */
export const needsWork = (kind: WarehouseKind, r: ListRow) =>
  !!r.pending || (kind === 'delivery' && r.status === 'confirmed' && !!r.shippedAt && !r.deliveredAt);
/** 待送货、待入库过了计划日还没办（到货单没有计划日，待到货的逾期看订货单）。 */
export const warehouseOverdue = (r: ListRow) => !!r.pending && !!r.plannedDate && r.plannedDate < today();
/**
 * 列表里的日期：实际发生的那天，还没发生的按计划日。到货单登记时就填了到货日期：
 * 待入库的、撤销或更正过的都显示那天（和详情一样），不显示成“—”。
 */
export const actualOf = (kind: WarehouseKind, r: ListRow) =>
  kind === 'delivery'
    ? shipDate({ ...r, kind: 'delivery' })
    : r.actualDate || (['draft', 'confirmed', 'reversed'].includes(r.status) ? r.date : '');
export const dateOf = (kind: WarehouseKind, r: ListRow) => actualOf(kind, r) || r.plannedDate || r.date || '';

/** 往来单位的名字：到货是供应商，送货是客户（单据上存的名字，没存是空的） */
export const partyOf = (r: ListRow) => r.supplierName || r.customerName || '';
/** 往来单位筛选用的键：记录上有编号的按编号（改过名的也算一家），老记录没有编号的按名称 */
const partyKey = (r: ListRow) =>
  r.supplierId ? 's' + r.supplierId : r.customerId ? 'c' + r.customerId : 'n:' + partyOf(r);

/** 记录里这一行对应的采购单（行上记了采购单就用它，否则按采购明细找） */
export const purchaseOfLine = (purchases: readonly WarehousePurchase[], l: ListLine) =>
  purchases.find((p) => l.purchaseId === p.id || p.lines.some((x) => x.id === l.purchaseLineId));
/**
 * 记录挂的采购单号（到货）或订单号（送货），去重。到货行没关联采购单时采购单号是空的，
 * 再按行上的采购单、采购明细去对照的采购单里找，找不到就不列（列表写“—”）。
 */
export const lineRefs = (kind: WarehouseKind, r: ListRow, purchaseOf: PurchaseLookup) => [
  ...new Set(
    r.lines
      .map((l) => (kind === 'arrival' ? l.purchaseNumber || purchaseOf(l)?.number : l.orderNumber))
      .filter((n): n is string => !!n),
  ),
];
/** 第一行的内容：名称、数量、单位（到货是纸板，送货是产品） */
export function firstLine(r: ListRow) {
  const l = r.lines.at(0);
  return l && { name: l.item?.name || l.productName, quantity: l.quantity, unit: l.item?.unit || l.unit };
}

type RowFilter = {
  scope: WarehouseScope;
  q: string;
  party: string;
  status: string;
  from: string;
  to: string;
  /** 从采购单跳过来时只看这张采购单的到货 */
  purchaseFilter?: number;
  purchases: readonly WarehousePurchase[];
};
/** 筛选条件下这一行留不留 */
const kept = (kind: WarehouseKind, r: ListRow, o: RowFilter) =>
  (o.scope !== 'open' || needsWork(kind, r)) &&
  (!o.q || JSON.stringify(r).toLowerCase().includes(o.q.toLowerCase())) &&
  (!o.party || partyKey(r) === o.party) &&
  matchesFlowStatus(r, kind, o.status) &&
  (!o.from || dateOf(kind, r) >= o.from) &&
  (!o.to || dateOf(kind, r) <= o.to) &&
  (!o.purchaseFilter ||
    r.lines.some((l) => (l.purchaseId || purchaseOfLine(o.purchases, l)?.id) === o.purchaseFilter));
/** 日期先后：早的在前是负数 */
const byDate = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 按条件筛、排好序：待处理的按计划日先后（最急的在上）；全部的待处理排前面，其余按日期新的在上。 */
export function warehouseRows<R extends ListRow>(kind: WarehouseKind, rows: readonly R[], o: RowFilter) {
  return rows
    .filter((r) => kept(kind, r, o))
    .sort((a, b) => {
      if (o.scope === 'open') return byDate(dateOf(kind, a), dateOf(kind, b));
      const pa = needsWork(kind, a) ? 0 : 1,
        pb = needsWork(kind, b) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return byDate(dateOf(kind, b), dateOf(kind, a));
    });
}

/** “筛选”里往来单位的下拉：按名字排好，同一家只出现一次 */
export const partyChoices = (rows: readonly ListRow[]) =>
  [...new Map(rows.filter((r) => partyOf(r)).map((r) => [partyKey(r), partyOf(r)] as const))].sort((a, b) =>
    a[1].localeCompare(b[1], 'zh-CN'),
  );
