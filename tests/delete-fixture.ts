// 删除测试共用的准备：几张不同状态的单据、带导入记录的订单、影响清单用的采购到货生产送货。
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import { FlowService } from '../server/flow/service.js';
import { OperationsService } from '../server/operations/service.js';
import { customerSchema, orderSchema, productSchema } from '../shared/core/domain.js';
// 删除时识别导入、财务按登记的规则配合（server/core/deletion-rules.ts），正式服务启动时都会加载
import '../server/import/index.js';
import '../server/finance/index.js';
import { actor } from './assistant-fixture.js';
import { saveDoc } from './receive-fixture.js';
import { z } from 'zod';
import { one, parseStoredJson, rows } from '../server/core/index.js';
import type { FlowKind } from '../shared/business/index.js';

/** 一张还没核对的到货单（不挂采购单）、一张已下达生产任务（安排即下达）、一张已入库的到货单；操作人都不是本机管理员（服务器上的远程账号）。 */
export function setup() {
  const store = new Store(':memory:'),
    flow = new FlowService(store),
    service = new DatabaseMaintenanceService(store);
  const product = store.saveProduct(productSchema.parse({ name: '虚构纸箱' }));
  const task = (quantity: string) =>
    saveDoc(flow, 
      'task',
      { date: '2026-11-09', plannedDate: '2026-11-10', productId: product.id, quantity, unit: '只', orderIds: [], notes: '' },
      actor,
    );
  const supplier = new OperationsService(store).saveSupplier({ name: '虚构供应商' }, actor);
  const arrival = (reference: string) =>
    saveDoc(flow, 'arrival', { date: '2026-11-09', supplierId: supplier.id, reference, lines: [{ item: { name: '虚构纸板', unit: '张' }, quantity: '10' }] }, actor);
  const draft = arrival('虚构送货单-待核对'),
    live = task('200'),
    pending = arrival('虚构送货单-已入库');
  const check = flow.preview(pending.id, actor);
  const stocked = flow.confirm(pending.id, { previewDigest: check.previewDigest, requestId: randomUUID(), acknowledged: true }, actor);
  const selection = (doc: { kind: string; id: number; version: number }) => ({ module: doc.kind, items: [{ id: doc.id, version: doc.version }], inventoryPolicy: 'preserve' });
  const exists = (id: number) => !!store.db.prepare('SELECT 1 FROM flow_documents WHERE id=?').get(id);
  return { store, flow, service, draft, live, stocked, selection, exists, task, arrival };
}

/*
 * 删除记录时各模块按登记的规则配合（server/core/deletion-rules.ts）：
 * 删除引擎、永久删除只调登记的规则，表由它的主人写；没登记的表宁可拒绝，也不由删除路径直接写。
 */
export function orderWithImports() {
  const store = new Store(':memory:');
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构纸箱' }));
  const order = (n: number) =>
    store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: '2026-11-01',
        deliveryDate: '2026-11-20',
        status: '已确认',
        lines: [{ productId: product.id, quantity: 100 * n, unit: '只', unitPriceCents: 100 }],
      }),
    );
  const target = order(1),
    other = order(2);
  // 两条导入记录：挂着这张订单的、挂着别的订单的
  const insert = store.db.prepare('INSERT INTO import_executions(id,source_id,file_hash,fingerprint,order_id,actor_id,created_at,document) VALUES(?,?,?,?,?,?,?,?)');
  const row = (id: string, orderId: number) =>
    insert.run(id, 'src-' + id, 'hash-' + id, 'fp-' + id, orderId, 'tester', '2026-11-01T00:00:00.000Z', JSON.stringify({ orderId, fileName: '虚构订单.xlsx', at: '2026-11-01T00:00:00.000Z', actor: { id: 'tester', name: '虚构导入员' }, sourceId: 'src-' + id }));
  row('linked', target.id);
  row('other', other.id);
  const execution = (id: string) => {
    const r = one(store.db, rows.import_executions.pick({ order_id: true, document: true }), 'SELECT order_id,document FROM import_executions WHERE id=?', id);
    if (!r) throw new Error('测试数据：没有导入记录 ' + id);
    return { orderId: r.order_id, doc: parseStoredJson(markedReceipt, r.document, 'import_executions.document（' + id + '）') };
  };
  return { store, customer, target, other, execution };
}

