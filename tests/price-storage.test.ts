// 单价和合计怎么存：产品参考单价、订单明细单价只存一份（万分之一元），分是算出来的；合计和明细对得上；
// 只改一头按改的那头存，两头都改了又对不上的拒收；直接写库越界的被约束拦下。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/core/db.js';
// 订单视图的发货、订料进度和改单核对由单据流转提供（server/core/order-hooks.ts），读写订单要加载它
import '../server/flow/index.js';
import { lineSchema, orderSchema, productSchema } from '../shared/core/domain.js';
import { count, one, rows } from '../server/core/index.js';
import { legacyCents, precisionTotal, priceFromE4, priceToE4 } from '../shared/core/precision.js';

const priceList = ['1.3000', '8.7800', '0.1700'],
  qty = [1400, 100, 1400];

test('订单的四位单价、客户采购单号、税率、条款原样存回；四位单价乘数量合计到分（2936 元，数量 2900）', () => {
  const s = new Store(':memory:');
  try {
    const c = s.saveCustomer({ name: '虚构客户', contact: '', phone: '', address: '', notes: '' }),
      p = s.saveProduct(
        productSchema.parse({ name: 'ES001', length: 300, width: 200, height: 150, material: '牛卡', flute: 'B楞', requirements: '粘箱', priceCents: 130, priceExact: '1.3000', customerProductCode: 'ES001' }),
      );
    const input = orderSchema.parse({
      customerId: c.id,
      orderDate: '2026-11-01',
      deliveryDate: '2026-11-10',
      status: '待确认',
      notes: '',
      costs: null,
      externalPurchaseOrder: 'TEST-PO-1',
      taxRate: '13',
      taxMode: '含税',
      terms: '送货前确认',
      roundingPolicy: 'exact-cents',
      lines: priceList.map((v, i) => ({
        productId: p.id,
        specification: '300x200x150mm 牛卡 B楞',
        quantity: qty[i],
        unitPriceCents: legacyCents(v),
        unitPriceExact: v,
        unit: '只',
        customerProductCode: 'ES00' + (i + 1),
      })),
    });
    const order = s.saveOrder(input);
    assert.equal(order.totalCents, 293600);
    assert.equal(order.totalAmountExact, '2936.0000');
    assert.deepEqual(
      order.lines.map((l) => l.unitPriceExact),
      priceList,
    );
    assert.equal(order.externalPurchaseOrder, 'TEST-PO-1');
    assert.equal(order.taxRate, '13');
    assert.equal(order.terms, '送货前确认');
    assert.equal(s.product(p.id)?.priceExact, '1.3000');
  } finally {
    s.close();
  }
});

test('只改产品的分价格、不带精确价：按新的分存，原来的四位精确价不会留下来把它盖掉', () => {
  const s = new Store(':memory:');
  try {
    const product = {
      name: '虚构产品',
      length: 1,
      width: 1,
      height: 1,
      material: '牛卡',
      flute: 'B',
      requirements: '',
      priceCents: 123,
      priceExact: '1.2345',
    };
    let p = s.saveProduct(product);
    assert.equal(p.priceExact, '1.2345');
    p = s.saveProduct({ ...product, priceExact: undefined, priceCents: 150 }, p.id, p.version);
    assert.equal(p.priceCents, 150);
    // 单价只存一份：按新的分存，读出来的精确价跟着是 1.5000，旧的 1.2345 不会留下
    assert.equal(p.priceExact, '1.5000');
  } finally {
    s.close();
  }
});

