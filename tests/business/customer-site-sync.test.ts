// 改厂区资料时没出库的送货单跟着更新（server/flow/rules/site-edits.ts，用户 2026-11-28 定“自动跟着改”）：
// 厂区名称、地址、联系人、联系方式变了，挂着它的待送货单（含已归档的）在同一保存点里换新、版本加一、留修改历史；
// 已出库、已取消、已撤销的一字不动；没变的不写。编辑窗、数据管理、助手卡片都走订单服务同一个函数。内存库、虚构数据。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { localAdministratorActor, type Actor } from '../../server/core/index.js';
import { financeFacts } from '../../server/flow/index.js';
import { recordContext } from '../../server/overview/record-context.js';
import { DataManagementService } from '../../server/admin/data-management-service.js';
import { sales } from '../../server/sales/index.js';
import { deliveryForm } from '../../server/documents/delivery-form.js';
import { docFieldKey } from '../../shared/documents/index.js';
import { today, type Customer } from '../../shared/core/index.js';
import { historyView, type FlowDocView } from '../../shared/business/index.js';
import { actor, superActor } from '../support/actor-fixture.js';
import { autoConfirmAssistant } from '../support/assistant-fixture.js';
import { businessBase, manualWrite } from '../support/business-base-fixture.js';

const east = { name: '虚构东厂', contact: '王工', phone: '0001', address: '虚构一路', notes: '', isDefault: true };
const west = { name: '虚构西厂', contact: '李工', phone: '0002', address: '虚构二路', notes: '', isDefault: false };
/** 送货单的收货信息：厂区编号、厂区名、地址、联系人、联系方式 */
const destination = ({ siteId, siteName, address, contact, phone }: FlowDocView<'delivery'>) => [siteId, siteName, address, contact, phone];
const SYNC = 'sync-delivery-site';

function world(t: TestContext, who: Actor = actor, base = businessBase(who)) {
  t.after(() => base.store.close());
  const customer = manualWrite(base.store, { entity: 'customers', action: 'create', input: { name: '虚构同步客户', sites: [east, west] } }, who);
  const product = base.product();
  const stock = base.finished(product, {}, { date: today(), quantity: '100' });
  const order = base.order(customer, [base.line(product, 100)]);
  /** 一张挂在 site 上的待送货单 */
  const pending = (siteId: number) =>
    base.flow.save('delivery', {
      date: today(),
      customerId: customer.id,
      siteId,
      lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: stock.id, quantity: '1' }],
    }, who);
  /** 客户现在的样子（含厂区） */
  const current = (): Customer => {
    const c = sales(base.store).customer(customer.id, true);
    assert.ok(c);
    return c;
  };
  /** 页面上改客户：sites 是整组厂区 */
  const update = (sites: unknown[], patch: Record<string, unknown> = {}) => {
    const { sites: _sites, ...header } = current();
    return manualWrite(base.store, { entity: 'customers', action: 'update', id: customer.id, input: { ...header, ...patch, sites } }, who);
  };
  const get = (d: { id: number }) => base.flow.get(d.id, 'delivery');
  const history = (d: { id: number }) => recordContext(base.store, 'delivery', d.id, superActor()).history.filter((e) => e.action === SYNC);
  return { ...base, customer, pending, current, update, get, history, who };
}

test('改厂区地址：挂着它的待送货单四项换新、版本加一，修改历史写明哪个客户的哪个厂区带过来的', (t) => {
  const f = world(t), [e, w] = f.customer.sites;
  const d = f.pending(e.id);
  f.update([{ ...e, address: '虚构新地址', contact: '赵工' }, w]);
  const after = f.get(d);
  assert.deepEqual(destination(after), [e.id, east.name, '虚构新地址', '赵工', east.phone]);
  assert.equal(after.version, d.version + 1);
  const [entry, ...more] = f.history(d);
  assert.ok(entry, '有一条同步的修改历史');
  assert.equal(more.length, 0);
  const view = historyView({ module: 'delivery', action: SYNC, detail: entry.detail, recordId: d.id }, recordContext(f.store, 'delivery', d.id, superActor()).historyRefs);
  const text = view.items.map((i) => i.label + '：' + i.value);
  assert.ok(text.some((s) => s.includes('虚构一路 → 虚构新地址')), text.join('\n'));
  assert.ok(text.some((s) => s.startsWith('原因：') && s.includes('虚构同步客户') && s.includes('虚构东厂')), text.join('\n'));
});

