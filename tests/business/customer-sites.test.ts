import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { AppError } from '../../server/core/index.js';
import { sales } from '../../server/sales/index.js';
import { DEFAULT_SITE_NAME, today, type Customer } from '../../shared/core/index.js';
import {
  cardChanges,
  cardContents,
  financeFingerprint,
  flowDocumentContent,
  flowDocumentOfView,
  type FlowDocView,
} from '../../shared/business/index.js';
import { actor } from '../support/actor-fixture.js';
import { businessBase, manualWrite } from '../support/business-base-fixture.js';
import { deliveryCorrectionSetup } from '../support/delivery-correction-fixture.js';

const east = { name: '虚构东厂', contact: '王工', phone: '0001', address: '虚构一路', notes: '门卫登记', isDefault: true };
const west = { name: '虚构西厂', contact: '李工', phone: '0002', address: '虚构二路', notes: '', isDefault: false };
const destination = ({ siteId, siteName, address, contact, phone }: FlowDocView<'delivery'>) =>
  [siteId, siteName, address, contact, phone];

function fixture(t: TestContext) {
  const base = businessBase(actor);
  t.after(() => base.store.close());
  const create = (input: Record<string, unknown>) => manualWrite(base.store, { entity: 'customers', action: 'create', input }, actor);
  const update = (c: Customer, patch: Record<string, unknown>) => {
    const { sites: _sites, ...header } = c;
    return manualWrite(base.store, { entity: 'customers', action: 'update', id: c.id, input: { ...header, ...patch } }, actor);
  };
  return { ...base, create, update };
}

test('新建客户没交厂区或交空数组时都按非空联系方式建默认厂区', (t) => {
  const f = fixture(t);
  const a = f.create({ name: '虚构仅有联系人', contact: '王工' });
  assert.deepEqual(a.sites.map(({ id: _id, ...s }) => s), [
    { name: DEFAULT_SITE_NAME, contact: '王工', phone: '', address: '', isDefault: true, notes: '' },
  ]);
  const b = f.create({ name: '虚构无地址', address: ' \t　', sites: [] });
  const c = f.create({ name: '虚构交了空厂区', address: '虚构一路', sites: [] });
  assert.deepEqual(b.sites, []);
  assert.deepEqual(c.sites.map(({ id: _id, ...s }) => s), [
    { name: DEFAULT_SITE_NAME, contact: '', phone: '', address: '虚构一路', isDefault: true, notes: '' },
  ]);
  assert.deepEqual(sales(f.store).customers(true, [b.id, a.id]).map((r) => [r.id, r.sites]), [[b.id, []], [a.id, a.sites]]);
});

test('只改客户联系方式保留厂区，传整组可切换默认，传空数组清空', (t) => {
  const f = fixture(t);
  const a = f.create({ name: '虚构甲客户', sites: [east, west] });
  const b = f.update(a, { contact: '新联系人' });
  assert.equal(b.contact, '新联系人');
  assert.deepEqual(b.sites, a.sites);
  const c = f.update(b, { sites: b.sites.map((s) => ({ ...s, isDefault: !s.isDefault })) });
  assert.deepEqual(c.sites.map((s) => [s.id, s.isDefault]), [[a.sites[0].id, false], [a.sites[1].id, true]]);
  const d = f.update(c, { sites: [{ ...c.sites[0], isDefault: false }] });
  assert.deepEqual(d.sites.map((s) => [s.id, s.isDefault]), [[a.sites[0].id, true]]);
  assert.deepEqual(f.update(d, { sites: [] }).sites, []);
});

test('厂区重名、默认数量不对、编号重复或属于其他客户时整次保存撤回', (t) => {
  const f = fixture(t);
  const a = f.create({ name: '虚构甲客户', sites: [east, west] });
  const b = f.create({ name: '虚构乙客户', sites: [west] });
  for (const [sites, message] of [
    [[{ ...east, name: ' A B ' }, { ...west, name: 'ab' }], /重名/],
    [[{ ...east, isDefault: false }, west], /选择一个默认厂区/],
    [[east, { ...west, isDefault: true }], /选择一个默认厂区/],
    [[a.sites[0], { ...a.sites[0], name: '虚构第三厂' }], /重复提交/],
    [[b.sites[0]], /不属于这个客户/],
  ] as const) {
    assert.throws(() => f.update(a, { name: '这次不应保存', sites }), message);
    assert.deepEqual(sales(f.store).customer(a.id), a);
  }
  assert.throws(() => f.create({ name: '虚构不能新建', sites: [b.sites[0]] }), /不属于这个客户/);
  assert.deepEqual(sales(f.store).customers().map((c) => c.name), [b.name, a.name]);
});

function shipping(t: TestContext) {
  const f = fixture(t), date = today();
  const customer = f.create({ name: '虚构发货客户', sites: [east, west] });
  const product = f.product();
  const stock = f.finished(product, {}, { date, quantity: '100' });
  const input = (c: Customer) => {
    const order = f.order(c, [f.line(product, 100)]);
    return { date, customerId: c.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: stock.id, quantity: '5' }] };
  };
  return { ...f, customer, input };
}