test('参考单价只存一份：没定价和 0 元分得开，清空价格回到没定价，只给分按分存', () => {
  const s = new Store(':memory:');
  try {
    const base = productSchema.parse({ name: '虚构定价纸箱' });
    const raw = (id: number) => {
      const row = one(s.db, rows.products.pick({ price_e4: true, price_cents: true }), 'SELECT price_e4,price_cents FROM products WHERE id=?', id);
      if (!row) throw new Error('测试数据：没有编号 ' + id + ' 的产品');
      return row;
    };
    // 没定价：库里是 NULL；接口里分是 0，没有 priceExact 这个键
    let p = s.saveProduct(base);
    assert.equal(p.priceCents, 0);
    assert.equal(Object.hasOwn(p, 'priceExact'), false);
    assert.deepEqual(raw(p.id), { price_e4: null, price_cents: null });
    // 0 元：priceExact 是 0.0000
    p = s.saveProduct({ ...base, priceExact: '0' }, p.id, p.version);
    assert.deepEqual([p.priceExact, p.priceCents], ['0.0000', 0]);
    assert.deepEqual(raw(p.id), { price_e4: 0, price_cents: 0 });
    // 编辑窗清空价格（分是 0、不带精确价）：回到没定价，原来是 0 元的也清得掉
    p = s.saveProduct({ ...base, priceCents: 0 }, p.id, p.version);
    assert.equal(Object.hasOwn(p, 'priceExact'), false);
    assert.equal(raw(p.id).price_e4, null);
    // 同一个价的不同写法存成同一个数，读出来固定四位
    for (const text of ['1.5', '1.50', '1.5000']) {
      p = s.saveProduct({ ...base, priceExact: text }, p.id, p.version);
      assert.deepEqual([p.priceExact, p.priceCents, raw(p.id).price_e4], ['1.5000', 150, 15000]);
    }
    // 只给分：分没变沿用原来的四位价，分变了按分存
    p = s.saveProduct({ ...base, priceExact: '1.2345' }, p.id, p.version);
    assert.equal(p.priceCents, 123);
    p = s.saveProduct({ ...base, priceCents: 123 }, p.id, p.version);
    assert.equal(p.priceExact, '1.2345');
    p = s.saveProduct({ ...base, priceCents: 139 }, p.id, p.version);
    assert.deepEqual([p.priceExact, p.priceCents], ['1.3900', 139]);
    // 库里算出来的分和 legacyCents 同一个四舍五入：半分进位
    for (const text of ['0.0049', '0.005', '0.0149', '0.015', '999999.9949', '999999.995', '1000000']) {
      p = s.saveProduct({ ...base, priceExact: text }, p.id, p.version);
      assert.equal(p.priceCents, legacyCents(text), text);
      const e4 = raw(p.id).price_e4;
      // 没有精确价、库里没存万分之一元时左边是 undefined、null，照样比不上
      assert.equal(p.priceExact === undefined ? undefined : priceToE4(p.priceExact), priceToE4(text), text);
      assert.equal(e4 === null ? null : priceFromE4(e4), p.priceExact, text);
    }
    // “分”是算出来的列，写不进去；万分之一元的列只收整数（STRICT）、不收负数
    assert.throws(() => s.db.prepare('UPDATE products SET price_cents=1 WHERE id=?').run(p.id));
    assert.throws(() => s.db.prepare('UPDATE products SET price_e4=1.5 WHERE id=?').run(p.id));
    assert.throws(() => s.db.prepare('UPDATE products SET price_e4=-1 WHERE id=?').run(p.id), /CHECK/);
  } finally {
    s.close();
  }
});

test('订单明细单价只存一份：每条明细都有四位精确单价，精确合计按明细现算，合计的分和明细对得上', () => {
  const s = new Store(':memory:');
  try {
    const c = s.saveCustomer({ name: '虚构客户', contact: '', phone: '', address: '', notes: '' }),
      p = s.saveProduct(productSchema.parse({ name: '虚构单价纸箱' }));
    const input = orderSchema.parse({
      customerId: c.id,
      orderDate: '2026-11-01',
      deliveryDate: '2026-11-10',
      status: '待确认',
      roundingPolicy: 'half-up-cent',
      lines: [
        { productId: p.id, quantity: 3, unitPriceCents: 123, unitPriceExact: '1.2345' },
        // 只给分：按分存，读出来也有四位精确单价
        { productId: p.id, quantity: 7, unitPriceCents: 139 },
        { productId: p.id, quantity: 2, unitPriceCents: 150, unitPriceExact: '1.5', notes: '', taxRate: '13', unit: '个' },
      ],
    });
    let order = s.saveOrder(input);
    assert.deepEqual(
      order.lines.map((l) => [l.unitPriceExact, l.unitPriceCents, l.unit]),
      [
        ['1.2345', 123, '只'],
        ['1.3900', 139, '只'],
        ['1.5000', 150, '只'],
      ],
    );
    // 3×1.2345 + 7×1.39 + 2×1.5 = 16.4335，四舍五入到分 16.43
    assert.deepEqual([order.totalAmountExact, order.totalCents, order.currency], ['16.4335', 1643, 'CNY']);
    assert.equal(precisionTotal(order.lines).cents, order.totalCents);
    // 没填的附加信息没有这个键（不是 null）；填了空串的保留空串
    for (const key of ['externalPurchaseOrder', 'supplierName', 'taxRate', 'taxMode', 'terms'])
      assert.equal(Object.hasOwn(order, key), false, key);
    for (const key of ['customerProductCode', 'notes', 'taxRate', 'taxMode', 'deliveryDate'])
      assert.equal(Object.hasOwn(order.lines[0], key), false, key);
    assert.deepEqual([order.lines[2].notes, order.lines[2].taxRate], ['', '13']);
    assert.deepEqual(
      s.db
        .prepare('SELECT unit,unit_price_e4,unit_price_cents FROM order_lines WHERE order_id=? ORDER BY id')
        .all(order.id)
        .map((r) => ({ ...r })),
      [
        { unit: '只', unit_price_e4: 12345, unit_price_cents: 123 },
        { unit: '只', unit_price_e4: 13900, unit_price_cents: 139 },
        { unit: '只', unit_price_e4: 15000, unit_price_cents: 150 },
      ],
    );
    // 改订单时只带分、分没变：原来的四位单价沿用；这次没带的附加信息也沿用
    order = s.saveOrder(
      { ...input, notes: '改了备注', roundingPolicy: undefined, lines: order.lines.map(({ unitPriceExact, ...l }) => l) },
      order.id,
      order.version,
    );
    assert.deepEqual(order.lines.map((l) => l.unitPriceExact), ['1.2345', '1.3900', '1.5000']);
    assert.deepEqual([order.roundingPolicy, order.totalAmountExact, order.notes], ['half-up-cent', '16.4335', '改了备注']);
    // 别的单位一律拒收，原来的明细原样带回来也不例外
    assert.throws(
      () => s.saveOrder({ ...input, lines: order.lines.map((l) => ({ ...l, unit: '箱' })) }, order.id, order.version),
      /只有“只”/,
    );
  } finally {
    s.close();
  }
});

