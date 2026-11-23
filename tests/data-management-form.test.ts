// 数据管理的编辑窗（src/admin）：新建时提示全是中文、每个字段有中文名、不露内部编号和英文代码、单价写法、订单的预估成本。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { costSchema, customerSchema, productSchema, orderSchema } from '../shared/core/domain.js';
import { OperationsService } from '../server/operations/index.js';
import { dataManagementFieldName, dataManagementModules } from '../shared/business/data-management-modules.js';
import { AUDIT_SOURCE } from '../shared/core/audit-sources.js';
import { dataManagementCommand } from '../src/admin/data-api.js';
import { purchaseSchema, stockItemSchema, supplierSchema } from '../shared/business/operations.js';
import { arrivalSchema, deliverySchema, productionSchema, taskSchema } from '../shared/business/physical-flow.js';
import { userError } from '../shared/core/user-errors.js';
import { RecordInputError, editableInput, submittedInput, valueAt } from '../src/admin/record-input.js';
import { buildRefs } from '../src/admin/record-refs.js';
import { ZodError, z } from 'zod';
import { one, rows } from '../server/core/index.js';
import DataManagementFields from '../src/admin/DataManagementFields.js';
import { fieldChoices, refOptions } from '../src/admin/field-rules.js';
import DataManagementRecordDialog from '../src/admin/DataManagementRecordDialog.js';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { basics, command, firstResult, shownError } from './data-management-fixture.js';
import { isJsonList, isJsonObject, type JsonObject } from '../src/admin/record-types.js';
import { actor } from './actor-fixture.js';
import { must } from './read-result.js';

const viaJsonList = (value: unknown) => z.array(z.record(z.string(), z.json())).parse(JSON.parse(JSON.stringify(value)));

/** 编辑窗内容里的明细（一组对象） */
function linesOf(value: JsonObject) {
  const lines = value.lines;
  assert.ok(isJsonList(lines), '明细是一组');
  return lines.filter(isJsonObject);
}

