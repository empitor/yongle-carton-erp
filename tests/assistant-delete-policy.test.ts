// 助手删除卡片上改“库存怎么处理”：服务器按新选项重新生成同一份方案（新摘要），执行按人看过的那一版来；
// 两个标签页、改选的响应丢了、改选中途出错回滚。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AppError } from '../server/core/index.js';
import { businessBase } from './business-base-fixture.js';
import { autoConfirmAssistant, lastCard } from './assistant-fixture.js';
import { asList, field } from '../server/assistant/chat/result-fields.js';
import { superActor } from './actor-fixture.js';
import { readAs } from './read-result.js';

/** 一个虚构供应商、一张已入库 1000 张的到货单，助手提出删除这个供应商 */
async function policyCard(f: ReturnType<typeof autoConfirmAssistant>) {
  const who = superActor();
  const base = businessBase(who, f.store),
    { ops, flow } = base;
  const supplier = base.supplier({ name: '虚构选库存供应商' });
  const raw = base.raw({ name: '虚构选库存纸板' });
  const arrival = flow.save(
    'arrival',
    { date: '2026-11-07', supplierId: supplier.id, reference: 'FICT-POLICY-1', lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity: '1000', unitPrice: '1', priceBasis: 'quantity' }] },
    who,
  );
  base.check(arrival);
  const thread = f.manager.create(who);
  f.replies.push({ message: '', toolCalls: [{ name: 'records.delete', args: { module: 'suppliers', id: supplier.id } }] });
  const plan = lastCard(await f.say(thread.id, '把供应商 虚构选库存供应商 删掉', {}, who));
  return { who, ops, supplier, raw, thread, plan };
}
/** 存着的待确认方案（摘要和内容）；没有就让测试失败 */
function storedPreview(f: ReturnType<typeof autoConfirmAssistant>, id: string) {
  const row = f.store.db.prepare('SELECT digest,document FROM assistant_previews WHERE id=?').get(id);
  assert.ok(row, '待确认方案不在库里');
  return row;
}
const digestOf = (f: ReturnType<typeof autoConfirmAssistant>, id: string) => storedPreview(f, id).digest;

