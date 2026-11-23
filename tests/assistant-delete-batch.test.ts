// 助手一次删几条（records.delete 给 ids）：和页面批量删除同一个删除引擎、同一个上限；一张卡片列出每一条和合起来的影响清单，
// 人点了才删；出卡片后有一条变了整张作废；密码、快照、审计、防重复和页面批量删除一样。一次一条的用法见 assistant-delete-cards。虚构数据。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Store, AppError, count, many, localAdministratorActor } from '../server/core/index.js';
import { businessBase } from './business-base-fixture.js';
import { DELETION_MAX_RECORDS, deletionSelection, impactRowSchema } from '../shared/business/index.js';
import { customerSchema, today } from '../shared/core/domain.js';
import { deletionImpactView } from '../src/recordkit/deletion-impact.js';
import { assistantFixture, cardDigest, lastCard } from './assistant-fixture.js';
import { actor, grant, superActor } from './actor-fixture.js';

const local = () => localAdministratorActor(superActor());
const noEffects = { read: () => {}, business: () => {}, workflow: () => {} };
/** 删除卡片的 after 就是删除预览：选了哪些、影响清单 */
const previewOf = z.object({ selection: deletionSelection, impact: z.array(impactRowSchema) });
/** 几个虚构客户（没有订单，删了不连带别的） */
const customers = (f: { store: Store }, names: string[]) => names.map((name) => businessBase(actor, f.store).customer({ name }));
const deletedCustomerAudits = (store: Store) =>
  many(store.db, z.object({ id: z.number() }), "SELECT record_id AS id FROM business_audit WHERE action='delete' AND entity='customers' ORDER BY record_id").map((r) => r.id);

test('一次删三个客户：一张卡片，卡片上三条都在、写明删 3 个；人点了才删，三条都删、各留一条删除审计', async () => {
  const f = assistantFixture();
  try {
    const who = local(),
      list = customers(f, ['虚构批删甲', '虚构批删乙', '虚构批删丙']);
    f.replies.push({ message: '', toolCalls: [{ name: 'records.delete', args: { module: 'customers', ids: list.map((c) => c.id) } }] });
    const card = lastCard(await f.say(f.manager.create(who).id, '把这三个客户都删了', {}, who));
    assert.equal(card.tool, 'records.delete');
    assert.equal(card.destructive, true);
    assert.equal(card.requiresPassword, false, '本机最高管理员不用再输密码');
    assert.match(card.label, /^删除 3 .*客户/);
    const preview = previewOf.parse(card.after);
    assert.deepEqual(preview.selection.items.map((i) => i.id), list.map((c) => c.id));
    assert.deepEqual(deletionImpactView(preview).deleted.map((l) => l.name), ['虚构批删甲', '虚构批删乙', '虚构批删丙']);
    assert.equal(sales(f.store).customers().length, 3, '没点确认不删');
    f.manager.execute(card.id, { acknowledged: true, deletionDigest: cardDigest(card) }, who, 's');
    assert.equal(sales(f.store).customers(true).length, 0);
    assert.deepEqual(deletedCustomerAudits(f.store), list.map((c) => c.id));
  } finally {
    f.close();
  }
});

test('出卡片以后其中一条被人改了：确认时整张卡片作废，三条都不删，说出是哪一条变了', async () => {
  const f = assistantFixture();
  try {
    const who = local(),
      list = customers(f, ['虚构作废甲', '虚构作废乙', '虚构作废丙']);
    f.replies.push({ message: '', toolCalls: [{ name: 'records.delete', args: { module: 'customers', ids: list.map((c) => c.id) } }] });
    const thread = f.manager.create(who),
      card = lastCard(await f.say(thread.id, '把这三个客户都删了', {}, who));
    const changed = list[1];
    sales(f.store).updateCustomer(customerSchema.parse({ name: changed.name, notes: '页面上刚改过' }), changed.id, changed.version);
    assert.throws(
      () => f.manager.execute(card.id, { acknowledged: true, deletionDigest: cardDigest(card) }, who, 's'),
      (e: unknown) => e instanceof AppError && e.code === 'card-stale' && e.message.includes('虚构作废乙') && !e.message.includes('虚构作废甲'),
    );
    assert.equal(sales(f.store).customers().length, 3, '一条都没删');
    assert.equal(count(f.store.db, "SELECT COUNT(*) FROM business_audit WHERE action='delete'"), 0);
    assert.equal(lastCard(f.manager.view(thread.id, who)).state, 'cancelled');
  } finally {
    f.close();
  }
});

