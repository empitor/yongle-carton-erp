// 数据管理改价：只改“分”时新价格生效、精确价不盖掉；清空精确价；改数量同时改价；没定价的产品；改价规则直接调用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productSchema, orderSchema } from '../shared/core/domain.js';
import { editableInput } from '../src/admin/record-input.js';
import { basics, command, firstResult } from './data-management-fixture.js';
import { z } from 'zod';
import { must } from './read-result.js';

type Basics = ReturnType<typeof basics>;
function findRecord<T extends { record: { id: number } }>(records: readonly T[], id: number): T {
  return must(records.find((r) => r.record.id === id), '记录 ' + id);
}
const productInput = (f: Basics, id: number) =>
  structuredClone(findRecord(f.service.list('products', f.who).records, id).input);
const orderInput = (f: Basics, id: number) =>
  structuredClone(findRecord(f.service.list('orders', f.who).records, id).input);

/** 列表给的内容经过一次 JSON 来回（页面收到的就是这样：值是 undefined 的字段不带） */
const viaJson = (value: unknown) => z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)));

test('管理员直接编辑产品只改“分”：新价格生效，原来的四位精确价不会把它盖掉', () => {
  const f = basics();
  try {
    let product = f.store.saveProduct(productSchema.parse({ name: '虚构改价纸箱', priceExact: '1.2345' }));
    const price = () => {
      product = must(f.store.product(product.id), '产品');
      return [product.priceCents, product.priceExact];
    };
    f.service.execute(command('products', 'update', [product], { priceCents: 200 }), f.who, 's');
    assert.deepEqual(price(), [200, '2.0000']);
    // 点名改精确价的以精确价为准；别的字段的补丁不动价格；分改成 0 就是没定价
    f.service.execute(command('products', 'update', [product], { priceExact: '1.2345' }), f.who, 's');
    assert.deepEqual(price(), [123, '1.2345']);
    f.service.execute(command('products', 'update', [product], { material: '牛卡' }), f.who, 's');
    assert.deepEqual([...price(), product.material], [123, '1.2345', '牛卡']);
    f.service.execute(command('products', 'update', [product], { priceCents: 0 }), f.who, 's');
    assert.deepEqual(price(), [0, undefined]);
  } finally {
    f.store.close();
  }
});

function verifyWholeProductPricing(f: Basics) {
  let product = f.store.saveProduct(productSchema.parse({ name: '虚构整条改价纸箱', priceExact: '1.2345' }));
  const price = () => {
    product = must(f.store.product(product.id), '产品');
    return [product.priceCents, product.priceExact];
  };
  f.service.execute(command('products', 'update', [product], { ...productInput(f, product.id), priceCents: 200 }), f.who, 's');
  assert.deepEqual(price(), [200, '2.0000'], '精确价没动、分改了：按分存');
  f.service.execute(command('products', 'update', [product], { ...productInput(f, product.id), priceExact: '1.2345' }), f.who, 's');
  assert.deepEqual(price(), [123, '1.2345'], '分没动、精确价改了：按精确价存');
  f.service.execute(command('products', 'update', [product], { ...productInput(f, product.id), name: '虚构整条改名纸箱' }), f.who, 's');
  assert.deepEqual([...price(), product.name], [123, '1.2345', '虚构整条改名纸箱'], '都没动：价格不变');
  // 分和精确价都改了又对不上：拒收，价格不动
  assert.throws(
    () =>
      f.service.execute(
        command('products', 'update', [product], { ...productInput(f, product.id), priceCents: 999, priceExact: '4' }),
        f.who,
        's',
      ),
    /参考单价：“分”填的是 999，精确价填的是 4 元，两个对不上。请只填一个，或改成一致的值。/,
  );
  assert.deepEqual(price(), [123, '1.2345']);
  f.service.execute(command('products', 'update', [product], { ...productInput(f, product.id), priceCents: 0 }), f.who, 's');
  assert.deepEqual(price(), [0, undefined], '分改成 0、精确价没动：没定价');
}