test('助手删除卡片上改“库存怎么处理”：服务器按新选项重新生成同一份方案（新摘要），执行按人选的来；校验一样都不放松', async () => {
  const f = autoConfirmAssistant();
  try {
    const { who, ops, supplier, raw, thread, plan } = await policyCard(f);
    assert.equal(plan.tool, 'records.delete');
    assert.equal(field(plan.after, 'inventoryChoice'), 1, '涉及出入库流水，卡片上才出现选项');
    assert.equal(field(field(plan.after, 'selection'), 'inventoryPolicy'), 'recalculate');
    const oldDigest = digestOf(f, plan.id);

    // 别的会话、乱传的选项：拒绝
    assert.throws(() => f.manager.changeDeletionPolicy(plan.id, { inventoryPolicy: 'preserve' }, who, 'other-session'), /不属于当前登录会话/);
    assert.throws(() => f.manager.changeDeletionPolicy(plan.id, { inventoryPolicy: 'keep' }, who, 's'));
    assert.throws(() => f.manager.changeDeletionPolicy(plan.id, { inventoryPolicy: 'preserve', deletionDigest: 'x' }, who, 's'));
    // 没进超级管理员模式：删除引擎照样拒绝，方案不变
    const plain = { ...who, superAdminMode: false };
    assert.throws(() => f.manager.changeDeletionPolicy(plan.id, { inventoryPolicy: 'preserve' }, plain, 's'), (e: unknown) => e instanceof AppError && e.status === 403);
    assert.equal(digestOf(f, plan.id), oldDigest);

    const next = f.manager.changeDeletionPolicy(plan.id, { inventoryPolicy: 'preserve' }, who, 's');
    assert.equal(next.id, plan.id, '同一份待确认方案');
    assert.equal(field(field(next.after, 'selection'), 'inventoryPolicy'), 'preserve');
    assert.equal(field(next.args, 'inventoryPolicy'), 'preserve');
    assert.notEqual(field(next.args, 'deletionDigest'), field(plan.args, 'deletionDigest'));
    assert.match(String(asList(next.warnings)?.[0]), /^只删记录，库存数量不动/);
    assert.equal(next.requiresPassword, true, '密码要求不变');
    assert.notEqual(digestOf(f, plan.id), oldDigest, '旧摘要作废');
    // 聊天记录里那张卡片也换成新方案；存下来的 stamp 也是新方案的（和新摘要对得上）
    const card = f.manager.view(thread.id, who).messages.find((m) => m.plans?.some((p) => p.id === plan.id))?.plans?.[0];
    assert.ok(card);
    assert.equal(field(field(card.after, 'selection'), 'inventoryPolicy'), 'preserve');
    const stored = readAs(JSON.parse(String(storedPreview(f, plan.id).document)), { stamp: z.object({ digest: z.string() }).loose() });
    assert.equal(stored.stamp.digest, field(next.args, 'deletionDigest'));

    // 旧卡片（还停在“库存一起改回”的那一版）不能按新选项执行：摘要对不上，拒绝，什么都不删
    assert.throws(
      () => f.manager.execute(plan.id, { acknowledged: true, deletionDigest: field(plan.args, 'deletionDigest') }, who, 's', { passwordVerified: true }),
      (e: unknown) => e instanceof AppError && e.status === 409 && e.code === 'plan-changed' && /重新核算/.test(e.message),
    );
    // 没带摘要（旧页面）也一样
    assert.throws(() => f.manager.execute(plan.id, { acknowledged: true }, who, 's', { passwordVerified: true }), /重新核算/);
    assert.equal(ops.suppliers(true, supplier.id).length, 1);
    assert.equal(ops.balance(raw.id), 1000_000);

    // 执行仍要核验密码（聊天接口），并按人选的“库存数量不动”删
    const seen = { acknowledged: true, deletionDigest: field(next.args, 'deletionDigest') };
    assert.throws(() => f.manager.execute(plan.id, seen, who, 's'), /密码/);
    const result = f.manager.execute(plan.id, seen, who, 's', { passwordVerified: true });
    assert.equal(ops.suppliers(true, supplier.id).length, 0);
    assert.equal(ops.balance(raw.id), 1000_000, '库存数量不动');
    // 同一版卡片再点一次（网络重试）原样返回；旧卡片再点：已经执行过了，不把别的选项执行的结果当成它的
    assert.deepEqual(
      f.manager.execute(plan.id, seen, who, 's', { passwordVerified: true }),
      JSON.parse(JSON.stringify(result ?? null)),
    );
    assert.throws(
      () => f.manager.execute(plan.id, { acknowledged: true, deletionDigest: field(plan.args, 'deletionDigest') }, who, 's', { passwordVerified: true }),
      (e: unknown) => e instanceof AppError && e.status === 409 && /已经执行过了/.test(e.message),
    );
    // 执行过的方案不能再改
    assert.throws(() => f.manager.changeDeletionPolicy(plan.id, { inventoryPolicy: 'recalculate' }, who, 's'), /已经执行过/);
  } finally {
    f.close();
  }
});

test('两个标签页：B 页把库存处理改成“库存数量不动”，A 页还显示“库存一起改回”时点确认被拒，不按 B 页的选项删；看过最新卡片再确认才删', async () => {
  const f = autoConfirmAssistant();
  try {
    const { who, ops, supplier, raw, thread, plan: cardA } = await policyCard(f);
    assert.equal(field(field(cardA.after, 'selection'), 'inventoryPolicy'), 'recalculate');
    // B 页（同一登录会话）改选
    const cardB = f.manager.changeDeletionPolicy(cardA.id, { inventoryPolicy: 'preserve' }, who, 's');
    // A 页按自己看到的卡片确认：被拒，供应商和库存都没动
    assert.throws(
      () => f.manager.execute(cardA.id, { acknowledged: true, deletionDigest: field(cardA.args, 'deletionDigest') }, who, 's', { passwordVerified: true }),
      (e: unknown) => e instanceof AppError && e.status === 409 && e.message === '方案已按新的库存处理方式重新核算，请看过再确认。',
    );
    assert.equal(ops.suppliers(true, supplier.id).length, 1);
    assert.equal(ops.balance(raw.id), 1000_000);
    // A 页重新载入聊天，看到的就是 B 页改过的这一版；按它确认，库存数量不动
    const reloaded = f.manager
      .view(thread.id, who)
      .messages.flatMap((m) => m.plans || [])
      .find((p) => p.id === cardA.id);
    assert.ok(reloaded, '重新载入的聊天里还有这张卡片');
    assert.equal(field(field(reloaded.after, 'selection'), 'inventoryPolicy'), 'preserve');
    assert.equal(field(reloaded.args, 'deletionDigest'), field(cardB.args, 'deletionDigest'));
    f.manager.execute(cardA.id, { acknowledged: true, deletionDigest: field(reloaded.args, 'deletionDigest') }, who, 's', { passwordVerified: true });
    assert.equal(ops.suppliers(true, supplier.id).length, 0);
    assert.equal(ops.balance(raw.id), 1000_000, '按看过的“库存数量不动”删');
  } finally {
    f.close();
  }
});

