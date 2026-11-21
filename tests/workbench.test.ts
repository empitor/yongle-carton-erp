// 工作台和今日队列（server/business/workbench.ts）：读真实待办、跨日计划和当日实绩，把订单、采购分到逾期、未排产、
// 待下单、到货待登记；有客户料号的纸箱从完工到部分送货走一遍。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { OperationsService } from '../server/operations/service.js';
import { OperationsRepository } from '../server/operations/repository.js';
import { OrderBatchService } from '../server/operations/batches.js';
import { ManualProductionCompletion } from '../server/flow/production-completion.js';
import { WarehouseDaily } from '../server/flow/daily.js';
import { registerArrival } from '../server/flow/register-arrival.js';
import { buildWorkbench, buildToday } from '../server/business/workbench.js';
import { relatedBusiness } from '../server/business/related-business.js';
import { customerSchema, orderSchema, productSchema, specification } from '../shared/core/domain.js';
import { deliveryCandidates } from '../shared/business/warehouse-delivery.js';
import { workbenchFixture } from './flow-fixture.js';
import { shipOnDocDate } from './ship-date.js';
import { actor } from './actor-fixture.js';

const date = '2026-10-29';

test('工作台读取真实待办、跨日计划与当日实绩，读取及登记待入库的到货不会增加库存', () => {
  const f = workbenchFixture(actor);
  try {
    assert.equal(buildWorkbench(f.store, date).toOrder, 1);
    const ordered = f.ops.savePurchase({ ...f.purchase, version: f.purchase.version, status: '已订货' }, actor, f.purchase.id);
    // 改成已订货时自动建好订货单；按它登记一张待入库的到货（AI 识别送货单那样，还没核对）
    const batches = new OrderBatchService(f.store);
    const batchId = batches.batchIdOf(ordered.id);
    assert.ok(batchId);
    const batch = batches.view(batchId);
    const pending = registerArrival(
      f.store,
      { batchId: batch.id },
      {
        expectedVersion: batch.version,
        requestId: randomUUID(),
        date: '2026-11-02',
        reference: '虚构送货单-待核对',
        pending: true,
        rows: [{ key: batch.rows[0].key, quantity: '500' }],
      },
      actor,
    );
    const before = f.ops.repo.balance(f.raw.id),
      work = buildWorkbench(f.store, date);
    assert.deepEqual(
      [work.toOrder, work.pendingArrivals, work.arrivalsToday, work.activeTasks, work.tasksToday, work.productionToday],
      [0, 1, 0, 1, 0, 0],
    );
    assert.equal(new WarehouseDaily(f.store).get({ kind: 'arrival', date }).records.length, 0);
    assert.equal(new WarehouseDaily(f.store).get({ kind: 'arrival', date, scope: 'all' }).records.length, 1);
    const purchase = relatedBusiness(f.store, 'purchases', f.purchase.id);
    assert.ok(purchase);
    assert.equal(purchase.arrivals[0].flowId, pending.arrival.id);
    assert.equal(f.ops.repo.balance(f.raw.id), before);
    const sales = relatedBusiness(f.store, 'orders', f.order.id);
    assert.ok(sales);
    assert.equal(sales.tasks[0].id, f.task.id);
    assert.equal(sales.purchases[0].id, f.purchase.id);
    assert.equal(sales.deliveries.length, 0);
  } finally {
    f.store.close();
  }
});

