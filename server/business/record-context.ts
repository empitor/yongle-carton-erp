import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { requirePermission } from './management.js';
import { FlowService } from '../flow/service.js';
import { ImportError } from '../import/errors.js';
import { developerModules } from '../../shared/developer.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';

/** 页面与助手共享真实关联和审计；物理删除影响由独立维护服务统一计算。 */
export function recordContext(
  store: Store,
  module: string,
  id: number,
  who: Actor | null | undefined,
) {
  requirePermission(who, 'business:edit');
  z.enum(developerModules).parse(module);
  const flow = new FlowService(store),
    physical = ['arrival', 'task', 'production', 'delivery'].includes(module),
    entity = physical ? 'flow_' + module : module,
    record = physical ? flow.get(id) : (store as any)[module](true).find((r: any) => r.id === id);
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
  const orders = store.orders(true);
  const orderIds = new Set<number>(module === 'orders' ? [id] : []);
  for (const o of orders) {
    if (
      (module === 'customers' && o.customerId === id) ||
      (module === 'products' && o.lines.some((l) => l.productId === id))
    ) {
      add('orders', o);
      orderIds.add(o.id);
    }
  }
  const purchases = store
    .purchases(true)
    .filter(
      (p) =>
        (module === 'purchases' && p.id === id) ||
        (module === 'suppliers' && p.supplierId === id) ||
        orderIds.has(p.customerOrderId) ||
        (module === 'stock_items' && p.lines.some((l: any) => l.stockItemId === id)),
    );
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
  const refs = store.db.prepare('SELECT * FROM flow_refs').all();
  const docs = flow.list(undefined, true);
  const docIds = new Set<number>();
  for (const ref of refs)
    if (
      (columns[module] && ref[columns[module]] === id) ||
      orderIds.has(Number(ref.order_id)) ||
      purchaseIds.has(Number(ref.purchase_id))
    )
      docIds.add(Number(ref.document_id));
  for (const ref of refs) if (docIds.has(Number(ref.task_id))) docIds.add(Number(ref.document_id));
  for (const d of docs) if (docIds.has(d.id)) add(d.kind, d);
  if (physical)
    for (const ref of refs.filter((r) => Number(r.document_id) === id)) {
      const parents: Record<string, string> = {
        order_id: 'orders',
        customer_id: 'customers',
        product_id: 'products',
        supplier_id: 'suppliers',
        stock_id: 'stock_items',
        purchase_id: 'purchases',
      };
      for (const [column, parent] of Object.entries(parents))
        if (ref[column]) {
          const row = (store as any)[parent](true).find((r: any) => r.id === Number(ref[column]));
          if (row) add(parent, row, 'upstream');
        }
      if (ref.task_id) {
        const task = docs.find((d) => d.id === Number(ref.task_id));
        if (task) add('task', task, 'upstream');
      }
    }
  // 一个任务/送货单可包含多个订单；完整展示扩展影响，不能隐藏共同引用。
  for (const d of docs.filter((d) => docIds.has(d.id))) {
    const linkedOrders =
      d.kind === 'task'
        ? d.orderIds
        : d.kind === 'delivery'
          ? d.lines.map((l: any) => l.orderId)
          : [];
    for (const orderId of linkedOrders) {
      const order = orders.find((o) => o.id === orderId);
      if (order) add('orders', order);
    }
  }
  if (module === 'products')
    for (const s of store.stock_items(true)) if (s.productId === id) add('stock_items', s);
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