test('改选的响应丢了：服务器已经换成“库存数量不动”，页面还停在“库存一起改回”，点确认被拒；改回原来的选项后旧卡片又对得上', async () => {
  const f = autoConfirmAssistant();
  try {
    const { who, ops, supplier, raw, plan: shown } = await policyCard(f);
    f.manager.changeDeletionPolicy(shown.id, { inventoryPolicy: 'preserve' }, who, 's'); // 响应没回到页面
    assert.throws(
      () => f.manager.execute(shown.id, { acknowledged: true, deletionDigest: field(shown.args, 'deletionDigest') }, who, 's', { passwordVerified: true }),
      (e: unknown) => e instanceof AppError && e.status === 409 && /重新核算/.test(e.message),
    );
    assert.equal(ops.balance(raw.id), 1000_000);
    // 再改回“库存一起改回”：内容和页面上那张一样，摘要也一样，按它确认就是按看到的删
    const back = f.manager.changeDeletionPolicy(shown.id, { inventoryPolicy: 'recalculate' }, who, 's');
    assert.equal(field(back.args, 'deletionDigest'), field(shown.args, 'deletionDigest'));
    f.manager.execute(shown.id, { acknowledged: true, deletionDigest: field(shown.args, 'deletionDigest') }, who, 's', { passwordVerified: true });
    assert.equal(ops.suppliers(true, supplier.id).length, 0);
    assert.equal(ops.balance(raw.id), 0, '库存一起改回');
  } finally {
    f.close();
  }
});

test('改选时方案、聊天里的卡片、审计在同一个事务里：中途出错一起回滚，方案和卡片都还是原来那一版', async () => {
  const f = autoConfirmAssistant();
  try {
    const { who, thread, plan } = await policyCard(f);
    const previewRow = () => storedPreview(f, plan.id);
    const cards = () =>
      f.store.db
        .prepare('SELECT seq,document FROM assistant_messages WHERE thread_id=? AND instr(document,?)>0 ORDER BY seq')
        .all(thread.id, plan.id);
    const before = previewRow(),
      cardsBefore = cards();
    // 最后一步（记审计）出错：方案、聊天里的卡片已经写了，要一起回滚
    f.store.db.exec(
      "CREATE TEMP TRIGGER fictional_policy_audit_fails BEFORE INSERT ON assistant_audit WHEN NEW.state='inventory-policy' BEGIN SELECT RAISE(ABORT, '虚构的写入失败'); END",
    );
    assert.throws(() => f.manager.changeDeletionPolicy(plan.id, { inventoryPolicy: 'preserve' }, who, 's'), /虚构的写入失败/);
    assert.deepEqual(previewRow(), before, '方案没换');
    assert.deepEqual(cards(), cardsBefore, '聊天里的卡片也没换');
    f.store.db.exec('DROP TRIGGER fictional_policy_audit_fails');
    // 恢复正常后照常能改
    assert.equal(field(field(f.manager.changeDeletionPolicy(plan.id, { inventoryPolicy: 'preserve' }, who, 's').after, 'selection'), 'inventoryPolicy'), 'preserve');
  } finally {
    f.close();
  }
});
