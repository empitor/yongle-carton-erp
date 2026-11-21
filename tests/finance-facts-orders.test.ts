// 财务从业务拿数据的只读窗口（server/flow/finance-facts/）：订单一组的口径，月度台账的“接单”按它算。
// 全部是虚构数据，只用内存库。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { financeFacts } from '../server/flow/index.js';
import { actor } from './actor-fixture.js';
import { businessBase } from './business-base-fixture.js';

test('一段时间里接的订单：按下单日期含两头，待确认、已取消的不算，已归档的照样算', () => {
  const base = businessBase(actor);
  const customer = base.customer({ name: '虚构客户甲' }),
    product = base.product();
  const order = (orderDate: string, status = '已确认') => base.order(customer, [base.line(product, 10)], { orderDate, deliveryDate: '2026-12-30', status });
  const first = order('2026-10-01'),
    last = order('2026-10-31'),
    archived = order('2026-10-15');
  order('2026-10-05', '待确认');
  order('2026-10-06', '已取消');
  order('2026-09-30');
  order('2026-11-01');
  base.store.markArchived('orders', archived.id, actor.id);
  const found = financeFacts.orders.between(base.store.db, '2026-10-01', '2026-10-31');
  assert.deepEqual(
    found.map((o) => [o.id, o.order_date, o.status]),
    [
      [first.id, '2026-10-01', '已确认'],
      [last.id, '2026-10-31', '已确认'],
      [archived.id, '2026-10-15', '已确认'],
    ],
  );
  assert.deepEqual(found[0], {
    id: first.id,
    number: first.number,
    order_date: '2026-10-01',
    customer_name: '虚构客户甲',
    total_cents: first.totalCents,
    status: '已确认',
  });
});
