import { z } from 'zod';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { AUDIT_SOURCE, auditSourceNames, financeOnlyAccount } from '../../shared/core/index.js';
import { FlowService } from '../flow/index.js';
import { AppError, count, many, parseStoredJson, rows } from '../core/index.js';
import { dataManagementModules, flowKinds, isFlowKind, recordEntities } from '../../shared/business/index.js';
import { OperationsRepository, purchaseOrderLinks } from '../operations/index.js';
import { businessRecord, businessRecords } from './records.js';
import { historyRefs } from './history-refs.js';

/** 记录上的修改历史最多列几条（新的在前） */
const RECORD_HISTORY_LIMIT = 50;
const auditColumns = rows.business_audit.pick({ id: true, at: true, actor_name: true, action: true, document: true });
/** 审计来源建表里有同样的枚举（tests/schema-constraints.test.ts 守着），读出来就是这四种之一 */
const auditRow = auditColumns.extend({ source: z.enum(AUDIT_SOURCE) });
/** 审计内容是写进去时 JSON.stringify 的，读出来一定是 JSON 值 */
const auditDetail = z.json();
const plainObject = z.record(z.string(), auditDetail);
const idRow = z.object({ id: z.number() });
const documentIdRow = rows.flow_refs.pick({ document_id: true });

/** 审计的一行整理成修改历史的一条（记录上的修改历史和按人按时间查共用）。 */
function historyEntry(r: z.infer<typeof auditRow>) {
  // 审计来源（页面、助手、数据管理、系统，shared/core/audit-sources.ts）只给中文叫法，界面据此加小标签，助手看到的也是这几个字；
  // 数据管理记审计用的 origin 不给
  const raw = parseStoredJson(auditDetail, r.document, `business_audit.document（第 ${r.id} 条）`);
  const plain = plainObject.safeParse(raw);
  let detail: z.output<typeof auditDetail> = raw;
  if (plain.success) {
    const { origin: _origin, ...rest } = plain.data;
    detail = rest;
  }
  return { at: r.at, actorName: r.actor_name, action: r.action, sourceLabel: auditSourceNames[r.source], detail };
}

/**
 * 按人、按时间段查修改记录（助手的 history.records，只给超级管理员，调用方核对）。from、to 是审计时间（ISO），
 * 左闭右开；一次最多 limit 条，新的在前。不给全表：时间段必填。
 */
export function auditTrail(
  store: Store,
  filter: { from: string; to: string; actorName?: string },
  page: { limit: number; offset: number },
) {
  const where = 'at>=? AND at<?' + (filter.actorName ? ' AND actor_name=?' : ''),
    params = [filter.from, filter.to, ...(filter.actorName ? [filter.actorName] : [])];
  const total = count(store.db, 'SELECT count(*) FROM business_audit WHERE ' + where, ...params);
  const history = many(
    store.db,
    auditRow.extend({ entity: rows.business_audit.shape.entity, record_id: rows.business_audit.shape.record_id }),
    'SELECT id,at,actor_name,source,action,entity,record_id,document FROM business_audit WHERE ' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?',
    ...params,
    page.limit,
    page.offset,
  ).map((r) => ({ ...historyEntry(r), entity: r.entity, recordId: r.record_id }));
  return { total, history, historyRefs: historyRefs(store, history.map((h) => h.detail)) };
}

/** 能看业务记录的人就能看它的关联和修改历史（只读账号也行，用户定的）；纯财务账号看不到业务记录。页面和助手都用这一个判断。 */
export function requireRecordReader(who: Actor | null | undefined) {
  if (!who) throw new AppError('请先登录管理账号。', 401, 'authentication');
  if (financeOnlyAccount(who)) throw new AppError('当前账号没有执行此操作的权限。', 403, 'permission');
}

/** 能列进“关联记录”的一条：档案、订单、采购单、库存品、单据都有的几项，单据和订单另有显示状态用的几项 */
type Linkable = {
  id: number;
  version: number;
  number?: string;
  name?: string;
  status?: string;
  archived?: boolean;
  shippingProgress?: string;
  businessStatus?: string;
  effective?: boolean;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  quantity?: string;
  completed?: string;
};

/** 关联记录的清单：同一条只列一次，这条记录自己不列 */
function relatedList(module: string, id: number) {
  const related: ReturnType<typeof relatedEntry>[] = [];
  const add = (m: string, r: Linkable, direction = 'related') => {
    if (m === module && r.id === id) return;
    if (!related.some((x) => x.module === m && x.id === r.id)) related.push(relatedEntry(m, r, direction));
  };
  return { related, add };
}