test('今日队列把真实记录分到逾期、未排产、待下单和到货待登记', () => {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构箱' }));
  try {
    const order = (deliveryDate: string, status = '已确认') =>
      store.saveOrder(
        orderSchema.parse({
          customerId: customer.id,
          orderDate: '2026-10-01',
          deliveryDate,
          status,
          lines: [{ productId: product.id, quantity: 100, unit: '只', unitPriceCents: 100 }],
        }),
      );
    const late = order('2026-11-01'),
      upcoming = order('2026-12-01');
    order('2026-11-01', '待确认');
    const supplier = ops.saveSupplier({ name: '虚构供应商' }, actor);
    const purchase = (status: string, expectedDate: string) =>
      ops.savePurchase(
        {
          supplierId: supplier.id,
          customerOrderId: upcoming.id,
          orderDate: '2026-10-01',
          expectedDate,
          status,
          lines: [{ name: '虚构纸板', length: 1000, width: 800, dimensionUnit: 'mm', unit: '张', quantity: '100', unitPrice: '1.5', priceBasis: 'quantity' }],
        },
        actor,
      );
    const toOrder = purchase('待订货', '2026-12-01'),
      due = purchase('已订货', '2026-11-03'),
      dueToday = purchase('已订货', '2026-11-05');
    purchase('已订货', '2026-12-01');
    const today = buildToday(store, '2026-11-05');
    assert.deepEqual(today.overdue.map((o) => [o.id, o.lateDays]), [[late.id, 4]]);
    // 已逾期的不重复出现在未排产里，待确认不算待办。
    assert.deepEqual(today.unscheduled.map((o) => o.id), [upcoming.id]);
    assert.deepEqual(today.toOrder.map((p) => p.id), [toOrder.id]);
    assert.deepEqual(today.arrivalsDue.map((p) => p.id), [due.id, dueToday.id]);
    // 今天要到：按订货单的到货安排，截止日是今天的和逾期没到齐的都列，逾期的排在前面并标明
    const batchOf = (id: number) => new OrderBatchService(store).batchIdOf(id);
    assert.deepEqual(
      today.schedule.arrivals.map((a) => [a.batchId, a.overdue, a.label]),
      [
        [batchOf(due.id), true, '逾期 虚构供应商 虚构纸板 还差 100 张（2026-11-03 前该到）'],
        [batchOf(dueToday.id), false, '虚构供应商 虚构纸板 还差 100 张'],
      ],
    );
    const upcomingOrder = store.order(upcoming.id), lateOrder = store.order(late.id);
    assert.ok(upcomingOrder);
    assert.ok(lateOrder);
    assert.equal(upcomingOrder.materialProgress, 'pending');
    assert.equal(lateOrder.materialProgress, 'none');
  } finally {
    store.close();
  }
});

test('有客户料号的纸箱从整批完工到部分送货：成品规格按产品、不混进料号，工作台当日实绩跟着变', () => {
  const f = workbenchFixture(actor);
  try {
    const completion = new ManualProductionCompletion(f.store),
      input = {
        requestId: randomUUID(),
        taskIds: [f.task.id],
        date,
        operator: '虚构生产员工',
        allocation: 'shared-proportional',
        materials: [{ stockId: f.raw.id, unit: '张', issued: '5', returned: '0' }],
        quantities: [{ taskId: f.task.id, goodQuantity: '100', scrapQuantity: '0' }],
      };
    completion.execute({ input, previewDigest: completion.preview(input, actor).previewDigest }, actor);
    const stock = new OperationsRepository(f.store).items().find((s) => s.kind === 'finished');
    assert.ok(stock);
    assert.equal(stock.specification, specification(f.product));
    assert.notEqual(stock.specification, '000123');
    assert.equal(deliveryCandidates(stock, f.customer.id, f.store.orders()).length, 1);
    const doc = f.flow.save(
      'delivery',
      { date, customerId: f.customer.id, lines: [{ stockId: stock.id, orderId: f.order.id, orderLineId: f.order.lines[0].id, quantity: '40' }] },
      actor,
    );
    const p = f.flow.preview(doc.id, actor);
    f.flow.confirm(doc.id, { previewDigest: p.previewDigest, requestId: randomUUID(), acknowledged: true, ...shipOnDocDate(f.flow, doc.id) }, actor);
    assert.equal(f.ops.repo.balance(stock.id), 60000);
    assert.equal(f.store.orders()[0].shippingProgress, '部分发货');
    const work = buildWorkbench(f.store, date);
    assert.deepEqual([work.activeTasks, work.productionToday, work.deliveriesToday], [0, 1, 1]);
  } finally {
    f.store.close();
  }
});