function verifyWholeOrderPricing(f: Basics) {
  let order = must(f.store.order(f.order.id, true), '订单');
  assert.deepEqual([order.lines[0].unitPriceCents, order.lines[0].unitPriceExact, order.totalCents], [123, '1.2300', 12300]);
  const whole = orderInput(f, order.id);
  whole.lines[0].unitPriceCents = 250;
  f.service.execute(command('orders', 'update', [order], whole), f.who, 's');
  order = must(f.store.order(order.id, true), '订单');
  assert.deepEqual(
    [order.lines[0].unitPriceCents, order.lines[0].unitPriceExact, order.totalCents, order.totalAmountExact],
    [250, '2.5000', 25000, '250.0000'],
  );
  // 只点名 lines 的补丁、整行带回来改分，也一样
  f.service.execute(
    command('orders', 'update', [order], { lines: [{ ...orderInput(f, order.id).lines[0], unitPriceCents: 300 }] }),
    f.who,
    's',
  );
  order = must(f.store.order(order.id, true), '订单');
  assert.deepEqual([order.lines[0].unitPriceCents, order.lines[0].unitPriceExact, order.totalCents], [300, '3.0000', 30000]);
  // 精确价改了、分还是原来的：按精确价存
  f.service.execute(
    command('orders', 'update', [order], {
      lines: [{ ...orderInput(f, order.id).lines[0], unitPriceExact: '1.2345' }],
      roundingPolicy: 'half-up-cent',
    }),
    f.who,
    's',
  );
  order = must(f.store.order(order.id, true), '订单');
  assert.deepEqual([order.lines[0].unitPriceCents, order.lines[0].unitPriceExact, order.totalAmountExact], [123, '1.2345', '123.4500']);
  // 新建订单用模板里的明细，只填“单价（分）”：按分存，不会被模板里预填的精确价盖成 0 元
  const template = f.service.list('orders', f.who).template;
  const created = f.service.execute(
    command('orders', 'create', [], {
      ...template,
      customerId: f.customer.id,
      deliveryDate: '2026-12-31',
      lines: [{ ...template.lines[0], productId: f.product.id, productName: f.product.name, quantity: 10, unitPriceCents: 150 }],
    }),
    f.who,
    's',
  );
  assert.deepEqual(
    [firstResult(created).lines[0].unitPriceCents, firstResult(created).lines[0].unitPriceExact, firstResult(created).totalCents],
    [150, '1.5000', 1500],
  );
  // 新建时两个都填了又对不上：拒收，订单没建出来；整张订单带回来两头都改了又对不上也拒收
  const count = f.store.orders(true).length;
  const mismatched = { ...template.lines[0], productId: f.product.id, productName: f.product.name, quantity: 10, unitPriceCents: 150, unitPriceExact: '2' };
  assert.throws(
    () => f.service.execute(command('orders', 'create', [], { ...template, customerId: f.customer.id, deliveryDate: '2026-12-31', lines: [mismatched] }), f.who, 's'),
    /“虚构开发纸箱”的单价：“分”填的是 150，精确价填的是 2 元，两个对不上/,
  );
  assert.equal(f.store.orders(true).length, count);
  const both = orderInput(f, order.id);
  both.lines[0].unitPriceCents = 999;
  both.lines[0].unitPriceExact = '4';
  assert.throws(() => f.service.execute(command('orders', 'update', [order], both), f.who, 's'), /两个对不上/);
  assert.equal(must(f.store.order(order.id, true), '订单').lines[0].unitPriceExact, '1.2345');
}

