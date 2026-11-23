// 订单明细：保存时（server/sales/orders.ts）产品编号和产品名称要指同一个产品，名称、规格、备注原样存、没带的沿用；列表和详情里的显示。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BusinessRecords from '../src/records/BusinessRecords.js';
import OrderLinesView from '../src/recordkit/OrderLinesView.js';
import { productPrice } from '../src/records/PartyProductDetails.js';
import { Store } from '../server/core/index.js';
import { customerSchema, orderSchema, productSchema } from '../shared/core/domain.js';

test('明细换了产品：名称跟着新产品的档案走，不收补丁里带的旧名称；产品没换时照旧用给的名称', () => {
  const s = new Store(':memory:');
  try {
    const c = sales(s).createCustomer(customerSchema.parse({ name: '虚构客户' })),
      a = sales(s).createProduct(productSchema.parse({ name: '虚构箱A' })),
      b = sales(s).createProduct(productSchema.parse({ name: '虚构箱B' }));
    let order = sales(s).saveOrder(
      orderSchema.parse({
        customerId: c.id,
        orderDate: '2026-11-01',
        deliveryDate: '2026-11-20',
        status: '已确认',
        lines: [{ productId: a.id, productName: '客户叫法A', quantity: 100, unitPriceCents: 100 }],
      }),
    );
    assert.equal(order.lines[0].productName, '客户叫法A', '新建时给的名称照收');
    const lineId = order.lines[0].id;
    // 产品没换：给的名称照收
    order = sales(s).saveOrder(
      orderSchema.parse({ ...order, lines: [{ ...order.lines[0], productName: '客户新叫法A' }] }),
      order.id,
      order.version,
    );
    assert.equal(order.lines[0].productName, '客户新叫法A');
    assert.equal(order.lines[0].id, lineId, '没有关联单据也保留原明细编号');
    // 换成产品 B，补丁里还带着 A 的名称：名称改成 B 的档案名
    order = sales(s).saveOrder(
      orderSchema.parse({ ...order, lines: [{ ...order.lines[0], productId: b.id }] }),
      order.id,
      order.version,
    );
    assert.equal(order.lines[0].productId, b.id);
    assert.equal(order.lines[0].productName, '虚构箱B');
  } finally {
    s.close();
  }
});

test('订单拒收重复、外来明细编号，保存失败后原明细不变', () => {
  const s = new Store(':memory:');
  try {
    const c = sales(s).createCustomer(customerSchema.parse({ name: '虚构客户' }));
    const p = sales(s).createProduct(productSchema.parse({ name: '虚构纸箱' }));
    const input = orderSchema.parse({
      customerId: c.id, orderDate: '2026-10-01', deliveryDate: '2026-10-25', status: '已确认',
      lines: [{ productId: p.id, quantity: 10, unitPriceCents: 130 }],
    });
    const order = sales(s).saveOrder(input), other = sales(s).saveOrder(input);
    const line = order.lines[0], foreign = other.lines[0];
    const invalid = /明细编号重复或不属于当前订单/;
    assert.throws(() => sales(s).saveOrder({ ...input, lines: [foreign] }), invalid);
    for (const lines of [[line, line], [line, foreign]])
      assert.throws(() => sales(s).saveOrder({ ...input, lines }, order.id, order.version), invalid);
    assert.deepEqual(sales(s).order(order.id), order);
    assert.deepEqual(sales(s).orders().map((o) => o.id), [other.id, order.id]);
  } finally {
    s.close();
  }
});

test('明细的名称、规格、备注原样存回（长名称、多行）；改订单时这一行没带名称、备注就沿用原来的，带了空串的清空', () => {
  const s = new Store(':memory:');
  try {
    const c = sales(s).createCustomer(customerSchema.parse({ name: '虚构客户' })),
      p = sales(s).createProduct(productSchema.parse({ name: '档案通用名' }));
    const texts = { productName: '原订单存货名：加长纸箱' + '纸'.repeat(180), specification: '600 × 300 × 200 mm\n客户型号 ABC', notes: '每捆20只\n特殊说明：防潮包装' };
    let order = sales(s).saveOrder(
      orderSchema.parse({ customerId: c.id, orderDate: '2026-10-01', deliveryDate: '2026-10-25', status: '已确认', lines: [{ productId: p.id, quantity: 1000, unitPriceCents: 130, ...texts }] }),
    );
    const kept = () => [order.lines[0].productName, order.lines[0].specification, order.lines[0].notes];
    assert.deepEqual(kept(), [texts.productName, texts.specification, texts.notes]);
    // 助手、数据管理按补丁改明细时可能只带改了的栏：没带的沿用
    const { productName, notes, ...partial } = order.lines[0];
    order = sales(s).saveOrder(orderSchema.parse({ ...order, lines: [partial] }), order.id, order.version);
    assert.deepEqual(kept(), [texts.productName, texts.specification, texts.notes]);
    order = sales(s).saveOrder(orderSchema.parse({ ...order, lines: [{ ...order.lines[0], notes: '' }] }), order.id, order.version);
    assert.equal(order.lines[0].notes, '');
  } finally {
    s.close();
  }
});

test('订单明细的显示：列表只写首项和件数，详情逐行写规格和备注；单价按全站写法，产品参考单价没定过的不写 0', () => {
  const line = { id: 11, productId: 1, productName: '独立产品名', specification: '300×200mm', notes: '防潮包装', quantity: 10, unit: '只', unitPriceCents: 130, unitPriceExact: '1.3000', shippedQuantity: 0, remainingQuantity: 10, shippingStatus: '未发货' as const },
    row = {
      id: 1,
      version: 1,
      number: 'TEST-ORDER',
      customerName: '虚构客户',
      orderDate: '2026-10-25',
      deliveryDate: '2026-11-01',
      status: '待确认' as const,
      shippingProgress: '未发货' as const,
      shippingSummary: { progress: '未发货', completedLines: 0, totalLines: 2 },
      materialProgress: 'none' as const,
      totalCents: 2600,
      customerId: 1,
      notes: '',
      costs: null,
      costCents: null,
      createdAt: '2026-10-25T00:00:00Z',
      updatedAt: '2026-10-25T00:00:00Z',
      lines: [line, { ...line, id: 12, productName: '第二产品名' }],
    };
  const list = renderToStaticMarkup(createElement(BusinessRecords, { entity: 'orders', rows: [row], archived: false, edit: () => {}, changed: () => {} }));
  assert.match(list, /\+1/);
  assert.match(list, /第二产品名/);
  const html = renderToStaticMarkup(createElement(OrderLinesView, { row }));
  assert.match(html, /订单明细/);
  assert.match(html, /第二产品名/);
  assert.match(html, /防潮包装/);
  // 接口里的精确单价固定四位小数（1.3000），详情里至少两位，第三、四位的尾零去掉
  assert.match(html, /<small>1[.]30 元 · ¥13[.]00<[/]small>/);
  // 只有分、没有精确价的明细：250 分 → 2.50，不经过浮点除法
  const { unitPriceExact: _exact, ...centsOnly } = line;
  const centsHtml = renderToStaticMarkup(createElement(OrderLinesView, { row: { ...row, lines: [{ ...centsOnly, unitPriceCents: 250 }] } }));
  assert.match(centsHtml, /<small>2[.]50 元 · ¥/);
  assert.equal(productPrice({ priceExact: '2.7600' }), '2.76');
  assert.equal(productPrice({ priceCents: 250 }), '2.50');
  assert.equal(productPrice({ priceCents: 0 }), '', '没定过价的不写 0');
});
