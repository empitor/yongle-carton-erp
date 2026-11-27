import { flowStatusText, purchaseState, specLine, stockKindNames } from '../../shared/business/index';
import { orderDisplayStatus, type ApiJson, isFlowKind } from '../../shared/core/index';
import { isJsonList, isJsonObject, textOf, type JsonObject, type ManagedModule } from './record-types';
// 数据管理列表和编辑窗里记录怎么叫：状态、单号或名称、关联字段的候选。
/** 可搜索选择器的一项：label 是名称或单号，hint 是名称后面的小字（规格、客户、日期这类能认出来的信息） */
export type RefOption = { value: string; label: string; hint?: string; keywords?: string };
/**
 * 编辑窗里关联字段的候选：客户、产品这些在编辑窗打开时按模块读一次（useRecordList）。
 * orderLines 按订单分组，purchaseLines 是全部采购单的明细。
 */
export type RecordRefs = {
  customers?: RefOption[];
  customerSites?: Record<string, RefOption[]>;
  suppliers?: RefOption[];
  products?: RefOption[];
  stock_items?: (RefOption & { kind?: string })[];
  orders?: RefOption[];
  task?: RefOption[];
  purchaseLines?: RefOption[];
  orderLines?: Record<string, RefOption[]>;
};
/**
 * 列表“状态”列：和各页面同一套叫法。单据按类型叫（待送货、待入库、已入库、已撤销、已更正……，不说“草稿”），
 * 采购单是待订货、待到货、已到齐，订单发了一部分的是“部分发货”；档案没有状态，写“正常”。
 */
export function recordStatus(module: string, record: JsonObject): string {
  if (isFlowKind(module)) return flowStatusText({ ...record, kind: textOf(record.kind) || module });
  if (module === 'purchases') return purchaseState(record);
  if (module === 'orders')
    return orderDisplayStatus({ status: textOf(record.status), shippingProgress: textOf(record.shippingProgress) });
  return textOf(record.status) || '正常';
}
/** 列表和提示里一条记录叫什么：单号或名称，都没有写“没有单号”，不露内部编号 */
export const recordLabel = (record: JsonObject | undefined) =>
  textOf(record?.number) || textOf(record?.name) || '没有单号';

/** 编辑每个模块要读哪些关联的候选（自己模块的从列表里拿） */
export const refModules: Record<string, readonly ManagedModule[]> = {
  orders: ['customers', 'products'],
  products: ['customers'],
  stock_items: ['products'],
  purchases: ['suppliers', 'orders', 'stock_items'],
  arrival: ['suppliers', 'stock_items', 'purchases'],
  task: ['products', 'orders'],
  production: ['task', 'products', 'stock_items'],
  delivery: ['customers', 'orders', 'stock_items'],
};
const hintOf = (...parts: unknown[]) =>
  parts.filter((p) => p != null && p !== '' && p !== false).join(' · ') || undefined;
/** 数量后面接上单位：“10 只” */
const amount = (quantity: ApiJson | undefined, unit: ApiJson | undefined) => textOf(quantity) + ' ' + textOf(unit);
/** 明细：一组对象（不是数组的当没有明细） */
const linesOf = (v: ApiJson | undefined) => (isJsonList(v) ? v.filter(isJsonObject) : []);
const archived = (r: JsonObject) => (r.archived ? '已归档' : '');
const option = (r: JsonObject, label: string, hint?: string): RefOption => ({ value: String(r.id), label, hint });
const parties = (rows: readonly JsonObject[] = []) =>
  rows.map((r) => option(r, textOf(r.name), hintOf(r.contact, r.phone, archived(r))));

/** 产品的候选：名称，小字是规格和料号 */
const productOptions = (products: readonly JsonObject[]) =>
  products.map((p) =>
    option(p, textOf(p.name), hintOf(specLine(p), p.customerProductCode && '料号 ' + textOf(p.customerProductCode), archived(p))),
  );
/** 库存品的候选：名称，小字是原材料还是成品和规格；带上种类，到货、送货按用途筛 */
const stockOptions = (items: readonly JsonObject[]) =>
  items.map((s) => ({
    ...option(s, textOf(s.name), hintOf(stockKindNames[s.kind === 'finished' ? 'finished' : 'raw'], specLine(s), archived(s))),
    kind: textOf(s.kind),
  }));
/** 生产任务的候选：单号，小字是产品、数量和状态（产品名没记的按产品编号找） */
function taskOptions(tasks: readonly JsonObject[], products: readonly JsonObject[]) {
  const productName = new Map(products.map((p) => [p.id, p.name]));
  return tasks.map((t) =>
    option(
      t,
      textOf(t.number),
      hintOf(
        t.productName || productName.get(t.productId),
        t.quantity && amount(t.quantity, t.unit),
        flowStatusText({ ...t, kind: 'task' }),
      ),
    ),
  );
}
/** 订单明细的候选：按订单分组，“第几项 产品名称”，小字是规格和数量 */
const orderLineOptions = (orders: readonly JsonObject[]) =>
  Object.fromEntries(
    orders.map((o) => [
      String(o.id),
      linesOf(o.lines).map((l, i) =>
        option(
          l,
          '第' + (i + 1) + '项 ' + textOf(l.productName),
          hintOf(l.specification, l.quantity != null && amount(l.quantity, l.unit)),
        ),
      ),
    ]),
  );

/**
 * 关联字段的候选：名称或单号做选项，后面小字带能认出来的信息（规格、客户、交期……），不带内部编号。
 * lists 是各模块 /management/records 的 records（自己模块的就是当前列表）。
 */
export function buildRefs(lists: Record<string, readonly JsonObject[]>): RecordRefs {
  const products = lists.products || [],
    orders = lists.orders || [];
  return {
    customers: parties(lists.customers),
    customerSites: Object.fromEntries((lists.customers ?? []).map((c) => [
      String(c.id),
      linesOf(c.sites).map((s) => option(s, textOf(s.name), hintOf(s.isDefault && '默认', s.address, s.contact, s.phone))),
    ])),
    suppliers: parties(lists.suppliers),
    products: productOptions(products),
    stock_items: stockOptions(lists.stock_items || []),
    orders: orders.map((o) =>
      option(o, textOf(o.number), hintOf(o.customerName, o.deliveryDate && '交期 ' + textOf(o.deliveryDate), archived(o))),
    ),
    task: taskOptions(lists.task || [], products),
    purchaseLines: (lists.purchases || []).flatMap((p) =>
      linesOf(p.lines).map((l) =>
        option(
          l,
          textOf(p.number) + ' · ' + textOf(l.name),
          hintOf(p.supplierName, specLine(l), l.quantity && amount(l.quantity, l.unit)),
        ),
      ),
    ),
    orderLines: orderLineOptions(orders),
  };
}