test('数据管理单条编辑是整条记录带回来：只改了“分”，新价格照样生效（产品和订单明细）', () => {
  const f = basics();
  try {
    // 单条编辑窗提交的就是列表给的那份 input 改完以后的样子，分和精确价都在里面
    verifyWholeProductPricing(f);
    // 订单明细：整张订单带回来，只把第一行的分从 123 改成 250
    verifyWholeOrderPricing(f);
  } finally {
    f.store.close();
  }
});
test('数据管理只清空精确价：产品存成没定价（不是 0 元）；订单明细单价必填，拒收并提示填写单价；清空了又改了分的按分存', () => {
  const f = basics();
  try {
    let n = 0;
    const fresh = () => f.store.saveProduct(productSchema.parse({ name: '虚构清价纸箱' + ++n, priceExact: '1.2345' }));
    const price = (id: number) => {
      const p = must(f.store.product(id), '产品');
      return [p.priceCents, p.priceExact];
    };
    const clears: [string, (x: object, key: string) => void][] = [
      ['删掉精确价这个键', (x, key) => Reflect.deleteProperty(x, key)],
      ['改成空串', (x, key) => Object.assign(x, { [key]: '' })],
      ['改成 null', (x, key) => Object.assign(x, { [key]: null })],
    ];
    // 整条带回来，分没动
    for (const [name, clear] of clears) {
      const p = fresh(),
        whole = productInput(f, p.id);
      clear(whole, 'priceExact');
      f.service.execute(command('products', 'update', [p], whole), f.who, 's');
      assert.deepEqual(price(p.id), [0, undefined], name + '：清空价格，存成没定价');
    }
    // 只带改的字段：点名 null 是清空；没点名精确价不算清空
    let p = fresh();
    f.service.execute(command('products', 'update', [p], { priceExact: null }), f.who, 's');
    assert.deepEqual(price(p.id), [0, undefined]);
    p = fresh();
    f.service.execute(command('products', 'update', [p], { material: '虚构牛卡' }), f.who, 's');
    assert.deepEqual(price(p.id), [123, '1.2345']);
    // 精确价清空、分也改了：按分存；分改成 0：没定价
    p = fresh();
    f.service.execute(command('products', 'update', [p], { ...productInput(f, p.id), priceExact: '', priceCents: 250 }), f.who, 's');
    assert.deepEqual(price(p.id), [250, '2.5000']);
    p = fresh();
    f.service.execute(command('products', 'update', [p], { ...productInput(f, p.id), priceExact: null, priceCents: 0 }), f.who, 's');
    assert.deepEqual(price(p.id), [0, undefined]);
    // 定成 0 元的产品清空精确价：没定价
    p = f.store.saveProduct(productSchema.parse({ name: '虚构零元纸箱', priceExact: '0' }));
    assert.deepEqual(price(p.id), [0, '0.0000']);
    f.service.execute(command('products', 'update', [p], { ...productInput(f, p.id), priceExact: '' }), f.who, 's');
    assert.deepEqual(price(p.id), [0, undefined]);

    // 订单明细：清空精确价、分没动，拒收，单价不动
    let order = must(f.store.order(f.order.id, true), '订单');
    for (const [name, clear] of clears) {
      const whole = orderInput(f, order.id);
      clear(whole.lines[0], 'unitPriceExact');
      assert.throws(
        () => f.service.execute(command('orders', 'update', [order], whole), f.who, 's'),
        /第1项“虚构开发纸箱”：请填写单价/,
        name,
      );
    }
    assert.equal(must(f.store.order(order.id, true), '订单').lines[0].unitPriceExact, '1.2300');
    // 清空精确价、分改了：按分存
    const whole = orderInput(f, order.id);
    whole.lines[0].unitPriceExact = '';
    whole.lines[0].unitPriceCents = 200;
    f.service.execute(command('orders', 'update', [order], whole), f.who, 's');
    order = must(f.store.order(order.id, true), '订单');
    assert.deepEqual([order.lines[0].unitPriceCents, order.lines[0].unitPriceExact, order.totalCents], [200, '2.0000', 20000]);
    // “分”清空：请填写单价
    const noCents = orderInput(f, order.id);
    Object.assign(noCents.lines[0], { unitPriceCents: null });
    assert.throws(() => f.service.execute(command('orders', 'update', [order], noCents), f.who, 's'), /请填写单价/);
    assert.equal(must(f.store.order(order.id, true), '订单').lines[0].unitPriceExact, '2.0000');
  } finally {
    f.store.close();
  }
});
test('数据管理同时改明细数量和“分”、精确价原样带回：按分存，不足一分的尾数按实际要存的价格算，不误拦', () => {
  const f = basics();
  try {
    // 1.2345 × 100 = 123.45 元，精确到分，不用整单舍入
    let order = f.store.saveOrder(
      orderSchema.parse({
        customerId: f.customer.id,
        orderDate: '2026-10-01',
        deliveryDate: '2026-10-27',
        status: '已确认',
        lines: [{ productId: f.product.id, quantity: 100, unitPriceCents: 123, unitPriceExact: '1.2345' }],
      }),
    );
    assert.equal(order.totalAmountExact, '123.4500');
    // 数量改成 3、分改成 150：按 3 × 1.2345 算会有尾数，但要存的是 1.50，合计 4.50 元
    const whole = orderInput(f, order.id);
    whole.lines[0].quantity = 3;
    whole.lines[0].unitPriceCents = 150;
    f.service.execute(command('orders', 'update', [order], whole), f.who, 's');
    order = must(f.store.order(order.id, true), '订单');
    assert.deepEqual(
      [order.lines[0].quantity, order.lines[0].unitPriceCents, order.lines[0].unitPriceExact, order.totalCents, order.totalAmountExact],
      [3, 150, '1.5000', 450, '4.5000'],
    );
    assert.equal(order.roundingPolicy, undefined, '没被逼着改成整单四舍五入');
    // 真有尾数的（改精确价）照样要明确结算规则
    const fractional = orderInput(f, order.id);
    fractional.lines[0].unitPriceExact = '1.2345';
    assert.throws(() => f.service.execute(command('orders', 'update', [order], fractional), f.who, 's'), /不足一分的尾数/);
  } finally {
    f.store.close();
  }
});

