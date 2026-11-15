import type { FlowApi, FlowDocView, OperationsApi, RecordsApi } from '../../shared/business/index';
import { call } from '../ui/index';

/**
 * 业务窗口和单据页要对照的档案清单，按各模块的接口表读（客户、产品、订单 records-api，供应商、采购单、库存品 operations-api，
 * 生产任务、完工、送货单 flow-api），读法只写在这一处。窗口打开时用 readCatalog 读最新的（剩余数量、可用库存会随业务变化）；
 * 单据页按需读、按业务版本缓存的用 useCatalog（同一份清单、同一个读法）。
 */
const records = call<RecordsApi>(),
  operations = call<OperationsApi>(),
  flow = call<FlowApi>();

/** 有哪几份清单 */
export const catalogKeys = [
  'orders',
  /** 还没发完的订单（可发货列表用） */
  'pendingOrders',
  'products',
  'suppliers',
  'customers',
  'purchases',
  /** 全部库存品（原材料和成品） */
  'items',
  'rawItems',
  'finishedItems',
  /** 生产任务、完工记录 */
  'tasks',
  'productions',
  /** 待送货的送货单：已经排上的数量不再重复排 */
  'pendingDeliveries',
] as const;
export type CatalogKey = (typeof catalogKeys)[number];

type StockItems = OperationsApi['GET /warehouse/items']['response'];
/** 每份清单读回来的样子 */
export type CatalogLists = {
  orders: RecordsApi['GET /orders']['response'];
  pendingOrders: RecordsApi['GET /orders']['response'];
  products: RecordsApi['GET /products']['response'];
  suppliers: OperationsApi['GET /suppliers']['response'];
  customers: RecordsApi['GET /customers']['response'];
  purchases: OperationsApi['GET /purchases']['response'];
  items: StockItems;
  rawItems: StockItems;
  finishedItems: StockItems;
  tasks: FlowDocView<'task'>[];
  productions: FlowDocView<'production'>[];
  pendingDeliveries: FlowDocView<'delivery'>[];
};

/** 连同已归档的一起读时带 archived=all，平常不带 */
type Scope = { archived?: 'all' };

/** 按种类读的单据列表：服务端已经按 kind 筛好，这里按种类认出类型 */
const ofKind =
  <K extends FlowDocView['kind']>(kind: K) =>
  (docs: FlowDocView[]) =>
    docs.filter((d): d is FlowDocView<K> => d.kind === kind);

const readers: { [K in CatalogKey]: (scope: Scope) => Promise<CatalogLists[K]> } = {
  orders: (scope) => records('GET /orders', { query: scope }),
  pendingOrders: (scope) => records('GET /orders', { query: { view: 'pending', ...scope } }),
  products: (scope) => records('GET /products', { query: scope }),
  suppliers: (scope) => operations('GET /suppliers', { query: scope }),
  customers: (scope) => records('GET /customers', { query: scope }),
  purchases: (scope) => operations('GET /purchases', { query: scope }),
  items: (scope) => operations('GET /warehouse/items', { query: scope }),
  rawItems: (scope) => operations('GET /warehouse/items', { query: { kind: 'raw', ...scope } }),
  finishedItems: (scope) => operations('GET /warehouse/items', { query: { kind: 'finished', ...scope } }),
  tasks: (scope) => flow('GET /flow', { query: { kind: 'task', ...scope } }).then(ofKind('task')),
  productions: (scope) => flow('GET /flow', { query: { kind: 'production', ...scope } }).then(ofKind('production')),
  pendingDeliveries: (scope) =>
    flow('GET /flow', { query: { kind: 'delivery', status: 'draft', ...scope } }).then(ofKind('delivery')),
};

/** 要的几份都读到了 */
const complete = <K extends CatalogKey>(lists: Partial<CatalogLists>, keys: readonly K[]): lists is Pick<CatalogLists, K> =>
  keys.every((key) => lists[key] !== undefined);

/**
 * 一次读几份档案，返回 { 名字: 列表 }。all 为真时连同已归档的一起读（超级管理员改历史单据时要对得上）。
 */
export async function readCatalog<K extends CatalogKey>(
  keys: readonly K[],
  options: { all?: boolean } = {},
): Promise<Pick<CatalogLists, K>> {
  const scope: Scope = options.all ? { archived: 'all' } : {};
  const lists: Partial<CatalogLists> = {};
  await Promise.all(
    keys.map(async (key) => {
      lists[key] = await readers[key](scope);
    }),
  );
  if (!complete(lists, keys)) throw new Error('档案清单没读全，请刷新页面再试。');
  return lists;
}
