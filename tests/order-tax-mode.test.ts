// 订单和订单明细的含税口径只收三项（含税、未税、未明确）：页面保存、数据管理、识别导入同一条录入规则
// （shared/core/domain.ts 的 orderTaxModes）。库里已有的别的写法不猜着归并：照原样读出来，改订单时要人改选，报错带原值。
// 只管录入，不加数据库约束，所以库里旧的写法要直接写库来造。
import { sales } from '../server/sales/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { count } from '../server/core/sql.js';
import { changeOrderStatus } from '../server/orders/index.js';
import { fieldNamer, orderSchema, userError } from '../shared/core/index.js';
import { evaluateDraft } from '../shared/import/index.js';
import { actor } from './actor-fixture.js';
import { businessBase, manualWrite } from './business-base-fixture.js';
import { basics, command, shownError } from './data-management-fixture.js';
import { asDraft } from './order-import-fixture.js';

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

test('库里已有的别的写法：原样读出，不归并；改订单时不改选会被拦，改选后保存、版本加一、记审计', () => {
  const base = businessBase(actor),
    customer = base.customer(),
    product = base.product();
  const created = base.order(customer, [{ productId: product.id, quantity: 10, unitPriceCents: 100 }], { taxMode: '含税' });
  base.store.db.prepare("UPDATE orders SET tax_mode='不含税' WHERE id=?").run(created.id);
  const old = sales(base.store).order(created.id) ?? assert.fail('订单读不到');
  assert.equal(old.taxMode, '不含税', '读出来照原样，不换成未税');
  const audits = () => count(base.store.db, 'SELECT COUNT(*) n FROM business_audit');
  const before = audits();
  const update = (fields: Record<string, unknown>) =>
    manualWrite(base.store, { entity: 'orders', action: 'update', id: old.id, input: { ...old, ...fields } }, actor);
  assert.throws(() => update({ notes: '只改备注' }), /只能选含税、未税、未明确（现在写的是“不含税”）/);
  assert.equal(sales(base.store).order(old.id)?.version, old.version, '被拦下时版本不变');
  assert.equal(audits(), before);
  const saved = update({ notes: '改选了', taxMode: '未税' });
  assert.deepEqual([saved.taxMode, saved.version], ['未税', old.version + 1]);
  assert.equal(audits(), before + 1);
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

test('数据管理：库里有旧写法的订单，订单列表照样打开，编辑窗带着原值（整单和明细）等人改选', () => {
  const f = basics();
  try {
    f.store.db.prepare("UPDATE orders SET tax_mode='不含税' WHERE id=?").run(f.order.id);
    f.store.db.prepare("UPDATE order_lines SET tax_mode='含13%' WHERE order_id=?").run(f.order.id);
    const listed = f.service.list('orders', f.who).records.find((r) => r.record.id === f.order.id) ?? assert.fail('订单没列出来');
    const input = z.looseObject({ taxMode: z.string(), lines: z.array(z.looseObject({ taxMode: z.string() })) }).parse(listed.input);
    assert.deepEqual([input.taxMode, input.lines[0].taxMode], ['不含税', '含13%']);
  } finally {
    f.store.close();
  }
});

test('订单状态动作（确认、取消）不是编辑：库里的旧写法照原样留着，不拦', () => {
  const base = businessBase(actor),
    customer = base.customer(),
    product = base.product();
  const created = base.order(customer, [{ productId: product.id, quantity: 10, unitPriceCents: 100 }], { status: '待确认' });
  base.store.db.prepare("UPDATE orders SET tax_mode='不含税' WHERE id=?").run(created.id);
  base.store.db.prepare("UPDATE order_lines SET tax_mode='含13%' WHERE order_id=?").run(created.id);
  const confirmed = changeOrderStatus(base.store, created.id, 'confirm', { requestId: randomUUID(), expectedVersion: created.version }, actor);
  assert.deepEqual([confirmed.status, confirmed.taxMode, confirmed.lines[0].taxMode], ['已确认', '不含税', '含13%']);
  const cancelled = changeOrderStatus(
    base.store,
    created.id,
    'cancel',
    { requestId: randomUUID(), expectedVersion: confirmed.version, reason: '虚构：客户撤单' },
    actor,
  );
  assert.deepEqual([cancelled.status, cancelled.taxMode], ['已取消', '不含税']);
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
