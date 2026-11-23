// 订单和订单明细的含税口径只收三项（含税、未税、未明确）：页面保存、数据管理、识别导入同一条录入规则
// （shared/core/domain.ts 的 orderTaxModes）。库里的规范值受约束，原件写法单独保留。
import { sales } from '../../server/sales/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { count } from '../../server/core/index.js';
import { changeOrderStatus } from '../../server/orders/index.js';
import { fieldNamer, hasUnrecognizedTaxRate, orderSchema, orderTaxOriginal, userError } from '../../shared/core/index.js';
import { evaluateDraft } from '../../shared/import/index.js';
import { actor } from '../support/actor-fixture.js';
import { businessBase, manualWrite } from '../support/business-base-fixture.js';
import { basics, command, shownError } from '../support/data-management-fixture.js';
import { flowFixture } from '../support/flow-fixture.js';
import { shipOnDocDate } from '../support/ship-date.js';
import { asDraft } from '../support/order-import-fixture.js';

const order = (fields: Record<string, unknown> = {}, line: Record<string, unknown> = {}) => ({
  customerId: 1,
  orderDate: '2026-10-01',
  deliveryDate: '2026-10-30',
  status: '已确认',
  lines: [{ productId: 1, quantity: 10, unitPriceCents: 100, ...line }],
  ...fields,
});
/** 校验没过时人看到的话（和服务端统一出错一样按订单的栏目叫法） */
const shown = (input: unknown) => {
  const parsed = orderSchema.safeParse(input);
  assert.ok(!parsed.success, '应当被拦下');
  return parsed.error.issues.map((i) => userError(i.path.join('.') + ': ' + i.message, fieldNamer('orders'))).join('；');
};

test('含税口径只收含税、未税、未明确；空着照旧收（明细空着跟整单）', () => {
  for (const taxMode of ['含税', '未税', '未明确', '', undefined, null])
    assert.ok(orderSchema.safeParse(order({ taxMode }, { taxMode })).success, String(taxMode));
});

test('别的写法（不含税、英文）整单和明细都拦下，报错说清只能选哪三项、原来写的是什么', () => {
  assert.equal(shown(order({ taxMode: '不含税' })), '含税口径：只能选含税、未税、未明确（现在写的是“不含税”），请改选');
  assert.equal(
    shown(order({}, { taxMode: 'exclusive' })),
    '明细第1项的本项含税口径：只能选含税、未税、未明确（现在写的是“exclusive”），请改选',
  );
});

test('页面保存订单：别的写法被拒、不落库不记审计；三项之一照常保存并记审计', () => {
  const base = businessBase(actor),
    customer = base.customer(),
    product = base.product();
  const input = (taxMode: string) => order({ customerId: customer.id, taxMode }, { productId: product.id });
  const audits = () => count(base.store.db, 'SELECT COUNT(*) n FROM business_audit');
  assert.throws(() => manualWrite(base.store, { entity: 'orders', action: 'create', input: input('不含税') }, actor), ZodError);
  assert.equal(count(base.store.db, 'SELECT COUNT(*) n FROM orders'), 0);
  assert.equal(audits(), 0);
  const saved = manualWrite(base.store, { entity: 'orders', action: 'create', input: input('含税') }, actor);
  assert.equal(sales(base.store).order(saved.id)?.taxMode, '含税');
  assert.equal(audits(), 1);
});

test('规范税率写入整数万分比，省略沿用、显式留空清除，原件写法仍保留', () => {
  const base = businessBase(actor),
    customer = base.customer(),
    product = base.product();
  try {
    const line = { productId: product.id, quantity: 10, unitPriceCents: 100 };
    const created = base.order(customer, [{ ...line, taxRate: 0.5, taxText: '０．５％' }], { taxRate: 0, taxText: '0%' });
    const db = base.store.db;
    assert.equal(db.prepare('SELECT tax_rate_bp FROM orders WHERE id=?').get(created.id)?.tax_rate_bp, 0);
    assert.equal(db.prepare('SELECT tax_rate_bp FROM order_lines WHERE order_id=?').get(created.id)?.tax_rate_bp, 50);
    const carried = sales(base.store).saveOrder(orderSchema.parse(order(
      { customerId: customer.id }, { ...line, id: created.lines[0].id },
    )), created.id, created.version);
    assert.deepEqual([carried.taxRate, carried.lines[0].taxRate], [0, 0.5]);
    const cleared = sales(base.store).saveOrder(orderSchema.parse({
      ...carried, taxRate: null, lines: carried.lines.map((l) => ({ ...l, taxRate: null })),
    }), carried.id, carried.version);
    assert.deepEqual([cleared.taxRate, cleared.taxText, cleared.lines[0].taxRate, cleared.lines[0].taxText], [undefined, undefined, undefined, undefined]);
    const withModeNote = base.order(customer, [{ ...line, taxRate: 13, taxText: '13%\n口径：按约定' }], { taxText: '13个点' });
    const clearedNote = sales(base.store).saveOrder(orderSchema.parse({
      ...withModeNote, taxRate: null, lines: withModeNote.lines.map((l) => ({ ...l, taxRate: null })),
    }), withModeNote.id, withModeNote.version);
    assert.deepEqual([clearedNote.taxText, clearedNote.lines[0].taxText], ['13个点', '口径：按约定']);
  } finally {
    base.store.close();
  }
});

test('订单与明细税率只收 0 到 100 最多两位小数的数字', () => {
  for (const taxRate of [0, 0.13, 13.14, 99.99, 100, null, undefined])
    assert.ok(orderSchema.safeParse(order({ taxRate }, { taxRate })).success, String(taxRate));
  for (const taxRate of ['13', '13%', -0.01, 13.123, 100.01]) {
    assert.match(shown(order({ taxRate })), /税率/);
    assert.match(shown(order({}, { taxRate })), /本项税率/);
  }
});