test('合计的分是存着的，和明细对得上；管理员直接改了数据以后重算只动对不上的；直接写库越界的都被拦', () => {
  const s = new Store(':memory:');
  try {
    const c = s.saveCustomer({ name: '虚构客户', contact: '', phone: '', address: '', notes: '' }),
      p = s.saveProduct(productSchema.parse({ name: '虚构合计纸箱' }));
    const order = s.saveOrder(
      orderSchema.parse({
        customerId: c.id,
        orderDate: '2026-11-01',
        deliveryDate: '2026-11-10',
        status: '待确认',
        roundingPolicy: 'half-up-cent',
        lines: [
          { productId: p.id, quantity: 3, unitPriceCents: 123, unitPriceExact: '1.2345' },
          { productId: p.id, quantity: 7, unitPriceCents: 139 },
          { productId: p.id, quantity: 2, unitPriceCents: 150, unitPriceExact: '1.5' },
        ],
      }),
    );
    const mismatched = () =>
      count(
        s.db,
        'SELECT count(*) AS n FROM orders o WHERE total_cents <> (SELECT (SUM(l.unit_price_e4*l.quantity)+50)/100 FROM order_lines l WHERE l.order_id=o.id)',
      );
    assert.equal(mismatched(), 0);
    s.recomputeOrderTotals();
    assert.equal(s.order(order.id)?.version, order.version, '对得上的不动');
    s.db.prepare('UPDATE order_lines SET quantity=4 WHERE order_id=? AND unit_price_e4=12345').run(order.id);
    assert.equal(mismatched(), 1);
    // 修改时间先写成很早的，看重算改合计时有没有跟着更新
    s.db.prepare("UPDATE orders SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(order.id);
    s.recomputeOrderTotals();
    const fixed = s.order(order.id);
    assert.ok(fixed, '重算后订单还在');
    // 4×1.2345 + 7×1.39 + 2×1.5 = 17.668，四舍五入到分 17.67
    assert.deepEqual([fixed.totalAmountExact, fixed.totalCents, fixed.version], ['17.6680', 1767, order.version + 1]);
    assert.ok(fixed.updatedAt > '2000-01-01T00:00:00.000Z', '改了合计，修改时间跟着更新');
    assert.equal(precisionTotal(fixed.lines).cents, fixed.totalCents);
    assert.equal(mismatched(), 0);
    // 三张补充资料表没有了
    assert.deepEqual(s.db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%extensions'").all(), []);
    // 直接写库：单位不是“只”、往“分”的列写值、小数单价、别的币种、乱写的尾数规则都被拦
    assert.throws(() => s.db.prepare("UPDATE order_lines SET unit='箱' WHERE order_id=?").run(order.id), /CHECK/);
    assert.throws(() => s.db.prepare('UPDATE order_lines SET unit_price_cents=1 WHERE order_id=?').run(order.id));
    assert.throws(() => s.db.prepare('UPDATE order_lines SET unit_price_e4=1.5 WHERE order_id=?').run(order.id));
    assert.throws(() => s.db.prepare("UPDATE orders SET currency='USD' WHERE id=?").run(order.id), /CHECK/);
    assert.throws(() => s.db.prepare("UPDATE orders SET rounding_policy='floor' WHERE id=?").run(order.id), /CHECK/);
    assert.throws(() => s.db.prepare("UPDATE orders SET cost_estimate='{' WHERE id=?").run(order.id), /CHECK/);
    // 成本估算只能是 JSON 对象；日期要真有这一天；明细交期可以不填，但只能是 NULL 或合法日期，不能是空串
    assert.throws(() => s.db.prepare("UPDATE orders SET cost_estimate='[]' WHERE id=?").run(order.id), /CHECK/);
    assert.throws(() => s.db.prepare("UPDATE orders SET order_date='2026-02-30' WHERE id=?").run(order.id), /CHECK/);
    assert.throws(() => s.db.prepare("UPDATE orders SET delivery_date='2026-13-01' WHERE id=?").run(order.id), /CHECK/);
    assert.throws(() => s.db.prepare("UPDATE order_lines SET delivery_date='2026-02-30' WHERE order_id=?").run(order.id), /CHECK/);
    assert.throws(() => s.db.prepare("UPDATE order_lines SET delivery_date='' WHERE order_id=?").run(order.id), /CHECK/);
    s.db.prepare("UPDATE order_lines SET delivery_date='2028-02-29' WHERE order_id=?").run(order.id);
    assert.equal(s.order(order.id)?.lines[0].deliveryDate, '2028-02-29', '闰年的 2 月 29 日是真有的一天');
    // 正常写入先过校验：不存在的日期在校验这一层就拦下，到不了库
    const dated = { customerId: c.id, orderDate: '2026-11-01', deliveryDate: '2026-11-10', status: '待确认', lines: [{ productId: p.id, quantity: 1, unitPriceCents: 100 }] };
    assert.equal(orderSchema.safeParse(dated).success, true);
    assert.equal(orderSchema.safeParse({ ...dated, deliveryDate: '2026-11-31' }).success, false);
    assert.equal(orderSchema.safeParse({ ...dated, lines: [{ ...dated.lines[0], deliveryDate: '2026-02-30' }] }).success, false);
    // 明细不靠级联：有明细的订单不能直接删
    assert.throws(() => s.db.prepare('DELETE FROM orders WHERE id=?').run(order.id), /FOREIGN KEY/);
  } finally {
    s.close();
  }
});

test('产品参考单价的精确价和分都给了：只改了一头按改的那一头存；新建就对不上、两头都改了还对不上的拒收', () => {
  const s = new Store(':memory:');
  try {
    let p = s.saveProduct(productSchema.parse({ name: '虚构带回纸箱', priceExact: '1.5' }));
    const price = () => [p.priceCents, p.priceExact];
    p = s.saveProduct({ ...p, priceCents: 200 }, p.id, p.version);
    assert.deepEqual(price(), [200, '2.0000']);
    // 精确价写法不同、数值相同也算没动
    p = s.saveProduct({ ...p, priceExact: '2', priceCents: 250 }, p.id, p.version);
    assert.deepEqual(price(), [250, '2.5000']);
    p = s.saveProduct({ ...p, priceExact: '1.2345' }, p.id, p.version);
    assert.deepEqual(price(), [123, '1.2345']);
    // 只给了精确价、没给分（校验补成 0）：不算改了分，价格不动
    p = s.saveProduct(productSchema.parse({ name: p.name, priceExact: '1.2345' }), p.id, p.version);
    assert.deepEqual(price(), [123, '1.2345']);
    // 两头都改了、对得上：照常存
    p = s.saveProduct({ ...p, priceExact: '3.0049', priceCents: 300 }, p.id, p.version);
    assert.deepEqual(price(), [300, '3.0049']);
    // 两头都改了又对不上：拒收，原来的价不动（价格不猜）
    assert.throws(
      () => s.saveProduct({ ...p, priceExact: '4', priceCents: 999 }, p.id, p.version),
      /参考单价：“分”填的是 999，精确价填的是 4 元，两个对不上。请只填一个，或改成一致的值。/,
    );
    assert.deepEqual([s.product(p.id)?.priceCents, s.product(p.id)?.priceExact, s.product(p.id)?.version], [300, '3.0049', p.version]);
    // 新建时就对不上：拒收，没建出来；对得上的、只给一个的照常建
    const before = s.products(true).length;
    assert.throws(
      () => s.saveProduct(productSchema.parse({ name: '虚构对不上纸箱', priceExact: '1.5', priceCents: 200 })),
      /两个对不上/,
    );
    assert.equal(s.products(true).length, before);
    assert.deepEqual(
      [
        productSchema.parse({ name: '虚构对得上纸箱', priceExact: '1.2345', priceCents: 123 }),
        productSchema.parse({ name: '虚构只给精确价纸箱', priceExact: '1.5' }),
        productSchema.parse({ name: '虚构只给分纸箱', priceCents: 150 }),
      ].map((input) => {
        const made = s.saveProduct(input);
        return [made.priceCents, made.priceExact];
      }),
      [
        [123, '1.2345'],
        [150, '1.5000'],
        [150, '1.5000'],
      ],
    );
    // 原来没定价，这次两个都填了又对不上：也是两头都改了，拒收
    const blank = s.saveProduct(productSchema.parse({ name: '虚构没定价纸箱' }));
    assert.throws(() => s.saveProduct({ ...blank, priceExact: '1.5', priceCents: 200 }, blank.id, blank.version), /两个对不上/);
  } finally {
    s.close();
  }
});

test('订单明细单价的精确价和分都给了：只改了一头按改的那一头存；两头都改了对不上、新加的明细和新建订单对不上的拒收', () => {
  const s = new Store(':memory:');
  try {
    // 和上一条结束时一样的产品：参考单价 3.0049 元（300 分）
    const p = s.saveProduct(productSchema.parse({ name: '虚构带回纸箱', priceExact: '3.0049' }));
    const c = s.saveCustomer({ name: '虚构客户', contact: '', phone: '', address: '', notes: '' });
    let order = s.saveOrder(
      orderSchema.parse({
        customerId: c.id,
        orderDate: '2026-11-01',
        deliveryDate: '2026-11-10',
        status: '待确认',
        lines: [{ productId: p.id, quantity: 10, unitPriceCents: 150, unitPriceExact: '1.5' }],
      }),
    );
    const resave = (line: Record<string, unknown>) => {
      order = s.saveOrder({ ...order, lines: [{ ...order.lines[0], ...line }] }, order.id, order.version);
      return [order.lines[0].unitPriceCents, order.lines[0].unitPriceExact, order.totalCents];
    };
    assert.deepEqual(resave({}), [150, '1.5000', 1500], '原样带回来：不变');
    assert.deepEqual(resave({ unitPriceCents: 250 }), [250, '2.5000', 2500], '只改分：按分存');
    assert.deepEqual(resave({ unitPriceExact: '1.2' }), [120, '1.2000', 1200], '只改精确价：按精确价存');
    assert.deepEqual(resave({ unitPriceCents: 0 }), [0, '0.0000', 0], '明细的分改成 0 就是 0 元');
    assert.deepEqual(resave({ unitPriceExact: '3.0049', unitPriceCents: 300 }), [300, '3.0049', 3005], '两头都改了、对得上：照常存');
    // 两头都改了又对不上：拒收，报错点名是哪个产品，订单不动
    assert.throws(
      () => resave({ unitPriceExact: '4', unitPriceCents: 999 }),
      /“虚构带回纸箱”的单价：“分”填的是 999，精确价填的是 4 元，两个对不上。请只填一个，或改成一致的值。/,
    );
    assert.deepEqual(
      [s.order(order.id)?.lines[0].unitPriceExact, s.order(order.id)?.totalCents, s.order(order.id)?.version],
      ['3.0049', 3005, order.version],
    );
    // 新加的明细（没有原值可比）对不上：拒收；新建订单同理
    assert.throws(
      () =>
        s.saveOrder(
          { ...order, lines: [...order.lines, lineSchema.parse({ productId: p.id, quantity: 1, unitPriceCents: 200, unitPriceExact: '1.5' })] },
          order.id,
          order.version,
        ),
      /两个对不上/,
    );
    const orders = s.orders(true).length;
    assert.throws(
      () =>
        s.saveOrder(
          orderSchema.parse({
            customerId: c.id,
            orderDate: '2026-11-01',
            deliveryDate: '2026-11-10',
            status: '待确认',
            lines: [{ productId: p.id, quantity: 10, unitPriceCents: 200, unitPriceExact: '1.5' }],
          }),
        ),
      /两个对不上/,
    );
    assert.equal(s.orders(true).length, orders);
  } finally {
    s.close();
  }
});