test('改厂区名称：待送货单上的厂区名换新', (t) => {
  const f = world(t), [e, w] = f.customer.sites;
  const d = f.pending(e.id);
  f.update([{ ...e, name: '虚构东厂新名' }, w]);
  assert.deepEqual(destination(f.get(d)), [e.id, '虚构东厂新名', east.address, east.contact, east.phone]);
});

test('已出库、已取消、已撤销的送货单一字不动：收货信息、版本号、更新时间都不变', (t) => {
  const f = world(t), [e, w] = f.customer.sites;
  const shipped = f.check(f.pending(e.id), { shipDate: today() });
  const cancelled = f.pending(e.id);
  f.flow.cancel(cancelled.id, { version: cancelled.version, reason: '虚构：不送了', acknowledged: true }, f.who);
  const reversed = f.check(f.pending(e.id), { shipDate: today() });
  f.flow.reverse(reversed.id, { version: f.flow.get(reversed.id).version, reason: '虚构：发错了', acknowledged: true }, f.who);
  const before = [shipped, cancelled, reversed].map((d) => f.get(d));
  assert.deepEqual(before.map((d) => d.status), ['confirmed', 'cancelled', 'reversed']);
  f.update([{ ...e, address: '虚构新地址', name: '虚构东厂新名' }, w]);
  for (const d of before) {
    const after = f.get(d);
    assert.deepEqual([destination(after), after.version, after.updatedAt], [destination(d), d.version, d.updatedAt], d.number);
    assert.deepEqual(f.history(d), []);
  }
});

test('归档了的待送货单也跟着换', (t) => {
  const f = world(t), [e, w] = f.customer.sites;
  const d = f.pending(e.id);
  // 现在待送货单归档不了（归档前会拦），库里归档了的是以前留下的：直接打归档标记，和 record-context.test.ts 同一个做法
  f.store.db.prepare('INSERT INTO record_lifecycle(entity,record_id,archived_at,actor_id) VALUES(?,?,?,?)').run('flow_delivery', d.id, '虚构归档', f.who.id);
  f.update([{ ...e, phone: '9999' }, w]);
  const after = f.flow.get(d.id, 'delivery');
  assert.equal(after.archived, true);
  assert.equal(after.phone, '9999');
  assert.equal(after.version, d.version + 1);
});

test('同客户别的厂区的待送货单不动；只改默认、备注或客户抬头，单上已经是新值时也不动', (t) => {
  const f = world(t), [e, w] = f.customer.sites;
  const onEast = f.pending(e.id), onWest = f.pending(w.id);
  f.update([{ ...e, address: '虚构新地址' }, w]);
  const westAfter = f.get(onWest);
  assert.deepEqual([destination(westAfter), westAfter.version], [destination(onWest), onWest.version]);
  const synced = f.get(onEast);
  const now = f.current().sites;
  f.update([{ ...now[0], isDefault: false, notes: '虚构备注' }, { ...now[1], isDefault: true }], { contact: '虚构抬头联系人' });
  f.update(now.map((s) => ({ ...s })));
  for (const [d, was] of [[onEast, synced], [onWest, westAfter]] as const) assert.equal(f.get(d).version, was.version, d.number);
  assert.equal(f.history(onEast).length, 1);
  assert.equal(f.history(onWest).length, 0);
});

test('删厂区照旧：待送货单用着就拦，整次保存撤回，送货单不动', (t) => {
  const f = world(t), [e, w] = f.customer.sites;
  const d = f.pending(w.id);
  assert.throws(() => f.update([{ ...e, address: '虚构新地址' }]), (err: unknown) => err instanceof Error && err.message.includes(d.number));
  assert.equal(f.get(d).version, d.version);
  assert.equal(f.current().sites[0].address, east.address);
});