test('数据管理里没定价的产品：编辑窗也有空的“精确价格”，只填它就定价；空着保存还是没定价', () => {
  const f = basics();
  try {
    const record = (id: number) => findRecord(f.service.list('products', f.who).records, id);
    let p = must(f.store.product(f.product.id), '产品');
    assert.equal(p.priceExact, undefined, '夹具里的产品没定价');
    // 编辑窗给的内容：列表给的 input 里没有精确价，editableInput 补一个空的，排在“价格（分）”后面
    const shown = editableInput('products', viaJson(record(p.id).input));
    assert.equal(shown.priceExact, '');
    const order = Object.keys(shown);
    assert.equal(order.indexOf('priceExact'), order.indexOf('priceCents') + 1);
    assert.equal(editableInput('orders', { customerId: 1 }).priceExact, undefined, '别的模块不加');
    // 空着保存：还是没定价
    f.service.execute(command('products', 'update', [p], shown), f.who, 's');
    p = must(f.store.product(p.id), '产品');
    assert.deepEqual([p.priceCents, p.priceExact], [0, undefined]);
    // 只填精确价格：定价
    const again = editableInput('products', viaJson(record(p.id).input));
    f.service.execute(command('products', 'update', [p], { ...again, priceExact: '1.2345' }), f.who, 's');
    p = must(f.store.product(p.id), '产品');
    assert.deepEqual([p.priceCents, p.priceExact], [123, '1.2345']);
    // 新建模板里也有空的精确价格：只填它就定价
    const template = f.service.list('products', f.who).template;
    assert.equal(template.priceExact, '');
    const created = f.service.execute(command('products', 'create', [], { ...template, name: '虚构新建定价纸箱', priceExact: '2.5' }), f.who, 's');
    assert.deepEqual([firstResult(created).priceCents, firstResult(created).priceExact], [250, '2.5000']);
  } finally {
    f.store.close();
  }
});

test('数据管理改价规则直接调用：整条带回只少一个键算点名清空；订单明细单价清空拒收、按分存去掉旧精确价；校验没过说成中文整句', async () => {
  const { wholeRecordWithout, orderLinesPriceEdit, readableIssues } = await import('../server/admin/record-edit-rules.js');
  // 整条带回来、唯独少了 priceExact：点名清空；只带改的字段的补丁不算
  assert.equal(wholeRecordWithout({ name: '虚构' }, { name: '虚构', priceExact: '1.5' }, 'priceExact'), true);
  assert.equal(wholeRecordWithout({ priceCents: 200 }, { name: '虚构', priceExact: '1.5' }, 'priceExact'), false);
  const before = { lines: [{ id: 7, productId: 3, productName: '虚构纸箱', unitPriceCents: 150, unitPriceExact: '1.5' }] };
  // 只改了分、精确价原样带回：按分存，带回来的旧精确价去掉
  const byCents = orderLinesPriceEdit([{ id: 7, productId: 3, unitPriceCents: 200, unitPriceExact: '1.5' }], before, before);
  assert.ok(typeof byCents[0] === 'object' && byCents[0] !== null);
  assert.equal('unitPriceExact' in byCents[0], false);
  // 精确价点名清空、分没动：拒收并说清是哪一项
  assert.throws(
    () => orderLinesPriceEdit([{ id: 7, productId: 3, productName: '虚构纸箱', unitPriceCents: 150 }], before, before),
    /第1项“虚构纸箱”：请填写单价/,
  );
  // 新加的明细照提交的存
  const fresh = { productId: 9, unitPriceCents: 300 };
  assert.deepEqual(orderLinesPriceEdit([fresh], before, before), [fresh]);
  const issue = orderSchema.safeParse({ customerId: 1, orderDate: '2026-10-01', lines: [] });
  assert.ok(!issue.success);
  assert.doesNotMatch(readableIssues(issue.error.issues, 'orders'), /[A-Za-z]{4,}/, '说法里不露英文字段名');
});

