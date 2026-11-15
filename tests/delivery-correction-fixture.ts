// 更正送货单测试的底子（delivery-correction*.test.ts）：内存库、虚构数据。
// 一个客户、一个产品（成品库存期初 stock 只），订单 A 两行同一个产品（各 1000 只），订单 B 一行（1000 只，下单晚 19 天）。
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { Store } from '../server/core/db.js';
import type { Actor } from '../server/core/auth.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { correctDocument, planCorrection } from '../server/flow/correction.js';
import { viewOfKind } from '../server/flow/read.js';
import { customerSchema, orderSchema, productSchema } from '../shared/core/domain.js';
import { clerk } from './flow-fixture.js';
import { ofKind } from './receive-fixture.js';
import { deliveryCorrectionPreviewSchema } from '../shared/business/index.js';
import type { z } from 'zod';

/** 订单：编号和各行编号（送哪一行、读哪一行的已发） */
type OrderRef = { id: number; lines: { id: number }[] };
/** 送货更正的一行（deliveryCorrectionPreviewSchema 收的样子） */
type CorrectionLine = z.input<typeof deliveryCorrectionPreviewSchema>['lines'][number];

export function deliveryCorrectionSetup(t: TestContext, stock = '1000') {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  t.after(() => store.close());
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' }));
  const product = store.saveProduct(productSchema.parse({ name: '虚构外箱' }));
  const line = { productId: product.id, productName: product.name, quantity: 1000, unit: '只', unitPriceCents: 100 };
  const order = store.saveOrder(
    orderSchema.parse({ customerId: customer.id, orderDate: '2026-10-01', deliveryDate: '2026-12-30', status: '已确认', lines: [line, line] }),
  );
  const second = store.saveOrder(
    orderSchema.parse({ customerId: customer.id, orderDate: '2026-10-20', deliveryDate: '2026-12-30', status: '已确认', lines: [line] }),
  );
  const item = ops.saveItem({ name: '虚构外箱', kind: 'finished', unit: '只', productId: product.id }, clerk);
  ops.move(item.id, { action: 'in', quantity: stock, date: '2026-10-01', notes: '虚构期初', acknowledged: true, requestId: randomUUID(), expectedVersion: item.version }, clerk);
  /** 安排并出库一张送货单：lines 每项是 [订单, 第几行, 数量] */
  const ship = (lines: [OrderRef, number, string][], date = '2026-11-02', who: Actor = clerk) => {
    const d = flow.save(
      'delivery',
      {
        date,
        plannedDate: date,
        customerId: customer.id,
        lines: lines.map(([o, i, quantity]) => ({ orderId: o.id, orderLineId: o.lines[i].id, stockId: item.id, quantity })),
      },
      who,
    );
    return viewOfKind(flow.confirm(d.id, { previewDigest: flow.preview(d.id, who).previewDigest, requestId: randomUUID(), acknowledged: true, shipDate: date }, who), 'delivery');
  };
  const input = (id: number, lines: CorrectionLine[], extra: Record<string, unknown> = {}) => ({
    expectedVersion: flow.get(id).version,
    reason: '虚构：点错数量',
    lines,
    ...extra,
  });
  const preview = (id: number, lines: CorrectionLine[], who: Actor = clerk, extra: Record<string, unknown> = {}) =>
    ofKind(planCorrection(store, id, input(id, lines, extra), who), 'delivery');
  const correct = (id: number, lines: CorrectionLine[], who: Actor = clerk, extra: Record<string, unknown> = {}) => {
    const v = input(id, lines, extra),
      plan = planCorrection(store, id, v, who);
    return ofKind(correctDocument(store, id, { ...v, previewDigest: plan.previewDigest, requestId: randomUUID() }, who), 'delivery');
  };
  const balance = () => ops.repo.balance(item.id);
  /** 某条订单明细的已发（只） */
  const shipped = (o: { id: number }, i: number) => {
    const current = store.order(o.id, true);
    if (!current) throw new Error('测试数据：没有订单 ' + o.id);
    return current.lines[i].shippedQuantity;
  };
  const moves = () =>
    store.db
      .prepare('SELECT id,source_kind,source_id,delta_units,date,notes FROM stock_movements ORDER BY rowid')
      .all()
      .map((m) => ({ ...m }));
  return { store, ops, flow, customer, product, order, second, item, ship, input, preview, correct, balance, shipped, moves };
}