test('数据管理新建：编号不预填 0；什么都不填直接保存，提示全是中文（请选择客户、请选择产品……），没有英文和字段代码', () => {
  const f = basics();
  try {
    const template = <M extends (typeof dataManagementModules)[number]>(m: M) => f.service.list(m, f.who).template;
    // 编号类字段留空，不拿 0 冒充真值
    const ids = (value: unknown, path = ''): string[] =>
      Array.isArray(value)
        ? value.flatMap((v) => ids(v, path))
        : value && typeof value === 'object'
          ? Object.entries(value).flatMap(([k, v]) => ids(v, k))
          : /Id$/.test(path) && value === 0
            ? [path]
            : [];
    for (const m of dataManagementModules) assert.deepEqual(ids(template(m)), [], m + ' 的编号不预填 0');
    assert.equal(template('orders').customerId, null);
    assert.equal(template('orders').lines[0].productId, null);
    assert.equal('productName' in template('orders').lines[0], false, '产品名称不放进模板：不填按产品档案的名称存');
    const shown: Record<string, string> = {};
    for (const m of dataManagementModules) {
      shown[m] = shownError(() => f.service.execute(command(m, 'create', [], template(m)), f.who, 's'));
      assert.doesNotMatch(shown[m], /[A-Za-z]/, m + ' 的提示里不能有英文或字段代码：' + shown[m]);
    }
    // 中文冒号、整句，不写英文冒号（“客户: …”）
    for (const m of dataManagementModules) assert.doesNotMatch(shown[m], /: /, m + ' 的提示用中文冒号：' + shown[m]);
    assert.match(shown.orders, /客户：请选择客户/);
    assert.match(shown.orders, /明细第1项的产品：请选择产品/);
    // 单价的“分”编辑窗里不显示，按“单价（元）”那一格说
    assert.doesNotMatch(shown.orders, /（分）/);
    assert.match(shown.purchases, /供应商：请选择供应商/);
    assert.match(shown.arrival, /供应商：请选择供应商/);
    assert.match(shown.task, /产品：请选择产品/);
    assert.match(shown.production, /产品：请选择产品/);
    // 入哪个成品库存由产品决定（一个产品只有一个成品库存），不用选，也不报“请选择入库的成品”
    assert.doesNotMatch(shown.production, /入库成品/);
    assert.match(shown.delivery, /客户：请选择客户/);
    assert.match(shown.delivery, /明细第1项的订单：请选择订单/);
    assert.match(shown.customers, /请填写客户名称/);
    assert.match(shown.suppliers, /请填写供应商名称/);
    // 填了 0 或负数：同样说人话
    const zero = shownError(() =>
      f.service.execute(command('orders', 'create', [], { ...template('orders'), customerId: 0, deliveryDate: '2026-12-31', lines: [{ ...template('orders').lines[0], productId: -1, quantity: 1, unitPriceCents: 100 }] }), f.who, 's'),
    );
    assert.equal(zero, '客户：请选择客户；明细第1项的产品：请选择产品');
    // 产品名称填了空串：中文字段名和提示
    assert.equal(
      shownError(() =>
        f.service.execute(command('orders', 'create', [], { ...template('orders'), customerId: f.customer.id, deliveryDate: '2026-12-31', lines: [{ ...template('orders').lines[0], productId: f.product.id, productName: '', quantity: 1, unitPriceCents: 100 }] }), f.who, 's'),
      ),
      '明细第1项的本单名称：请填写本单名称',
    );
    // 只选了客户、产品，填了数量和单价：按产品档案的名称存
    const created = f.service.execute(
      command('orders', 'create', [], { ...template('orders'), customerId: f.customer.id, deliveryDate: '2026-12-31', lines: [{ ...template('orders').lines[0], productId: f.product.id, quantity: 1, unitPriceCents: 100 }] }),
      f.who,
      's',
    );
    assert.equal(firstResult(created).lines[0].productName, f.product.name);
  } finally {
    f.store.close();
  }
});
test('数据管理每个模块的每个可编辑字段都有中文名（编辑窗不直接显示字段代码），出错提示里的字段名也是中文', () => {
  const schemas: Record<string, z.ZodType> = {
    customers: customerSchema,
    products: productSchema,
    orders: orderSchema,
    suppliers: supplierSchema,
    purchases: purchaseSchema,
    stock_items: stockItemSchema,
    arrival: arrivalSchema,
    task: taskSchema,
    production: productionSchema,
    delivery: deliverySchema,
  };
  // 顺着 zod 的结构把对象里的每个键找出来（带上一层的名字，预估成本里的 material 另有名字）
  const zodDefSchema = z.looseObject({
    type: z.string(),
    shape: z.record(z.string(), z.unknown()).optional(),
    element: z.unknown().optional(),
    in: z.unknown().optional(),
    out: z.unknown().optional(),
    options: z.array(z.unknown()).optional(),
    innerType: z.unknown().optional(),
  });
  const zodHolder = z.looseObject({ _zod: z.looseObject({ def: zodDefSchema }) });
  const keys = (schema: unknown, parent = ''): [string, string][] => {
    const parsed = zodHolder.safeParse(schema);
    if (!parsed.success) return [];
    const def = parsed.data._zod.def;
    if (def.type === 'object' && def.shape)
      return Object.entries(def.shape).flatMap(([k, v]) => [[k, parent] as [string, string], ...keys(v, k)]);
    if (def.type === 'array') return keys(def.element, parent);
    if (def.type === 'pipe') return [...keys(def.in, parent), ...keys(def.out, parent)];
    if (def.type === 'union' && def.options) return def.options.flatMap((o) => keys(o, parent));
    if (def.innerType) return keys(def.innerType, parent);
    return [];
  };
  assert.deepEqual([...dataManagementModules].sort(), Object.keys(schemas).sort());
  // 确实顺着结构找到了：送货单的计划日期、到货明细里的纸板（item）、预估成本里的几项
  assert.ok(keys(deliverySchema).some(([k]) => k === 'plannedDate'));
  assert.ok(keys(arrivalSchema).some(([k, parent]) => k === 'name' && parent === 'item'));
  assert.ok(keys(orderSchema).some(([k, parent]) => k === 'basis' && parent === 'costs'));
  for (const [m, schema] of Object.entries(schemas))
    for (const [k, parent] of keys(schema)) {
      const name = dataManagementFieldName(k, parent);
      assert.notEqual(name, k, m + ' 的字段 ' + (parent ? parent + '.' : '') + k + ' 没有中文名');
      // 面积单位按词表写“m²”，不算英文
      assert.doesNotMatch(name.replaceAll('m²', ''), /[A-Za-z]/, m + ' 的字段 ' + k + ' 的中文名里有英文：' + name);
      // 出错时提示里的字段名（userError）也不能是字段代码
      assert.doesNotMatch(userError(k + ': 请填写'), /[A-Za-z]/, m + ' 的字段 ' + k + ' 出错时显示成字段代码');
    }
  assert.equal(dataManagementFieldName('plannedDate'), '计划日期');
  assert.equal(dataManagementFieldName('material', 'costs'), '材料成本（元）');
  assert.equal(dataManagementFieldName('material', 'lines'), '材质 / 配纸');
  // 和各编辑窗同一个叫法（界面规范的词表）
  assert.equal(dataManagementFieldName('specification'), '规格');
  // 给人看的名字里没有“编号”“（分）”：关联字段是选择器（显示名称），金额按元填。
  // 只有产品参考单价、订单明细单价的“分”例外：编辑窗里不显示，由“元”算出来
  for (const [m, schema] of Object.entries(schemas))
    for (const [k, parent] of keys(schema)) {
      if (['priceCents', 'unitPriceCents'].includes(k)) continue;
      assert.doesNotMatch(dataManagementFieldName(k, parent), /编号|（分）/, m + ' 的字段 ' + k + ' 的中文名露了编号或分：' + dataManagementFieldName(k, parent));
    }
});
test('数据管理编辑窗不露内部编号和英文代码：关联字段的候选显示名称或单号，币种写人民币，金额按元填、存的还是分', () => {
  const f = basics();
  try {
    const ops = new OperationsService(f.store);
    const supplier = ops.saveSupplier({ name: '虚构候选供应商', contact: '虚构联系人' }, actor);
    const lists = {
      customers: viaJsonList(f.service.list('customers', f.who).records.map((r) => r.record)),
      products: viaJsonList(f.service.list('products', f.who).records.map((r) => r.record)),
      orders: viaJsonList(f.service.list('orders', f.who).records.map((r) => r.record)),
      suppliers: viaJsonList(f.service.list('suppliers', f.who).records.map((r) => r.record)),
    };
    const refs = buildRefs(lists);
    const customersRef = must(refs.customers, '客户候选'),
      productsRef = must(refs.products, '产品候选'),
      ordersRef = must(refs.orders, '订单候选'),
      suppliersRef = must(refs.suppliers, '供应商候选'),
      orderLinesRef = must(refs.orderLines, '订单明细候选');
    // 选项显示名称、单号，小字带能认出来的信息，都不带内部编号
    assert.deepEqual(customersRef.map((o) => o.label), ['虚构开发客户']);
    assert.equal(ordersRef[0].label, f.order.number);
    assert.match(must(ordersRef[0].hint, '订单提示'), /虚构开发客户/);
    assert.equal(suppliersRef[0].hint, '虚构联系人');
    assert.equal(orderLinesRef[String(f.order.id)][0].label, '第1项 虚构开发纸箱');
    for (const list of [customersRef, productsRef, ordersRef, suppliersRef])
      for (const o of list) assert.doesNotMatch(o.label + (o.hint || ''), /#\d|编号/, '候选不露编号：' + o.label);
    // 选项的值还是编号（存的不变）；可以不关联的有“不关联”，当前值找不到的写“已找不到”，不显示编号
    const ctx = { module: 'purchases', record: null, refs };
    assert.equal(refOptions('customerOrderId', null, ctx)[0].label, '不关联');
    assert.equal(refOptions('customerOrderId', f.order.id, ctx)[1].value, String(f.order.id));
    assert.equal(must(refOptions('customerOrderId', 999, ctx).at(-1), '末尾候选').label, '原来关联的记录（已找不到）');
    assert.equal(refOptions('supplierId', supplier.id, { ...ctx, refs: buildRefs(lists) })[0].label, '虚构候选供应商');
    // 币种只写人民币，存的还是 CNY
    assert.deepEqual(fieldChoices('currency', 'CNY', 'orders'), [['CNY', '人民币']]);
    // 订单明细单价：编辑窗显示元（去掉多余的零），保存时由元算出分，两头对得上
    const record = must(f.service.list('orders', f.who).records.find((r) => r.record.id === f.order.id), '订单记录');
    const shown = editableInput('orders', record.input);
    assert.equal(linesOf(shown)[0].unitPriceExact, '1.23');
    const sent = submittedInput('orders', { ...shown, lines: [{ ...linesOf(shown)[0], unitPriceExact: '2.5' }] });
    assert.deepEqual([linesOf(sent)[0].unitPriceCents, linesOf(sent)[0].unitPriceExact], [250, '2.5']);
    f.service.execute(command('orders', 'update', [record.record], sent), f.who, 's');
    const saved = must(sales(f.store).order(f.order.id, true), '保存后订单');
    assert.deepEqual([saved.lines[0].unitPriceCents, saved.lines[0].unitPriceExact], [250, '2.5000']);
    // 单价清空：分也清空，由校验提示“请填写单价”，不按旧价存
    const cleared = submittedInput('orders', { ...shown, lines: [{ ...linesOf(shown)[0], unitPriceExact: '' }] });
    assert.equal(linesOf(cleared)[0].unitPriceCents, null);
    // 产品参考单价：只填元，分由它算出来
    const product = must(f.service.list('products', f.who).records.find((r) => r.record.id === f.product.id), '产品记录');
    const priced = submittedInput('products', { ...editableInput('products', product.input), priceExact: '3.456' });
    assert.deepEqual([priced.priceCents, priced.priceExact], [346, '3.456']);
    f.service.execute(command('products', 'update', [product.record], priced), f.who, 's');
    const savedProduct = must(sales(f.store).product(f.product.id), '保存后产品');
    assert.deepEqual([savedProduct.priceCents, savedProduct.priceExact], [346, '3.4560']);
    assert.equal(editableInput('products', f.service.list('products', f.who).records[0].input).priceExact, '3.456');
    // 预估成本按元填，格式不对直接说中文
    assert.throws(
      () => submittedInput('orders', { ...shown, costs: { material: '1.234', processing: null, waste: null, other: null, basis: '虚构' } }),
      /材料成本（元）：请填写金额/,
    );
    // 上限和服务端一致（一百万元）：超了说“金额太大”，不说成小数位的问题；整数位多了也一样
    const costed = (material: string) =>
      valueAt(submittedInput('orders', { ...shown, costs: { material, processing: null, waste: null, other: null, basis: '虚构' } }), 'costs.material');
    assert.equal(costed('1000000'), 100_000_000);
    assert.equal(costed('999999.99'), 99_999_999);
    assert.equal(costed('0.5'), 50);
    for (const big of ['1000000.01', '10000000', '123456789012345678901234567890'])
      assert.throws(
        () => costed(big),
        (e: Error) => /材料成本（元）：金额太大，不能超过 1000000 元/.test(e.message) && !/小数/.test(e.message),
        big,
      );
    for (const bad of ['-1', '1e3', '12.', 'abc'])
      assert.throws(() => costed(bad), /材料成本（元）：请填写金额（元），最多两位小数/, bad);
    // 服务端同一个上限：一百万元整能存
    const serverCosts = (material: number) => costSchema.safeParse({ material, processing: 0, waste: 0, other: 0, basis: '虚构' });
    assert.equal(serverCosts(100_000_000).success, true);
    assert.match(String(serverCosts(100_000_001).error?.issues[0]?.message), /金额不能超过 1000000 元/);
    // 新建模板的日期用共用的 today()，不各写一份时区换算
    const source = readFileSync('server/admin/data-management-service.ts', 'utf8');
    assert.doesNotMatch(source, /toLocaleDateString|Asia\/Shanghai/);
    assert.match(source, /today\(\)/);
  } finally {
    f.store.close();
  }
});

test('数据管理编辑窗：单价按全站写法显示、没改的交回原文；叫法和详情一致；库存品编辑窗不带出入库；不露内部编号；选择器按对象写占位', () => {
  // 采购单、到货单明细的单价（元的文字，库里原样存）：显示去掉第三四位的尾零，至少两位
  const purchase = { supplierId: 1, lines: [{ id: 7, unitPrice: '2.7600' }, { id: 8, unitPrice: '3.5425' }, { id: 9, unitPrice: '10.7' }, { id: 10, unitPrice: null }] };
  const shown = editableInput('purchases', purchase);
  assert.deepEqual(linesOf(shown).map((l) => l.unitPrice), ['2.76', '3.5425', '10.70', null]);
  assert.equal(purchase.lines[0].unitPrice, '2.7600', '列表给的原文不动');
  // 交回去：数值没改的还原库里的原文（到货单的财务指纹按原文算，写法变了会被当成改过），改了的照填的交
  const edited = { ...shown, lines: linesOf(shown).map((l) => (l.id === 8 ? { ...l, unitPrice: '3.6' } : l)) };
  assert.deepEqual(linesOf(submittedInput('purchases', edited, purchase)).map((l) => l.unitPrice), ['2.7600', '3.6', '10.7', null]);
  const arrival = { lines: [{ unitPrice: '2.5000', item: { name: '虚构纸板' } }] };
  const arrivalShown = editableInput('arrival', arrival);
  assert.equal(linesOf(arrivalShown)[0].unitPrice, '2.50');
  assert.equal(linesOf(submittedInput('arrival', arrivalShown, arrival))[0].unitPrice, '2.5000');
  // 预估成本是金额，照原来的写法，不跟着单价补零
  assert.equal(valueAt(editableInput('orders', { lines: [], costs: { material: 10000, processing: 250, waste: null, other: 0, basis: '' } }), 'costs.material'), '100');
  // 叫法以详情为准：采购单的日期叫“采购日期”，完工单的备注叫“批次备注”；明细里的、别的模块的照旧
  assert.equal(dataManagementFieldName('orderDate', '', 'purchases'), '采购日期');
  assert.equal(dataManagementFieldName('orderDate', '', 'orders'), '下单日期');
  assert.equal(dataManagementFieldName('notes', '', 'production'), '批次备注');
  assert.equal(dataManagementFieldName('notes', 'materials', 'production'), '备注');
  assert.equal(dataManagementFieldName('notes', '', 'task'), '备注');
  const fields = (module: string, value: JsonObject) =>
    renderToStaticMarkup(h(DataManagementFields, { value, change: () => {}, module, record: null, refs: { customers: [], products: [], orders: [], suppliers: [] } }));
  assert.match(fields('purchases', { orderDate: '2026-11-01' }), /采购日期/);
  assert.match(fields('production', { notes: '' }), /批次备注/);
  // 选择器：占两格（下拉跟着框一样宽，名称不从中间折行），占位按对象写，产品不写“单号”
  const order = fields('orders', { customerId: null, lines: [{ productId: null }] });
  assert.match(order, /输入客户名称、联系人或电话搜索/);
  assert.match(order, /输入产品名称、尺寸或料号搜索/);
  assert.doesNotMatch(order, /输入名称或单号搜索/);
  assert.equal((order.match(/form-field span-2/g) || []).length, 2);
  assert.match(fields('delivery', { customerId: null, lines: [{ orderId: null }] }), /输入订单号或客户搜索/);
  // 库存品的编辑窗只改档案：出入库 / 盘点在列表的“更多”里，打开库存页同一个窗口，编辑窗里没有；底部不露内部编号
  const stock = { record: { id: 4321, version: 1, name: '虚构周转箱', kind: 'finished', unit: '只', quantity: '5' }, input: stockItemSchema.parse({ name: '虚构周转箱', kind: 'finished', unit: '只', productId: 1 }) };
  const html = renderToStaticMarkup(
    h(DataManagementRecordDialog, { module: 'stock_items', editing: stock, input: stock.input, setInput: () => {}, busy: false, error: '', refs: null, save: () => {}, close: () => {} }),
  );
  assert.doesNotMatch(html, /盘点/);
  assert.doesNotMatch(html, /内部编号/);
  assert.ok(!html.includes('4321'), '不露内部编号');
  // 数据管理窗口发的命令带标记，服务端照它把审计来源记成数据管理（tests/record-history-audit.test.ts 核对标签）
  const f = basics();
  try {
    const sent = dataManagementCommand({ requestId: randomUUID(), module: 'customers', action: 'archive', items: [{ id: f.customer.id, version: f.customer.version }] });
    f.service.execute(sent, f.who, 's');
    const logged = one(f.store.db, rows.business_audit.pick({ source: true }), "SELECT source FROM business_audit WHERE entity='customers' AND action='archive' ORDER BY id DESC LIMIT 1");
    assert.equal(logged?.source, AUDIT_SOURCE.dataManagement);
  } finally {
    f.store.close();
  }
});

test('数据管理订单的预估成本：新建和没有成本的订单摊开成空的几项（不是一个文本框），都空着按没有预估成本存；填了就按填的存', () => {
  const f = basics();
  try {
    const template = f.service.list('orders', f.who).template;
    const shown = editableInput('orders', template);
    assert.deepEqual(shown.costs, { material: null, processing: null, waste: null, other: null, basis: '' });
    // 编辑窗里单价只填元（分由它算出来）
    const line = { ...linesOf(shown)[0], productId: f.product.id, quantity: 10, unitPriceExact: '1' };
    // 几项都空着：没有预估成本
    const blank = firstResult(f.service.execute(
      command('orders', 'create', [], submittedInput('orders', { ...shown, customerId: f.customer.id, deliveryDate: '2026-12-31', lines: [line] })),
      f.who,
      's',
    ));
    assert.equal(blank.costs, null);
    // 已有订单（夹具里没有成本）编辑时也摊开；填了几项和依据：按填的存
    const record = must(f.service.list('orders', f.who).records.find((r) => r.record.id === blank.id), '订单记录');
    const edit = editableInput('orders', record.input);
    const costs = edit.costs;
    assert.ok(isJsonObject(costs), '摊开成一组');
    assert.deepEqual(Object.keys(costs), ['material', 'processing', 'waste', 'other', 'basis']);
    // 编辑窗里按元填，存的是分
    edit.costs = { material: '1', processing: '0.5', waste: '0.10', other: '0', basis: '虚构估算' };
    f.service.execute(command('orders', 'update', [blank], submittedInput('orders', edit)), f.who, 's');
    assert.deepEqual(must(sales(f.store).order(blank.id, true), '保存后订单').costs, { material: 100, processing: 50, waste: 10, other: 0, basis: '虚构估算' });
    // 只填了一部分：照样提交，由校验提示缺哪项（规则没改）
    const partial = { ...edit, costs: { material: '1', processing: null, waste: null, other: null, basis: '' } };
    const current = must(sales(f.store).order(blank.id, true), '订单');
    assert.throws(
      () => f.service.execute(command('orders', 'update', [current], submittedInput('orders', partial)), f.who, 's'),
      /加工成本（元）：请填写有效金额/,
    );
    // 别的模块不动
    assert.equal(submittedInput('products', { costs: null }).costs, null);
    assert.equal(editableInput('purchases', { costs: null }).costs, null);
  } finally {
    f.store.close();
  }
});
test('数据管理订单编辑窗：预估成本填得不对，原因写在那一格下面并标红，光标放过去；服务端退回的原因是通顺的中文、滚到能看见', () => {
  const f = basics();
  try {
    const record = must(f.service.list('orders', f.who).records.find((r) => r.record.id === f.order.id), '订单记录');
    const shown = editableInput('orders', record.input);
    // 几项格式不对的一起说，每一格的原因分开记（编辑窗按字段路径写在那一格下面）；整句不出现“。；”
    const bad = { ...shown, costs: { material: '1.234', processing: '0', waste: '10000000', other: '0', basis: '虚构估算' } };
    let thrown: unknown;
    try {
      submittedInput('orders', bad);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof RecordInputError, '格式不对抛出带字段的错误');
    assert.deepEqual(thrown.fields, {
      'costs.material': '请填写金额（元），最多两位小数',
      'costs.waste': '金额太大，不能超过 1000000 元',
    });
    assert.equal(thrown.message, '材料成本（元）：请填写金额（元），最多两位小数；损耗成本（元）：金额太大，不能超过 1000000 元。');
    assert.equal(valueAt(bad, 'costs.waste'), '10000000');
    // 编辑窗：出错的那一格标红（aria-invalid）、原因写在格子下面（role=alert）；别的格不标；顶上不再重复一遍
    const html = renderToStaticMarkup(
      h(DataManagementRecordDialog, {
        module: 'orders',
        editing: record,
        input: bad,
        setInput: () => {},
        busy: false,
        error: '',
        fieldErrors: thrown.fields,
        refs: null,
        save: () => {},
        close: () => {},
      }),
    );
    const field = (label: string) => html.slice(html.lastIndexOf('<label', html.indexOf('>' + label + '<')), html.indexOf('</label>', html.indexOf('>' + label + '<')));
    assert.match(field('材料成本（元）'), /aria-invalid="true"/);
    assert.match(field('材料成本（元）'), /class="form-field-error" role="alert">请填写金额（元），最多两位小数</);
    assert.match(field('损耗成本（元）'), /金额太大，不能超过 1000000 元/);
    assert.doesNotMatch(field('加工成本（元）'), /aria-invalid|form-field-error/);
    assert.doesNotMatch(html, /form-message/);
    // 点保存时滚过去：有顶上的报错滚到它，没有就把光标放到第一个标红的格子；改着某一格时不抢光标
    const dialog = readFileSync('src/admin/DataManagementRecordDialog.tsx', 'utf8');
    assert.match(dialog, /messageRef\.current\?\.firstElementChild\?\.scrollIntoView/);
    assert.match(dialog, /querySelector<HTMLElement>\('\[aria-invalid="true"\]'\)[\s\S]*?\.focus\(/);
    assert.match(dialog, /\}, \[attempt, error\]\);/);
    assert.match(dialog, /setAttempt\(\(n\) => n \+ 1\);\s*save\(\);/);
    const editor = readFileSync('src/admin/DataManagementEditor.tsx', 'utf8');
    assert.match(editor, /e instanceof RecordInputError[\s\S]*?setFieldErrors\(e\.fields\)/);
    // 服务端：只填了一项，其余几项和依据空着，退回的原因按编辑窗的叫法、中文冒号、整句，不写“预估成本 加工成本: …”
    const partial = { ...shown, costs: { material: '1', processing: null, waste: null, other: null, basis: '' } };
    const sent = command('orders', 'update', [record.record], submittedInput('orders', partial));
    assert.throws(
      () => f.service.execute(sent, f.who, 's'),
      (e: Error) =>
        e.message === '加工成本（元）：请填写有效金额；损耗成本（元）：请填写有效金额；其他成本（元）：请填写有效金额；估算依据：请说明估算依据',
    );
    // 失败的审计记的也是这句
    const failed = one(f.store.db, rows.business_audit.pick({ document: true }), "SELECT document FROM business_audit WHERE action='failed-update' ORDER BY id DESC LIMIT 1");
    assert.match(String(failed?.document), /加工成本（元）：请填写有效金额/);
    // 明细里的格子写第几行
    const line = command('orders', 'update', [record.record], { lines: [{ ...record.input.lines[0], quantity: -1 }] });
    assert.throws(
      () => f.service.execute(line, f.who, 's'),
      (e: Error) => /^明细第1项的数量：/.test(e.message) && !/[A-Za-z]|: /.test(e.message),
    );
    // 助手发的照旧交出原始校验结果（助手按每个字段的路径告诉模型缺什么）
    assert.throws(() => f.service.execute({ ...sent, requestId: randomUUID() }, f.who, 's', 'management-assistant'), ZodError);
  } finally {
    f.store.close();
  }
});

