// 送货出库、送达的测试共用（delivery-shipping、delivery-ship-date）：内存库、虚构数据，测试结束自动关库。
import type { TestContext } from 'node:test';
import { viewOfKind } from '../server/flow/read.js';
import { BusinessDocuments } from '../server/documents/service.js';
import { today } from '../shared/core/domain.js';
import { businessBase } from './business-base-fixture.js';
import type { Actor } from '../server/core/auth.js';
import { actor } from './actor-fixture.js';

/** 按北京时间算的相对日期 */
export const shift = (days: number) => {
  const d = new Date(today() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * 一张虚构订单 1000 只（下单日期 400 天前，补录前几天、几个月前的出库日都不早于它），成品库存 stock 只，
 * 一张待送货的送货单 delivery 600 只。arrange(日期, 数量) 再安排一张；ship(编号, 别的字段) 核对出库。
 */
export function deliverySetup(t: TestContext, stock = '1000') {
  const base = businessBase(actor),
    { store, ops, flow } = base,
    docs = new BusinessDocuments(store, async () => Buffer.from('虚构送货单文件'));
  t.after(() => store.close());
  const customer = base.customer({ name: '虚构测试客户' });
  const product = base.product({ name: '虚构外箱' });
  const order = base.order(customer, [base.line(product, 1000, { productName: product.name })], { orderDate: shift(-400), deliveryDate: '2026-11-20' });
  const item = base.finished(product, { name: '虚构外箱' }, { quantity: stock, date: '2026-11-09' });
  const arrange = (date: string, quantity: string, extra: Record<string, unknown> = {}, who: Actor = actor) =>
    flow.save(
      'delivery',
      { date, plannedDate: date, customerId: customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: item.id, quantity }], ...extra },
      who,
    );
  const ship = (id: number, extra: Record<string, unknown> = {}, who: Actor = actor) =>
    viewOfKind(base.check({ id }, extra, who), 'delivery');
  const delivery = arrange('2026-11-10', '600');
  const balance = () => ops.repo.items(true, item.id)[0].balanceUnits;
  return { store, ops, flow, docs, order, item, delivery, arrange, ship, balance };
}
