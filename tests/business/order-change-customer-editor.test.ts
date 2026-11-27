// 订单编辑窗换客户（src/editors/order-customer-change.ts）：只在这张订单里下过单的原客户产品那一行留着，提示哪几个产品会一起改归新客户；
// 别的订单也用过的原客户产品照旧清空。只算数据；档案在内存库里建，虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sales } from '../../server/sales/index.js';
import { orderSchema } from '../../shared/core/index.js';
import { fillProduct, initialLines } from '../../src/editors/order-draft.js';
import { crossCustomerLine, customerChangeBlocked, keptLineProducts, movingNotice, pruneLinesForCustomer } from '../../src/editors/order-customer-change.js';
import { pageActor } from '../support/actor-fixture.js';
import { businessBase } from '../support/business-base-fixture.js';

/** 甲的一张订单：甲专用箱（只在这张单里）、甲常用箱（别的订单也用过）、通用周转箱；乙是要换过去的客户 */
function setup() {
  const base = businessBase(pageActor({ id: 'u1', name: '虚构业务员', permissions: ['business:edit'] }));
  const a = base.customer({ name: '虚构甲' }),
    b = base.customer({ name: '虚构乙' });
  const mine = base.product({ name: '甲专用箱', customerId: a.id }),
    shared = base.product({ name: '甲常用箱', customerId: a.id }),
    generic = base.product({ name: '通用周转箱' });
  const order = base.order(a, [base.line(mine, 100), base.line(shared, 100), base.line(generic, 100)]);
  sales(base.store).saveOrder(orderSchema.parse({ customerId: a.id, orderDate: '2026-11-01', deliveryDate: '2026-11-10', status: '已确认', lines: [base.line(shared, 50)] }));
  const products = sales(base.store).products();
  let n = 0;
  const rows = initialLines(order, undefined, products, () => 'k' + n++);
  base.store.close();
  return { a, b, mine, generic, order, products, rows };
}

const MOVING = '保存后，甲专用箱 的所属客户会一起改成 虚构乙（这些产品只在这张订单里下过单）。';

test('换给乙：只在这张订单里下过单的甲专用箱那行留着、提示一起改归乙；甲常用箱那行清空；通用的不动', () => {
  const { b, mine, generic, order, products, rows } = setup();
  const sole = new Set([mine.id, generic.id]);
  const kept = keptLineProducts(order, String(b.id), products, sole);
  assert.deepEqual([...kept], [[order.lines[0].id, mine.id]]);
  const { nextRows, notice } = pruneLinesForCustomer(rows, b.id, products, kept);
  assert.deepEqual(nextRows.map((l) => l.productId), [String(mine.id), '', String(generic.id)]);
  assert.equal(notice, '切换客户后已清空第 2 行（原产品属于其他客户），请重新选择产品。');
  assert.equal(movingNotice(nextRows, order, b, products, sole), MOVING);
  assert.equal(crossCustomerLine(nextRows[0], b.id, products, kept), false, '保存前核对不拦跟着走的行');
});

test('给清空的行重新选了产品以后，“会一起改归乙”那句照样按现在的明细算出来；跟着走的行删掉了就不再提', () => {
  const { b, mine, generic, order, products, rows } = setup();
  const sole = new Set([mine.id, generic.id]);
  const { nextRows } = pruneLinesForCustomer(rows, b.id, products, keptLineProducts(order, String(b.id), products, sole));
  const chosen = nextRows.map((l, i) => (i === 1 ? fillProduct(l, products.find((p) => p.id === generic.id), String(generic.id)) : l));
  assert.equal(movingNotice(chosen, order, b, products, sole), MOVING);
  assert.equal(movingNotice(chosen.slice(1), order, b, products, sole), '');
});

test('换回原客户：明细全留、没有提示', () => {
  const { a, mine, order, products, rows } = setup();
  const back = keptLineProducts(order, String(a.id), products, new Set());
  assert.deepEqual(pruneLinesForCustomer(rows, a.id, products, back), { nextRows: rows, notice: '' });
  assert.equal(movingNotice(rows, order, a, products, new Set([mine.id])), '');
});

test('编辑已有订单时，还没读到或读失败“只在这张订单里下过单”的产品就不让换客户：说明原因和怎么办；读到了、新建订单不拦', () => {
  assert.equal(customerChangeBlocked(true, { loading: true, error: '' }), '正在读这张订单的产品，读完才能换客户。');
  assert.equal(
    customerChangeBlocked(true, { loading: false, error: '服务器正忙，请稍后再试。' }),
    '没读到这张订单里哪些产品只在这张订单里下过单（服务器正忙，请稍后再试），先不能换客户：换了客户这些产品会一起改归新客户，要先看清是哪几个。请点“重试”。',
  );
  assert.equal(customerChangeBlocked(true, { loading: false, error: '' }), '');
  assert.equal(customerChangeBlocked(false, { loading: false, error: '' }), '');
});