test('录入时按所属厂区写快照，没厂区留空，待送货编辑刷新同一厂区的资料', (t) => {
  const f = shipping(t), a = f.customer, b = f.create({ name: '虚构无厂区客户' });
  const input = f.input(a);
  const d = f.flow.save('delivery', { ...input, address: '不使用手填地址' }, actor);
  assert.deepEqual(destination(d), [a.sites[0].id, east.name, east.address, east.contact, east.phone]);
  assert.deepEqual(destination(f.flow.save('delivery', f.input(b), actor)), [null, '', '', '', '']);
  assert.throws(() => f.flow.save('delivery', { ...f.input(b), siteId: a.sites[1].id }, actor),
    (e: unknown) => e instanceof AppError && e.status === 400 && /不属于这个客户/.test(e.message));
  const selected = f.flow.save('delivery', { ...input, siteId: a.sites[1].id, version: d.version }, actor, d.id);
  assert.deepEqual(destination(selected), [a.sites[1].id, west.name, west.address, west.contact, west.phone]);
  f.update(a, { sites: [a.sites[0], { ...a.sites[1], address: '虚构新收货地址' }] });
  const refreshed = f.flow.save('delivery', { ...selected, notes: '虚构备注' }, actor, d.id);
  assert.deepEqual(destination(refreshed), [a.sites[1].id, west.name, '虚构新收货地址', west.contact, west.phone]);
});

test('待送货单占用厂区时列出全部单号并回滚客户修改', (t) => {
  const f = shipping(t), a = f.customer;
  const drafts = [f.input(a), f.input(a)].map((input) => f.flow.save('delivery', { ...input, siteId: a.sites[1].id }, actor));
  assert.throws(() => f.update(a, { name: '这次不应改名', sites: [a.sites[0]] }),
    (e: unknown) => e instanceof AppError && e.status === 409 && drafts.every((d) => e.message.includes(d.number)));
  assert.deepEqual(sales(f.store).customer(a.id), a);
  assert.deepEqual(drafts.map((d) => f.flow.get(d.id, 'delivery').siteId), [a.sites[1].id, a.sites[1].id]);
});

test('解除已出库送货单的厂区引用保留快照与财务指纹，更正也沿用原快照', (t) => {
  const f = deliveryCorrectionSetup(t);
  const update = (c: Customer, sites: unknown[]) =>
    manualWrite(f.store, { entity: 'customers', action: 'update', id: c.id, input: { ...c, sites } }, actor);
  const customer = update(f.customer, [east, west]);
  const shipped = f.ship([[f.order, 0, '15']]);
  const fingerprint = (doc: FlowDocView<'delivery'>) => financeFingerprint('delivery', flowDocumentContent(flowDocumentOfView(doc)));
  const before = fingerprint(shipped);
  update(customer, [customer.sites[1]]);
  const history = f.flow.get(shipped.id, 'delivery');
  assert.deepEqual(destination(history), [null, east.name, east.address, east.contact, east.phone]);
  assert.equal(history.version, shipped.version);
  assert.equal(history.updatedAt, shipped.updatedAt);
  assert.deepEqual(fingerprint(history), before);
  const result = f.correct(shipped.id, [{ index: 0, quantity: '10' }]);
  assert.deepEqual(destination(f.flow.get(result.replacementId, 'delivery')), destination(history));
});

test('删掉厂区后已取消、已撤销的送货单只解除厂区引用，收货信息、版本号和更新时间都不变', (t) => {
  const f = shipping(t), a = f.customer;
  const pending = () => f.flow.save('delivery', { ...f.input(a), siteId: a.sites[1].id }, actor);
  const cancelled = pending();
  f.flow.cancel(cancelled.id, { version: cancelled.version, reason: '虚构：不送了', acknowledged: true }, actor);
  const reversed = f.check(pending(), { shipDate: today() });
  f.flow.reverse(reversed.id, { version: f.flow.get(reversed.id).version, reason: '虚构：发错了', acknowledged: true }, actor);
  const before = [cancelled.id, reversed.id].map((id) => f.flow.get(id, 'delivery'));
  assert.deepEqual(before.map((d) => d.status), ['cancelled', 'reversed']);
  f.update(a, { sites: [a.sites[0]] });
  for (const d of before) {
    const after = f.flow.get(d.id, 'delivery');
    assert.deepEqual(destination(after), [null, west.name, west.address, west.contact, west.phone]);
    assert.deepEqual([after.version, after.updatedAt], [d.version, d.updatedAt]);
  }
});

test('已解除厂区引用的历史送货单在摘要和变更比对中保留厂区快照名称且不漏报清空', () => {
  const detached = { siteId: null, siteName: east.name, address: east.address, contact: east.contact, phone: east.phone };
  assert.ok(cardContents('delivery', detached, {}).some((item) => item.label === '收货厂区' && item.value === east.name));
  assert.deepEqual(
    cardChanges(
      'delivery',
      { siteId: 1, siteName: east.name },
      { siteId: null, siteName: east.name },
      {},
      { top: new Set(['siteId']), lines: new Set() },
    ),
    [],
  );
  assert.deepEqual(
    cardChanges(
      'delivery',
      { siteId: null, siteName: east.name },
      { siteId: null, siteName: '' },
      {},
      { top: new Set(), lines: new Set() },
    ),
    [{ label: '收货厂区', value: east.name + ' → 未填写' }],
  );
});