test('一次最多删的条数和页面批量删除同一个上限：多一条参数校验就拒；id 和 ids 只给一样；一条的老用法照旧', async () => {
  const f = assistantFixture();
  try {
    const who = local(),
      [only] = customers(f, ['虚构单删客户']);
    const tooMany = Array.from({ length: DELETION_MAX_RECORDS + 1 }, (_, i) => i + 1);
    await assert.rejects(() => f.manager.registry.dispatch('records.delete', { module: 'customers', ids: tooMany }, who, noEffects), z.ZodError);
    await assert.rejects(() => f.manager.registry.dispatch('records.delete', { module: 'customers', id: only.id, ids: [only.id] }, who, noEffects), z.ZodError);
    const plan = f.manager.tools.prepare('records.delete', { module: 'customers', id: only.id }, who, 's');
    assert.deepEqual(previewOf.parse(plan.after).selection.items, [{ id: only.id, version: only.version }]);
  } finally {
    f.close();
  }
});

test('只读账号用不了删除命令，一次一条、一次几条都一样', async () => {
  const f = assistantFixture();
  try {
    const viewer = { ...actor, id: 'fictional-batch-viewer', permissions: grant() },
      list = customers(f, ['虚构只读甲', '虚构只读乙']);
    for (const args of [{ module: 'customers', id: list[0].id }, { module: 'customers', ids: list.map((c) => c.id) }])
      await assert.rejects(() => f.manager.registry.dispatch('records.delete', args, viewer, noEffects), /权限/);
    assert.equal(sales(f.store).customers().length, 2);
  } finally {
    f.close();
  }
});

test('密码和页面批量删除一样：几张都是待核对的不用密码；混着已核对的，不在本机要本人密码，核验了才一起删', async () => {
  const f = assistantFixture();
  try {
    const base = businessBase(actor, f.store),
      { flow } = base,
      supplier = base.supplier({ name: '虚构批删供应商' });
    const arrival = (reference: string) =>
      flow.save('arrival', { date: today(), supplierId: supplier.id, reference, lines: [{ item: { name: '虚构纸板', unit: '张' }, quantity: '10' }] }, actor);
    const drafts = [arrival('虚构待核对-1'), arrival('虚构待核对-2')],
      stocked = arrival('虚构已入库');
    base.check(stocked);
    const who = superActor();
    const exists = (id: number) => count(f.store.db, 'SELECT COUNT(*) FROM flow_documents WHERE id=?', id) === 1;
    const thread = f.manager.create(who);
    f.replies.push({ message: '', toolCalls: [{ name: 'records.delete', args: { module: 'arrivals', ids: drafts.map((d) => d.id) } }] });
    const draftCard = lastCard(await f.say(thread.id, '把这两张待入库的到货单删了', {}, who));
    assert.equal(draftCard.requiresPassword, false);
    f.manager.execute(draftCard.id, { acknowledged: true, deletionDigest: cardDigest(draftCard) }, who, 's', { proxy: true });
    assert.deepEqual(drafts.map((d) => exists(d.id)), [false, false]);
    const more = arrival('虚构待核对-3');
    f.replies.push({ message: '', toolCalls: [{ name: 'records.delete', args: { module: 'arrivals', ids: [more.id, stocked.id] } }] });
    const mixed = lastCard(await f.say(thread.id, '这两张也删了', {}, who));
    assert.equal(mixed.requiresPassword, true);
    const confirm = (review: { proxy?: boolean; passwordVerified?: boolean }) =>
      f.manager.execute(mixed.id, { acknowledged: true, deletionDigest: cardDigest(mixed) }, who, 's', review);
    assert.throws(() => confirm({ proxy: true }), /密码/);
    assert.deepEqual([exists(more.id), exists(stocked.id)], [true, true]);
    confirm({ proxy: true, passwordVerified: true });
    assert.deepEqual([exists(more.id), exists(stocked.id)], [false, false]);
  } finally {
    f.close();
  }
});

test('一次删几条照样先留恢复快照；同一张方案重放只回上次的结果，不再删、不多记审计', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-assistant-batch-delete-'));
  const f = assistantFixture([], { store: new Store(join(dir, 'erp.sqlite')) });
  try {
    const who = local(),
      list = customers(f, ['虚构快照甲', '虚构快照乙']);
    const plan = f.manager.tools.prepare('records.delete', { module: 'customers', ids: list.map((c) => c.id) }, who, 's');
    const first: unknown = JSON.parse(JSON.stringify(f.manager.tools.commit(plan, who, 's')));
    const snapshots = join(dir, 'snapshots');
    assert.ok(existsSync(snapshots) && readdirSync(snapshots).some((n) => n.endsWith('.sqlite')), '删之前留了快照');
    assert.deepEqual(f.manager.tools.commit(plan, who, 's'), first);
    assert.deepEqual(deletedCustomerAudits(f.store), list.map((c) => c.id));
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