test('财务不受影响：待送货单不进财务的来源，同步前后来源清单一样', (t) => {
  const f = world(t), [e, w] = f.customer.sites;
  f.check(f.pending(e.id), { shipDate: today() });
  f.pending(e.id);
  const before = financeFacts.sources.heads(f.store.db);
  f.update([{ ...e, address: '虚构新地址' }, w]);
  assert.deepEqual(financeFacts.sources.heads(f.store.db), before);
});

test('数据管理改厂区地址也走同一条规则', (t) => {
  const owner = localAdministratorActor(superActor());
  const f = world(t, owner), [e, w] = f.customer.sites;
  const d = f.pending(e.id);
  const c = f.current();
  new DataManagementService(f.store).execute(
    { requestId: randomUUID(), module: 'customers', action: 'update', items: [{ id: c.id, version: c.version }], patch: { sites: [{ ...e, address: '虚构管理地址' }, w] }, reason: '虚构维护' },
    owner,
    's',
  );
  assert.equal(f.get(d).address, '虚构管理地址');
  assert.equal(f.history(d).length, 1);
});

test('助手卡片：出卡片时试执行不落库、卡片列出连带的送货单；确认执行才换', (t) => {
  const a = autoConfirmAssistant();
  const who = localAdministratorActor(superActor());
  const f = world(t, who, businessBase(who, a.store)), [e, w] = f.customer.sites;
  const d = f.pending(e.id);
  const tools = a.manager.tools;
  const plan = tools.prepare('records.propose_save', { module: 'customers', id: f.customer.id, patch: { sites: [{ ...e, address: '虚构助手地址' }, w] } }, who, 'card');
  const lines = (plan.summary ?? []).map((l) => l.label + '：' + l.value);
  assert.ok(lines.some((l) => l.startsWith('连带：') && l.includes(d.number) && l.includes('虚构一路 → 虚构助手地址')), lines.join('\n'));
  assert.deepEqual([f.get(d).address, f.get(d).version], [east.address, d.version], '出卡片不落库');
  tools.commit(plan, who, 'card');
  assert.deepEqual([f.get(d).address, f.get(d).version], ['虚构助手地址', d.version + 1]);
});

// ---------- 客户改名（第六轮）：单上存了客户名的待送货单跟着换 ----------
// 待送货单平常不存客户名（显示、导出、台账用客户档案的现名），只有订单换客户连带改过的待送货单单上存着客户名，
// 改名只换这种；没存的单显示的已经是新名，不写、不加版本、不留历史（复审 R6-1，协调者定）。

/**
 * 单上存了客户名的待送货单：先给别的客户下单、排一张待送货单，再由本机管理员把订单改给这个客户
 * （订单换客户连带改送货单会写上客户名，server/flow/rules/order-edit-cascade.ts 的 changeCustomer）
 */
function namedPending(f: ReturnType<typeof world>) {
  const other = manualWrite(f.store, { entity: 'customers', action: 'create', input: { name: '虚构原客户' } }, f.who);
  const product = f.product({ name: '虚构换客户纸箱' });
  const stock = f.finished(product, { name: '虚构换客户成品' }, { date: today(), quantity: '10' });
  const order = f.order(other, [f.line(product, 10)]);
  const d = f.flow.save('delivery', { date: today(), customerId: other.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: stock.id, quantity: '1' }] }, f.who);
  const current = sales(f.store).order(order.id);
  assert.ok(current);
  manualWrite(f.store, { entity: 'orders', action: 'update', id: order.id, input: { ...current, customerId: f.customer.id } }, f.who);
  const moved = f.get(d);
  assert.deepEqual([moved.customerId, moved.customerName], [f.customer.id, f.customer.name], '单上存着这个客户的名字');
  return moved;
}
/** 本机管理员办的（订单换客户要本机管理员） */
const ownerWorld = (t: TestContext) => world(t, localAdministratorActor(superActor()));

