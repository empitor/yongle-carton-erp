import type { FlowDocView, FlowKind } from '../../shared/business/index';

/** 单据页（生产任务、完工、到货、送货）读档案的规则：列表只读当前单据，编辑窗、详情真正要用时才读。 */
export const title = (kind: FlowKind) =>
  kind === 'arrival' ? '到货' : kind === 'task' ? '生产任务' : kind === 'production' ? '完工记录' : '送货';

/** 单据页要对照的档案。列表只读当前单据，这些在编辑窗、详情、排产板真正要用时才读。 */
const lookupKeys = ['suppliers', 'purchases', 'items', 'products', 'orders', 'customers', 'tasks', 'productions'] as const;
export type LookupKey = (typeof lookupKeys)[number];
const isLookupKey = (key: string): key is LookupKey => lookupKeys.some((k) => k === key);
/** [档案, 是否必须是本次刷新后读到的]。只显示名称和单号的地方用以前读过的就够了。读法和缓存在 recordkit/useCatalog.ts。 */
export type LookupNeed = [LookupKey, boolean];
export const latest = (keys: LookupKey[]): LookupNeed[] => keys.map((key) => [key, true]);
/** 编辑窗按单据类型要用的档案，打开时读最新的（剩余数量、可选采购行都会随业务变化）。 */
export const editorLookups: Record<FlowKind, LookupKey[]> = {
  arrival: ['suppliers', 'purchases', 'items'],
  task: ['products', 'orders'],
  production: ['tasks', 'products', 'orders', 'items'],
  delivery: ['customers', 'orders', 'products', 'items'],
};
/** 生产任务详情：关联订单只拿单号；有完工登记时列出完工记录（要最新的）和领料（库存品只显示纸板名称） */
const taskOrders: LookupNeed[] = [['orders', false]];
const taskProductions: LookupNeed[] = [
  ['productions', true],
  ['items', false],
];
/**
 * 详情只拿档案显示名称和单号（到货单另列采购单的到货记录）；已确认的到货单要按采购的收货记录判断能否更正，必须是最新的采购。
 */
export function detailLookups(d: FlowDocView | null | undefined): LookupNeed[] {
  if (!d) return [];
  if (d.kind === 'task') return [...(d.orderIds.length ? taskOrders : []), ...(d.hasProduction ? taskProductions : [])];
  if (d.kind === 'production') return d.taskId ? [['items', false], ['tasks', false]] : [['items', false]];
  if (d.kind === 'delivery')
    return [
      ['customers', false],
      ['orders', false],
    ];
  // 单据里还没存供应商名的（待入库）读供应商，详情标题下面那行要写
  const supplier: LookupNeed[] = d.supplierName ? [] : [['suppliers', false]];
  if (d.status === 'confirmed') return [['purchases', true], ...supplier];
  // 挂了采购的读采购单：显示单号、列这张采购单的到货记录；没挂采购的显示“无采购单”，不用读
  const purchases: LookupNeed[] = d.lines.some((l) => l.purchaseLineId || l.purchaseId) ? [['purchases', false]] : [];
  return [...purchases, ...supplier];
}

/** 列表名称列要看的：单据里存的往来方或产品名称，和它的编号（还没核对的单据没存名称） */
export type NamedRow = {
  supplierName?: string;
  supplierId?: number | null;
  customerName?: string;
  customerId?: number | null;
  productName?: string;
  productId?: number | null;
};
/** 列表名称列：单据里存了名称就不用档案，没存（还没核对的单据）才去档案里找。 */
const labelFields: Record<
  FlowKind,
  [name: 'supplierName' | 'customerName' | 'productName', id: 'supplierId' | 'customerId' | 'productId', LookupKey]
> = {
  arrival: ['supplierName', 'supplierId', 'suppliers'],
  delivery: ['customerName', 'customerId', 'customers'],
  task: ['productName', 'productId', 'products'],
  production: ['productName', 'productId', 'products'],
};
/**
 * 当前打开的窗口和列表要用哪些档案，写成一个键（“items!,products”：带 ! 的要本次刷新后读的）。
 * 编辑窗要最新的；核对窗要最新的库存品；登记完工要最新的任务、产品、库存品；
 * 详情只拿名称；排产板要产品名；列表和调整排程窗里没存名称的行要对应的档案。生产任务列表本身就是任务清单时不读任务。
 */
export function lookupNeedKey(o: {
  kind: FlowKind;
  /** 编辑窗开着时它的单据类型 */
  editorKind: FlowKind | null;
  /** 核对窗的单据 */
  preview?: FlowDocView;
  batch: boolean;
  view: FlowDocView | null;
  showBoard: boolean;
  /** 要显示名称的行（列表这一页、调整排程的那张） */
  unnamed: (NamedRow | null)[];
  tasksFromRows: boolean;
}) {
  const needs = new Map<LookupKey, boolean>();
  const want = (list: LookupNeed[]) => {
    for (const [key, fresh] of list) needs.set(key, fresh || !!needs.get(key));
  };
  if (o.editorKind) want(latest(editorLookups[o.editorKind]));
  if (o.preview) want([...detailLookups(o.preview), ['items', true]]);
  if (o.batch) want(latest(['tasks', 'products', 'items']));
  want(detailLookups(o.view));
  if (o.showBoard) want([['products', false]]);
  const [nameField, idField, nameLookup] = labelFields[o.kind];
  if (o.unnamed.some((r) => r && !r[nameField] && r[idField] !== null && r[idField] !== undefined))
    want([[nameLookup, false]]);
  return [...needs]
    .filter(([key]) => !(key === 'tasks' && o.tasksFromRows))
    .map(([key, fresh]) => key + (fresh ? '!' : ''))
    .sort()
    .join(',');
}
/** 把 lookupNeedKey 写成的键读回要读的档案（effect 按这个键决定要不要重读） */
export function needsOfKey(key: string): LookupNeed[] {
  return key.split(',').flatMap((part): LookupNeed[] => {
    const name = part.replace('!', '');
    return isLookupKey(name) ? [[name, part.endsWith('!')]] : [];
  });
}
