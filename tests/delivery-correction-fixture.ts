// 更正送货单测试的底子（delivery-correction*.test.ts）：内存库、虚构数据。
// 一个客户、一个产品（成品库存期初 stock 只），订单 A 两行同一个产品（各 1000 只），订单 B 一行（1000 只，下单晚 19 天）。
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { Actor } from '../server/core/auth.js';
import { correctDocument, planCorrection } from '../server/flow/correction.js';
import { viewOfKind } from '../server/flow/read.js';
import { clerk } from './flow-fixture.js';
import { businessBase } from './business-base-fixture.js';
import { ofKind } from './receive-fixture.js';
import { deliveryCorrectionPreviewSchema } from '../shared/business/index.js';
import type { z } from 'zod';

/** 订单：编号和各行编号（送哪一行、读哪一行的已发） */
type OrderRef = { id: number; lines: { id: number }[] };
/** 送货更正的一行（deliveryCorrectionPreviewSchema 收的样子） */
type CorrectionLine = z.input<typeof deliveryCorrectionPreviewSchema>['lines'][number];

export function deliveryCorrectionSetup(t: TestContext, stock = '1000') {
  const base = businessBase(clerk),
    { store, ops, flow } = base;
  t.after(() => store.close());
  const customer = base.customer();
  const product = base.product({ name: '虚构外箱' });
  const line = base.line(product, 1000, { productName: product.name });
  const order = base.order(customer, [line, line], { deliveryDate: '2026-12-30' });
  const second = base.order(customer, [line], { orderDate: '2026-10-20', deliveryDate: '2026-12-30' });
  const item = base.finished(product, { name: '虚构外箱' }, { quantity: stock, date: '2026-10-01' });
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
    return viewOfKind(base.check(d, { shipDate: date }, who), 'delivery');
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