test('新送货单抄明细的规范税率或原话，明细没填时跟整单', () => {
  const f = flowFixture();
  try {
    f.stockIn('100');
    const cases = [
      { head: { taxRate: 13 }, line: { taxRate: 0, taxText: '０％' }, expected: '0' },
      { head: { taxRate: 13 }, line: { taxRate: 0.13 }, expected: '0.13%' },
      { head: { taxRate: 13 }, line: { taxText: '0.13' }, expected: '0.13' },
      { head: { taxRate: 13 }, line: { taxText: '口径：按约定' }, expected: '13' },
      { head: { taxRate: 1.5 }, line: {}, expected: '1.5' },
      { head: {}, line: {}, expected: undefined },
    ];
    for (const { head, line, expected } of cases) {
      const saved = f.base.order(f.customer, [f.base.line(f.product, 10, line)], head);
      const [item] = saved.lines;
      const d = f.draft('delivery', {
        customerId: f.customer.id,
        lines: [{ orderId: saved.id, orderLineId: item.id, stockId: f.finished.id, quantity: '1' }],
      });
      f.confirmId(d.id, shipOnDocDate(f.flow, d.id));
      assert.equal(f.flow.get(d.id, 'delivery').lines[0].taxRate, expected);
    }
    // “口径：…”行与已识别旧原话不误报“税率没认出来”
    assert.equal(hasUnrecognizedTaxRate('口径：按约定', ''), false);
    assert.equal(orderTaxOriginal('口径：按约定', ''), '原件写法：口径：按约定');
    assert.equal(hasUnrecognizedTaxRate('13%', ''), false);
    assert.equal(orderTaxOriginal('13%', ''), '原件写法：13%');
    assert.equal(hasUnrecognizedTaxRate('13个点', ''), true);
    assert.match(orderTaxOriginal('13个点', ''), /税率没认出来/);
  } finally {
    f.store.close();
  }
});

test('数据管理改订单：别的写法被拒、提示说清；改成三项之一能保存，同一请求重发不再改一次', () => {
  const f = basics();
  try {
    const bad = command('orders', 'update', [f.order], { taxMode: '不含税' });
    assert.match(shownError(() => f.service.execute(bad, f.who, 's')), /含税口径：只能选含税、未税、未明确（现在写的是“不含税”），请改选/);
    assert.equal(sales(f.store).order(f.order.id, true)?.version, f.order.version);
    const good = command('orders', 'update', [f.order], { taxMode: '未税' });
    f.service.execute(good, f.who, 's');
    const after = sales(f.store).order(f.order.id, true) ?? assert.fail('订单读不到');
    assert.deepEqual([after.taxMode, after.version], ['未税', f.order.version + 1]);
    f.service.execute(good, f.who, 's');
    assert.equal(sales(f.store).order(f.order.id, true)?.version, after.version, '同一请求重发原样返回，不再改一次');
  } finally {
    f.store.close();
  }
});

test('数据管理的订单录入值分别带上规范税率与原件写法', () => {
  const f = basics();
  try {
    f.store.db.prepare("UPDATE orders SET tax_rate_bp=150,tax_mode='未税',tax_text='1.5%' WHERE id=?").run(f.order.id);
    f.store.db.prepare("UPDATE order_lines SET tax_text='口径：含13%' WHERE order_id=?").run(f.order.id);
    const listed = f.service.list('orders', f.who).records.find((r) => r.record.id === f.order.id) ?? assert.fail('订单没列出来');
    const input = orderSchema.parse(listed.input);
    assert.deepEqual([input.taxRate, input.taxMode, input.taxText, input.lines[0].taxText], [1.5, '未税', '1.5%', '口径：含13%']);
  } finally {
    f.store.close();
  }
});

test('确认、取消订单保留规范税费和待核对的原件写法', () => {
  const base = businessBase(actor),
    customer = base.customer(),
    product = base.product();
  const created = base.order(
    customer, [{ productId: product.id, quantity: 10, unitPriceCents: 100, taxText: '口径：含13%' }],
    { status: '待确认', taxRate: 0, taxMode: '未税', taxText: '0%' },
  );
  const confirmed = changeOrderStatus(base.store, created.id, 'confirm', { requestId: randomUUID(), expectedVersion: created.version }, actor);
  assert.deepEqual([confirmed.status, confirmed.taxRate, confirmed.taxMode, confirmed.lines[0].taxText], ['已确认', 0, '未税', '口径：含13%']);
  const cancelled = changeOrderStatus(
    base.store,
    created.id,
    'cancel',
    { requestId: randomUUID(), expectedVersion: confirmed.version, reason: '虚构：客户撤单' },
    actor,
  );
  assert.deepEqual([cancelled.status, cancelled.taxRate, cancelled.taxText], ['已取消', 0, '0%']);
});

test('识别结果：原件没写含税口径只提醒核对；写了别的说法报错要人改选，不猜着归并', () => {
  const draft = asDraft();
  draft.header.taxMode.value = null;
  const blank = evaluateDraft(draft).issues.filter((i) => i.path === 'header.taxMode');
  assert.deepEqual(blank.map((i) => i.severity), ['review']);
  draft.header.taxMode.value = '不含税';
  draft.lines[0].fields.taxMode.value = '含13%';
  const issues = evaluateDraft(draft).issues.filter((i) => i.path.endsWith('taxMode') && i.severity === 'error');
  assert.deepEqual(
    issues.map((i) => i.message),
    ['含税口径原件写的是“不含税”，请改选含税、未税、未明确之一。', '含税口径原件写的是“含13%”，请改选含税、未税、未明确之一。'],
  );
});
