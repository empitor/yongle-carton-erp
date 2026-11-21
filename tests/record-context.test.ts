// 关联记录与修改历史（server/business/record-context.ts）：每类业务和单据列出哪些上下游、按顺序，归档的带标记；只按编号读。内存库、虚构数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperationsService } from '../server/operations/index.js';
import { FlowService } from '../server/flow/service.js';
import { recordContext } from '../server/business/record-context.js';
import { flowStatusText } from '../shared/business/index.js';
import { saveDoc } from './receive-fixture.js';
import type { FlowKind } from '../shared/business/index.js';
import { actor } from './actor-fixture.js';
import { businessBase } from './business-base-fixture.js';

/** 按编号读的参数：一个编号或一组编号，不给就是全部（照采购库存读库存品的参数） */
type RecordIds = Parameters<OperationsService['items']>[1];

function fixture() {
  const base = businessBase(actor), { store, ops, flow } = base;
  const customer = base.customer({ name: '虚构关联客户' });
  const product = base.product({ name: '虚构关联产品' });
  const supplier = base.supplier({ name: '虚构供应商甲' });
  const otherSupplier = base.supplier({ name: '虚构供应商乙' });
  const raw = base.raw({ name: '虚构原料' });
  const finished = base.finished(product);
  const orders = [1, 2].map((n) =>
    base.order(customer, [base.line(product, 100)], { number: '虚构关联单' + n, orderDate: '2026-11-01', deliveryDate: '2026-11-30' }),
  );
  const purchase = (supplierId: number, customerOrderId: number | null) => ops.savePurchase({
    supplierId, customerOrderId, orderDate: '2026-11-01', status: '已订货',
    lines: [{ stockItemId: raw.id, name: raw.name, unit: '张', quantity: '100', unitPrice: '1', priceBasis: 'quantity' }],
  }, actor);
  const purchases = [purchase(supplier.id, orders[0].id), purchase(supplier.id, null), purchase(otherSupplier.id, null)];
  const confirm = (kind: FlowKind, input: Record<string, unknown>) => base.check(saveDoc(flow, kind, { date: '2026-11-07', ...input }, actor));
  const arrival = confirm('arrival', { supplierId: supplier.id, reference: '虚构到货',
    lines: purchases.slice(0, 2).map((p) => ({ stockId: raw.id, purchaseLineId: p.lines[0].id,
      item: { name: raw.name, unit: '张' }, quantity: '10', unitPrice: '1', priceBasis: 'quantity' })),
  });
  // 安排生产即下达，没有核对这一步
  const task = saveDoc(flow, 'task', { date: '2026-11-07', productId: product.id, quantity: '100', unit: '只', orderIds: orders.map((o) => o.id) }, actor);
  const production = confirm('production', { taskId: task.id, productId: product.id,
    finishedStockId: finished.id, goodQuantity: '100', operator: '虚构员工', materials: [{ stockId: raw.id, issued: '1', returned: '0' }] });
  const delivery = confirm('delivery', { customerId: customer.id,
    lines: orders.map((o) => ({ orderId: o.id, orderLineId: o.lines[0].id, stockId: finished.id, quantity: '10' })) });
  return { store, ops, flow, customer, product, supplier, raw, finished, orders, purchases, arrival, task, production, delivery };
}

/** 关联记录写成“名字[:方向][:已归档]”：名字是这份虚构数据里的叫法，方向只写上游 */
function related(f: ReturnType<typeof fixture>, module: string, id: number) {
  const names = new Map<string, string>([
    ['customers:' + f.customer.id, 'customer'],
    ['products:' + f.product.id, 'product'],
    ['suppliers:' + f.supplier.id, 'supplier'],
    ['stock_items:' + f.raw.id, 'raw'],
    ['stock_items:' + f.finished.id, 'finished'],
    ...f.orders.map((o, i) => ['orders:' + o.id, 'order' + i] as [string, string]),
    ...f.purchases.map((p, i) => ['purchases:' + p.id, 'purchase' + i] as [string, string]),
    ...(['arrival', 'task', 'production', 'delivery'] as const).map((k) => [k + ':' + f[k].id, k] as [string, string]),
  ]);
  const ctx = recordContext(f.store, module, id, actor);
  return {
    related: ctx.related.map(
      (r) => (names.get(r.module + ':' + r.id) ?? r.module + '?') + (r.direction === 'upstream' ? ':upstream' : '') + (r.archived ? ':archived' : ''),
    ),
    history: ctx.history.map((h) => h.action),
    alternatives: ctx.alternatives.map((a) => String(names.get(a.module + ':' + a.id)) + ':' + a.action),
  };
}

/** 每类记录应该列出的关联记录（按顺序）和修改历史 */
const expected: Record<string, { related: string[]; history: string[] }> = {
  customers: { related: ['order1', 'order0', 'purchase0', 'delivery', 'production', 'task', 'arrival'], history: [] },
  products: { related: ['order1', 'order0', 'purchase0', 'delivery', 'production', 'task', 'arrival', 'finished'], history: [] },
  orders: { related: ['purchase0', 'delivery', 'production', 'task', 'arrival', 'order1'], history: [] },
  purchases: { related: ['arrival'], history: ['create'] },
  suppliers: { related: ['purchase1', 'purchase0', 'arrival'], history: ['create'] },
  stock_items: { related: ['purchase2', 'purchase1', 'purchase0', 'production', 'arrival'], history: ['create'] },
  arrival: { related: ['supplier:upstream', 'raw:upstream', 'purchase0:upstream', 'purchase1:upstream'], history: ['confirm', 'create-draft'] },
  task: { related: ['production', 'product:upstream', 'order0:upstream', 'order1:upstream'], history: ['issue-task'] },
  production: { related: ['product:upstream', 'finished:upstream', 'task:upstream', 'raw:upstream'], history: ['confirm', 'create-draft'] },
  delivery: {
    related: ['customer:upstream', 'order0:upstream', 'product:upstream', 'finished:upstream', 'order1:upstream'],
    history: ['confirm', 'create-draft'],
  },
};

