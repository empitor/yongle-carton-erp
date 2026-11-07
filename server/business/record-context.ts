import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { requirePermission } from './management.js';
import { FlowService } from '../flow/service.js';
import { ImportError } from '../import/errors.js';
import { developerModules } from '../../shared/developer.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { OperationsRepository } from '../operations/repository.js';

/** 页面与助手共享真实关联和审计；物理删除影响由独立维护服务统一计算。 */
export function recordContext(
  store: Store,
  module: string,
  id: number,
  who: Actor | null | undefined,
) {
  requirePermission(who, 'business:edit');
  const recordModule = z.enum(developerModules).parse(module);
  const flow = new FlowService(store),
    physical = ['arrival', 'task', 'production', 'delivery'].includes(module),
    entity = physical ? 'flow_' + module : module,
    record = recordModule === 'arrival' || recordModule === 'task' || recordModule === 'production' || recordModule === 'delivery'
      ? flow.get(id) : store.record(recordModule, id, true);
  if (!record || (physical && record.kind !== module)) throw new ImportError('记录不存在。', 404);
  const related: any[] = [];
  const add = (m: string, r: any, direction = 'related') => {
    if (m === module && r.id === id) return;
    if (!related.some((x) => x.module === m && x.id === r.id))
      related.push({
        module: m,
        id: r.id,
        version: r.version,
        name: r.number || r.name,
        status: r.status,
        archived: !!r.archived,
        direction,
      });
  };
  const db = store.db, repo = new OperationsRepository(store);
  const orderIds = new Set<number>(module === 'orders' ? [id] : []);
  if (module === 'customers' || module === 'products') {
    const sql = module === 'customers'
      ? 'SELECT id FROM orders WHERE customer_id=?'
      : 'SELECT DISTINCT order_id AS id FROM order_lines WHERE product_id=?';
    for (const row of db.prepare(sql).all(id)) orderIds.add(Number(row.id));
    for (const order of store.ordersByIds([...orderIds], true)) add('orders', order);
  }
  const purchaseConditions = ['customer_order_id IN (SELECT value FROM json_each(?))'];
  const purchaseParams: (number | string)[] = [JSON.stringify([...orderIds])];
  if (module === 'purchases' || module === 'suppliers' || module === 'stock_items') {
    purchaseConditions.push(module === 'purchases' ? 'id=?' : module === 'suppliers'
      ? 'supplier_id=?' : 'id IN (SELECT purchase_id FROM purchase_lines WHERE stock_item_id=?)');
    purchaseParams.push(id);
  }
  const purchases = repo.purchases(true, db.prepare(
    'SELECT id FROM purchases WHERE ' + purchaseConditions.join(' OR '),
  ).all(...purchaseParams).map((row) => Number(row.id)));
  for (const p of purchases) add('purchases', p);
  const purchaseIds = new Set(purchases.map((p) => p.id));
  const columns: Record<string, string> = {
    customers: 'customer_id',
    products: 'product_id',
    orders: 'order_id',
    suppliers: 'supplier_id',
    purchases: 'purchase_id',
    stock_items: 'stock_id',
    task: 'task_id',
  };
  const refConditions = [
    'order_id IN (SELECT value FROM json_each(?))',
    'purchase_id IN (SELECT value FROM json_each(?))',
  ];
  const refParams: (number | string)[] = [JSON.stringify([...orderIds]), JSON.stringify([...purchaseIds])];
  if (columns[module]) { refConditions.push(columns[module] + '=?'); refParams.push(id); }
  const docIds = new Set(db.prepare(
    'SELECT DISTINCT document_id FROM flow_refs WHERE ' + refConditions.join(' OR '),
  ).all(...refParams).map((row) => Number(row.document_id)));
  for (const ref of db.prepare(
    'SELECT DISTINCT document_id FROM flow_refs WHERE task_id IN (SELECT value FROM json_each(?))',
  ).all(JSON.stringify([...docIds]))) docIds.add(Number(ref.document_id));
  // 关联摘要只需要这些字段；不装配无关单据及全库完工进度，顺序保持原列表口径。
  const summaries = (ids: number[]) => db.prepare(
    `SELECT d.*,EXISTS(SELECT 1 FROM record_lifecycle l WHERE l.entity='flow_'||d.kind AND l.record_id=d.id) AS archived
     FROM flow_documents d WHERE d.id IN (SELECT value FROM json_each(?)) ORDER BY d.date DESC,d.id DESC`,
  ).all(JSON.stringify(ids)).map((row) => ({
    ...JSON.parse(String(row.document)), id: Number(row.id), kind: String(row.kind),
    number: row.number, status: row.status, version: row.version, archived: !!row.archived,
  }));
  const docs = summaries([...docIds]);
  for (const d of docs) add(d.kind, d);
  if (physical) {
    const parentRefs = db.prepare('SELECT * FROM flow_refs WHERE document_id=?').all(id);
    const parents = {
        order_id: 'orders',
        customer_id: 'customers',
        product_id: 'products',
        supplier_id: 'suppliers',
        stock_id: 'stock_items',
        purchase_id: 'purchases',
    } as const;
    const parentRecords = new Map(Object.entries(parents).map(([column, parent]) => [
      parent, new Map(store.recordsByIds(parent, [...new Set(parentRefs.filter((r) => r[column])
        .map((r) => Number(r[column])))], true).map((r) => [r.id, r])),
    ]));
    const parentTasks = new Map(summaries([...new Set(parentRefs.filter((r) => r.task_id)
      .map((r) => Number(r.task_id)))]).map((task) => [task.id, task]));
    for (const ref of parentRefs) {
      for (const [column, parent] of Object.entries(parents))
        if (ref[column]) {
          const row = parentRecords.get(parent)?.get(Number(ref[column]));
          if (row) add(parent, row, 'upstream');
        }
      if (ref.task_id) {
        const task = parentTasks.get(Number(ref.task_id));
        if (task) add('task', task, 'upstream');
      }
    }
  }
  // 一个任务/送货单可包含多个订单；完整展示扩展影响，不能隐藏共同引用。
  const linkedOrderIds = docs.flatMap((d) => d.kind === 'task' ? d.orderIds
    : d.kind === 'delivery' ? d.lines.map((l: any) => l.orderId) : []);
  const orders = new Map(store.ordersByIds([...new Set<number>(linkedOrderIds)], true).map((o) => [o.id, o]));
  for (const d of docs) {
    const linkedOrders =
      d.kind === 'task'
        ? d.orderIds
        : d.kind === 'delivery'
          ? d.lines.map((l: any) => l.orderId)
          : [];
    for (const orderId of linkedOrders) {
      const order = orders.get(orderId);
      if (order) add('orders', order);
    }
  }
  if (module === 'products')
    for (const s of repo.items(true, db.prepare('SELECT id FROM stock_items WHERE product_id=?')
      .all(id).map((row) => Number(row.id)))) add('stock_items', s);
  const history = store.db
    .prepare(
      'SELECT at,actor_name,source,action,document FROM business_audit WHERE entity=? AND record_id=? ORDER BY id DESC LIMIT 50',
    )
    .all(entity, id)
    .map((r) => ({
      at: r.at,
      actorName: r.actor_name,
      source: r.source,
      action: r.action,
      detail: JSON.parse(String(r.document)),
    }));
  const impactDigest = createHash('sha256')
    .update(JSON.stringify({ module, id, record, related }))
    .digest('hex');
  return {
    module,
    id,
    version: record.version,
    related,
    history,
    impactDigest,
    archiveEffect: physical
      ? '编辑直接同步记录及库存；归档独立校验完成条件；删除执行数据库物理删除。'
      : '归档只隐藏记录并保留数据库行，可恢复；删除会实际移除记录，关联处理范围由删除预览展示。',
    alternatives: related
      .filter((r) => ['arrival', 'production', 'delivery', 'task'].includes(r.module))
      .map((r) => ({ ...r, action: r.status === 'confirmed' ? 'reverse' : 'archive' })),
  };
}