/** 导入记录里删除测试要看的：永久删除时记下的是哪次删除、谁删的（别的键原样留着） */
const markedReceipt = z.looseObject({
  permanentDeletion: z.looseObject({ requestId: z.string(), actorId: z.string() }).optional(),
});

/** 把几张采购单合成一张订货单（各自原来的订货单里去掉它们），返回订货单编号 */
export function mergeIntoBatch(store: Store, supplierId: number, number: string, purchases: { id: number }[], date = '2026-11-01') {
  store.db.exec('DELETE FROM order_batch_purchases WHERE purchase_id IN (' + purchases.map((p) => p.id).join(',') + ')');
  const id = Number(
    store.db
      .prepare("INSERT INTO order_batches(number,supplier_id,order_date,actor_id,actor_name,created_at,updated_at) VALUES(?,?,?,'tester','虚构采购员','t','t')")
      .run(number, supplierId, date).lastInsertRowid,
  );
  for (const p of purchases) store.db.prepare('INSERT INTO order_batch_purchases(batch_id,purchase_id) VALUES(?,?)').run(id, p.id);
  return id;
}

/**
 * 删除窗口和助手卡片里的影响清单给人看的样子（src/recordkit/deletion-impact.ts）和库存说明（inventoryEffect）：
 * 一张采购单全部到货、到货的纸板又领了 10 张做成品，再加一张待送货的送货单。
 */
export function listingFixture() {
  const store = new Store(':memory:');
  const ops = new OperationsService(store),
    flow = new FlowService(store),
    service = new DatabaseMaintenanceService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构清单客户' }));
  const product = store.saveProduct(productSchema.parse({ name: '虚构清单产品' }));
  const supplier = ops.saveSupplier({ name: '虚构清单供应商' }, actor);
  const raw = ops.saveItem({ name: '虚构清单纸板', kind: 'raw', unit: '张' }, actor);
  const finished = ops.saveItem({ name: '虚构清单成品', kind: 'finished', unit: '只', productId: product.id }, actor);
  const buy = () =>
    ops.savePurchase(
      {
        supplierId: supplier.id,
        status: '已订货',
        orderDate: '2026-11-01',
        lines: [{ stockItemId: raw.id, name: raw.name, unit: '张', quantity: '1000', unitPrice: '1', priceBasis: 'quantity' }],
      },
      actor,
    );
  const purchase = buy();
  const confirm = (kind: FlowKind, input: Record<string, unknown>) => {
    const d = saveDoc(flow, kind, { date: '2026-11-07', ...input }, actor);
    return flow.confirm(d.id, { previewDigest: flow.preview(d.id, actor).previewDigest, requestId: randomUUID(), acknowledged: true }, actor);
  };
  confirm('arrival', {
    supplierId: supplier.id,
    reference: 'FICT-LIST-1',
    lines: [{ stockId: raw.id, purchaseLineId: purchase.lines[0].id, item: { name: raw.name, unit: '张' }, quantity: '1000', unitPrice: '1', priceBasis: 'quantity' }],
  });
  const task = saveDoc(flow, 'task', { date: '2026-11-07', productId: product.id, quantity: '100', unit: '只', orderIds: [] }, actor); // 安排生产即下达，没有核对这一步
  confirm('production', {
    taskId: task.id,
    productId: product.id,
    finishedStockId: finished.id,
    goodQuantity: '100',
    operator: '虚构员工',
    materials: [{ stockId: raw.id, issued: '10', returned: '0' }],
  });
  const order = store.saveOrder(
    orderSchema.parse({ customerId: customer.id, orderDate: '2026-11-01', deliveryDate: '2026-11-30', status: '已确认', lines: [{ productId: product.id, quantity: 100, unit: '只', unitPriceCents: 100 }] }),
  );
  const draft = saveDoc(flow, 
    'delivery',
    { date: '2026-11-08', plannedDate: '2026-11-08', customerId: customer.id, address: '', contact: '', phone: '', lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: finished.id, quantity: '10', notes: '' }], notes: '' },
    actor,
  );
  return { store, ops, service, supplier, raw, purchase, buy, draft, product };
}