function relatedEntry(module: string, r: Linkable, direction: string) {
  return {
    module,
    id: r.id,
    version: r.version,
    name: r.number || r.name,
    status: r.status,
    archived: !!r.archived,
    direction,
    // 只给界面显示用（算出和列表一样的状态叫法：部分发货、送货中、已送达、生产进度……）
    view: {
      shippingProgress: r.shippingProgress,
      businessStatus: r.businessStatus,
      effective: r.effective,
      shippedAt: r.shippedAt,
      deliveredAt: r.deliveredAt,
      quantity: r.quantity,
      completed: r.completed,
    },
  };
}

/** 这条记录的版本号；不存在（单据种类和模块对不上也算）报 404 */
function recordVersion(store: Store, flow: FlowService, module: string, id: number) {
  const kind = flowKinds.find((k) => k === module);
  if (kind) {
    const doc = flow.get(id);
    if (doc.kind !== kind) throw new AppError('记录不存在。', 404);
    return doc.version;
  }
  const entity = recordEntities.find((e) => e === module);
  const record = entity ? businessRecord(store, entity, id, true) : undefined;
  if (!record) throw new AppError('记录不存在。', 404);
  return record.version;
}

/** 关联到的订单编号：订单自己；客户的订单、用到这个产品的订单 */
function relatedOrderIds(store: Store, module: string, id: number) {
  const orderIds = new Set<number>(module === 'orders' ? [id] : []);
  if (module === 'customers' || module === 'products') {
    const sql = module === 'customers' ? 'SELECT id FROM orders WHERE customer_id=?' : 'SELECT DISTINCT order_id AS id FROM order_lines WHERE product_id=?';
    for (const row of many(store.db, idRow, sql, id)) orderIds.add(row.id);
  }
  return orderIds;
}

/** 关联到的采购单：给这些订单订料的，加上这张采购单自己、这家供应商的、订了这个库存品的 */
function relatedPurchases(store: Store, module: string, id: number, orderIds: Set<number>) {
  const conditions = ['id IN (SELECT purchase_id FROM (' + purchaseOrderLinks + ') WHERE order_id IN (SELECT value FROM json_each(?)))'];
  const params: (number | string)[] = [JSON.stringify([...orderIds])];
  if (module === 'purchases' || module === 'suppliers' || module === 'stock_items') {
    conditions.push(
      module === 'purchases' ? 'id=?' : module === 'suppliers' ? 'supplier_id=?' : 'id IN (SELECT purchase_id FROM purchase_lines WHERE stock_item_id=?)',
    );
    params.push(id);
  }
  const ids = many(store.db, idRow, 'SELECT id FROM purchases WHERE ' + conditions.join(' OR '), ...params).map((row) => row.id);
  return new OperationsRepository(store).purchases(true, ids);
}

/** flow_refs 里哪一列记着这类记录 */
const refColumns: Partial<Record<string, string>> = {
  customers: 'customer_id',
  products: 'product_id',
  orders: 'order_id',
  suppliers: 'supplier_id',
  purchases: 'purchase_id',
  stock_items: 'stock_id',
  task: 'task_id',
};

/** 关联到的单据编号：挂着这些订单、采购单或这条记录的，再加上挂在这些单据（生产任务）下的 */
function relatedDocumentIds(store: Store, module: string, id: number, links: { orderIds: Set<number>; purchaseIds: Set<number> }) {
  const conditions = ['order_id IN (SELECT value FROM json_each(?))', 'purchase_id IN (SELECT value FROM json_each(?))'];
  const params: (number | string)[] = [JSON.stringify([...links.orderIds]), JSON.stringify([...links.purchaseIds])];
  const column = refColumns[module];
  if (column) {
    conditions.push(column + '=?');
    params.push(id);
  }
  const docIds = new Set(
    many(store.db, documentIdRow, 'SELECT DISTINCT document_id FROM flow_refs WHERE ' + conditions.join(' OR '), ...params).map(
      (row) => row.document_id,
    ),
  );
  const underTasks = many(
    store.db,
    documentIdRow,
    'SELECT DISTINCT document_id FROM flow_refs WHERE task_id IN (SELECT value FROM json_each(?))',
    JSON.stringify([...docIds]),
  );
  for (const ref of underTasks) docIds.add(ref.document_id);
  return docIds;
}

/** 单据的上游列（flow_refs）和对应的记录类别 */
const parentColumns = [
  ['order_id', 'orders'],
  ['customer_id', 'customers'],
  ['product_id', 'products'],
  ['supplier_id', 'suppliers'],
  ['stock_id', 'stock_items'],
  ['purchase_id', 'purchases'],
] as const;