test('关联记录：六类业务、四类单据各列出上下游（共享的订单都列），顺序固定；修改历史按新到旧；单据的替代做法是撤销；归档的带标记', () => {
  const f = fixture();
  try {
    const ids: Record<string, number> = {
      customers: f.customer.id, products: f.product.id, orders: f.orders[0].id, purchases: f.purchases[0].id, suppliers: f.supplier.id,
      stock_items: f.raw.id, arrival: f.arrival.id, task: f.task.id, production: f.production.id, delivery: f.delivery.id,
    };
    for (const [module, want] of Object.entries(expected)) {
      const got = related(f, module, ids[module]);
      assert.deepEqual({ related: got.related, history: got.history }, want, module);
      // 关联里的单据（上下游都算）都给“撤销”这条替代做法（都已核对）
      const flows = want.related.map((r) => r.split(':')[0]).filter((r) => /^(arrival|task|production|delivery)$/.test(r));
      assert.deepEqual(got.alternatives, flows.map((r) => r + ':reverse'), module);
    }
    f.store.db.prepare('INSERT INTO record_lifecycle(entity,record_id,archived_at,actor_id) VALUES(?,?,?,?)').run('flow_delivery', f.delivery.id, '虚构归档', actor.id);
    for (const [module, want] of Object.entries(expected))
      assert.deepEqual(related(f, module, ids[module]).related, want.related.map((r) => (r === 'delivery' ? 'delivery:archived' : r)), '含归档：' + module);
  } finally { f.store.close(); }
});

test('关联记录只按编号读，不装配全表；单条采购单、供应商的读取不解析别的采购单', (t) => {
  const f = fixture();
  try {
    const want = related(f, 'orders', f.orders[0].id);
    t.mock.method(f.store, 'orders', () => assert.fail('不应装配全表：orders'));
    // 采购、库存按编号读可以，不带编号就是读全表
    const { purchases, items } = OperationsService.prototype;
    t.mock.method(OperationsService.prototype, 'purchases', function (this: OperationsService, ...args: Parameters<OperationsService['purchases']>) {
      const [include, ids, suppliers, receivedOf] = args;
      // 按供应商读采购（第三个参数）也是定向读取；第四个参数是完整视图现算的已到货，原样转交
      if (ids === undefined && suppliers === undefined) assert.fail('不应装配全表：purchases');
      return purchases.call(this, include, ids, suppliers, receivedOf);
    });
    t.mock.method(OperationsService.prototype, 'items', function (this: OperationsService, include?: boolean, ids?: RecordIds) {
      if (ids === undefined) assert.fail('不应装配全表：items');
      return items.call(this, include, ids);
    });
    assert.deepEqual(related(f, 'orders', f.orders[0].id), want);
    const ops = new OperationsService(f.store),
      views = new FlowService(f.store).views;
    const purchase = views.purchases(true, f.purchases[0].id)[0];
    const supplier = ops.suppliers(true, f.supplier.id)[0];
    // 模拟与本次读取无关的坏明细：定向读取不得解析它。库里有约束不让写坏内容，这里临时关掉约束检查来造。
    f.store.db.exec('PRAGMA ignore_check_constraints=ON');
    f.store.db.prepare('UPDATE purchase_lines SET document=? WHERE purchase_id=?').run('not-json', f.purchases[2].id);
    f.store.db.exec('PRAGMA ignore_check_constraints=OFF');
    assert.deepEqual(views.purchases(true, f.purchases[0].id), [purchase]);
    assert.deepEqual(ops.suppliers(true, f.supplier.id), [supplier]);
    assert.deepEqual(views.purchases(true, []), []);
    assert.deepEqual(ops.suppliers(true, []), []);
  } finally { f.store.close(); }
});

test('关联记录给人看的说明不说开发口径；完工单上游的生产任务按已确认完工数显示（不是“待生产”）', () => {
  const f = fixture();
  try {
    for (const module of ['production', 'customers'] as const) {
      const ctx = recordContext(f.store, module, module === 'production' ? f.production.id : f.customer.id, actor);
      assert.doesNotMatch(ctx.archiveEffect, /数据库|物理删除|同步记录|校验/);
    }
    const ctx = recordContext(f.store, 'production', f.production.id, actor);
    const task = ctx.related.find((r) => r.module === 'task' && r.id === f.task.id);
    assert.equal(task?.direction, 'upstream');
    // 任务 100 只、完工单确认了 100 只：界面按 completed 叫“已完工”
    assert.equal(task.view.completed, '100');
    assert.equal(flowStatusText({ ...task, ...task.view, kind: 'task' }), '已完工');
  } finally {
    f.store.close();
  }
});