test('客户改名：单上存了客户名的待送货单换新名、加一个版本、一条历史写明改了名称；普通待送货单和已出库、已取消的都不动', (t) => {
  const f = ownerWorld(t), [e, w] = f.customer.sites;
  const named = namedPending(f);
  const plain = [f.pending(e.id), f.pending(w.id)];
  const shipped = f.check(f.pending(e.id), { shipDate: today() });
  const cancelled = f.pending(w.id);
  f.flow.cancel(cancelled.id, { version: cancelled.version, reason: '虚构：不送了', acknowledged: true }, f.who);
  const kept = [...plain, shipped, cancelled].map((d) => f.get(d));
  f.update(f.current().sites, { name: '虚构同步客户新名' });
  const after = f.get(named);
  assert.deepEqual([after.customerName, after.version], ['虚构同步客户新名', named.version + 1]);
  const [entry, ...more] = f.history(named);
  assert.ok(entry && !more.length, '一条历史');
  const view = historyView({ module: 'delivery', action: SYNC, detail: entry.detail, recordId: named.id }, recordContext(f.store, 'delivery', named.id, superActor()).historyRefs);
  const text = view.items.map((i) => i.label + '：' + i.value);
  assert.ok(text.some((s) => s.startsWith('原因：') && s.includes('虚构同步客户新名') && s.includes('名称')), text.join('\n'));
  for (const d of kept) {
    const now = f.get(d);
    assert.deepEqual([now.customerName, now.version, now.updatedAt], [d.customerName, d.version, d.updatedAt], d.number);
    assert.deepEqual(f.history(d), [], d.number + ' 没有同步的历史');
  }
  // 普通待送货单单上没存客户名，一个字不写，导出的送货单照客户档案印的已经是新名
  for (const d of plain) {
    assert.equal(f.get(d).customerName, undefined);
    assert.ok(deliveryForm(f.store, d.id).form.fields.some(([key, value]) => key === docFieldKey('customer') && value === '虚构同步客户新名'), d.number);
  }
});

test('改名和改厂区一次保存：存了客户名的单只写一次、只加一个版本、一条历史；普通单只因厂区变了才写', (t) => {
  const f = ownerWorld(t);
  const named = namedPending(f);
  const sites = f.current().sites, e = sites[0];
  assert.equal(named.siteId, e.id, '换客户后挂在默认厂区');
  const plain = f.pending(e.id);
  f.update([{ ...e, address: '虚构新地址' }, ...sites.slice(1)], { name: '虚构同步客户新名' });
  const after = f.get(named);
  assert.deepEqual([after.customerName, after.address, after.version], ['虚构同步客户新名', '虚构新地址', named.version + 1]);
  assert.equal(f.history(named).length, 1);
  const plainAfter = f.get(plain);
  assert.deepEqual([plainAfter.customerName, plainAfter.address, plainAfter.version], [plain.customerName, '虚构新地址', plain.version + 1]);
  assert.equal(f.history(plain).length, 1);
});

test('助手卡片：改名时连带行写“旧名 → 新名”，没有“新名 → 新名”；数据管理只交名称也换，名称没变不写', (t) => {
  const a = autoConfirmAssistant();
  const owner = localAdministratorActor(superActor());
  const f = world(t, owner, businessBase(owner, a.store));
  const named = namedPending(f), plain = f.pending(f.customer.sites[0].id);
  const plan = a.manager.tools.prepare('records.propose_save', { module: 'customers', id: f.customer.id, patch: { name: '虚构同步客户新名' } }, owner, 'card');
  const lines = (plan.summary ?? []).map((l) => l.label + '：' + l.value);
  assert.ok(lines.some((l) => l.startsWith('连带：') && l.includes(named.number) && l.includes('虚构同步客户 → 虚构同步客户新名')), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('虚构同步客户新名 → 虚构同步客户新名')), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes(plain.number)), '普通待送货单不在连带里：' + lines.join('\n'));
  const service = new DataManagementService(f.store);
  const save = (patch: Record<string, unknown>) => {
    const c = f.current();
    service.execute({ requestId: randomUUID(), module: 'customers', action: 'update', items: [{ id: c.id, version: c.version }], patch, reason: '虚构维护' }, owner, 's');
  };
  save({ name: '虚构同步客户另一个名' });
  const after = f.get(named);
  assert.deepEqual([after.customerName, after.version], ['虚构同步客户另一个名', named.version + 1]);
  assert.equal(f.get(plain).version, plain.version);
  save({ notes: '虚构只改备注' });
  assert.equal(f.get(named).version, after.version, '名称没变不写');
});