/** 单据的上游：它挂着的订单、客户、产品、供应商、库存品、采购单和生产任务 */
function addUpstream(store: Store, flow: FlowService, id: number, add: (m: string, r: Linkable, direction: string) => void) {
  const parentRefs = many(store.db, rows.flow_refs, 'SELECT * FROM flow_refs WHERE document_id=?', id);
  const valuesOf = (pick: (r: (typeof parentRefs)[number]) => number | null) => [
    ...new Set(
      parentRefs.flatMap((r) => {
        const value = pick(r);
        return value ? [value] : [];
      }),
    ),
  ];
  const parentRecords = new Map(
    parentColumns.map(([column, parent]) => [
      parent,
      new Map<number, Linkable>(businessRecords(store, parent, valuesOf((r) => r[column]), true).map((r) => [r.id, r])),
    ]),
  );
  const parentTasks = new Map(flow.list(undefined, true, undefined, valuesOf((r) => r.task_id)).map((task) => [task.id, task]));
  for (const ref of parentRefs) {
    for (const [column, parent] of parentColumns) {
      const value = ref[column];
      const row = value ? parentRecords.get(parent)?.get(value) : undefined;
      if (row) add(parent, row, 'upstream');
    }
    const task = ref.task_id ? parentTasks.get(ref.task_id) : undefined;
    if (task) add('task', task, 'upstream');
  }
}

/** 一张单据挂着的订单：生产任务的几张订单、送货单明细的订单 */
function documentOrderIds(d: ReturnType<FlowService['list']>[number]) {
  if (d.kind === 'task') return d.orderIds;
  if (d.kind === 'delivery') return d.lines.map((l) => l.orderId);
  return [];
}

/** 页面与助手共享真实关联和审计；物理删除影响由独立维护服务统一计算。 */
export function recordContext(store: Store, module: string, id: number, who: Actor | null | undefined) {
  requireRecordReader(who);
  const recordModule = z.enum(dataManagementModules).parse(module);
  const flow = new FlowService(store),
    physical = flowKinds.some((k) => k === recordModule),
    entity = physical ? 'flow_' + module : module,
    version = recordVersion(store, flow, recordModule, id);
  const { related, add } = relatedList(module, id);
  const orderIds = relatedOrderIds(store, module, id);
  if (module === 'customers' || module === 'products')
    for (const order of store.ordersByIds([...orderIds], true)) add('orders', order);
  const purchases = relatedPurchases(store, module, id, orderIds);
  for (const p of purchases) add('purchases', p);
  const purchaseIds = new Set(purchases.map((p) => p.id));
  // 关联单据按主键读、按列表同一口径组装（生产任务的完工数、进度和任务列表一致），顺序是日期新的在前
  const docs = flow.list(undefined, true, undefined, [...relatedDocumentIds(store, module, id, { orderIds, purchaseIds })]);
  for (const d of docs) add(d.kind, d);
  if (physical) addUpstream(store, flow, id, add);
  // 一个任务/送货单可包含多个订单；完整展示扩展影响，不能隐藏共同引用。
  const orders = new Map(store.ordersByIds([...new Set(docs.flatMap(documentOrderIds))], true).map((o) => [o.id, o]));
  for (const d of docs)
    for (const orderId of documentOrderIds(d)) {
      const order = orders.get(orderId);
      if (order) add('orders', order);
    }
  if (module === 'products')
    for (const s of new OperationsRepository(store).items(true, many(store.db, idRow, 'SELECT id FROM stock_items WHERE product_id=?', id).map((row) => row.id)))
      add('stock_items', s);
  // 单据的审计记在 flow_<模块> 上，别的记录记在表名上（走 (entity,record_id) 索引）
  const history = many(
    store.db,
    auditRow,
    'SELECT id,at,actor_name,source,action,document FROM business_audit WHERE entity=? AND record_id=? ORDER BY id DESC LIMIT ?',
    entity,
    id,
    RECORD_HISTORY_LIMIT,
  ).map(historyEntry);
  return {
    module,
    id,
    version,
    related,
    history,
    // 修改历史里引用到的客户、产品、订单、单据的名称或单号，界面把审计内容逐项写成中文时用（只读，按表一次查齐）
    historyRefs: historyRefs(store, history.map((h) => h.detail), { module, id }),
    // “关联记录与修改历史”窗口顶上的一句说明：这条记录改了、归档、删除各会怎样，用普通话说
    archiveEffect: physical
      ? '这张单据改了，关联的订单进度和库存会跟着更新。归档只是收起来不显示，能恢复；删除不能恢复，删之前会列出一起处理的记录，核对后才删。'
      : '归档只是收起来不显示，能恢复；删除不能恢复，删之前会列出一起删掉和保留下来的记录，核对后才删。',
    alternatives: related
      .filter((r) => isFlowKind(r.module))
      .map(({ view: _view, ...r }) => ({ ...r, action: r.status === 'confirmed' ? 'reverse' : 'archive' })),
  };
}
