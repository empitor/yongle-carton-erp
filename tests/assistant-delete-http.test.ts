// 经接口点助手的删除卡片：从域名进来时服务器核对超级管理员模式和本人密码、卡片版本；一键清空只能在本机；
// 不是部署本机入口也要密码；已执行的卡片再点（网络重试）返回原结果。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { AppError } from '../server/core/errors.js';
import type { Actor } from '../server/core/index.js';
import { FlowService } from '../server/flow/index.js';
import { OperationsService } from '../server/operations/index.js';
import { customerSchema, today } from '../shared/core/domain.js';
import { autoConfirmAssistant } from './assistant-fixture.js';
import { cookieOf, startHttp, startProxied, stateActor } from './http-fixture.js';
import { readAs } from './read-result.js';

const sessionBinding = (cookie: string) => createHash('sha256').update(cookie.split('=')[1]).digest('hex');
/** 卡片存在哪：哪个会话、谁的、绑定哪次登录 */
type PreviewOwner = { thread: string; who: { id: string }; binding: string };
/** 把一张卡片直接存成这个会话里待确认的一张（不经模型），返回执行地址 */
function savePreview(store: Store, owner: PreviewOwner, plan: unknown, stamp: unknown = null) {
  const id = randomUUID(),
    document = JSON.stringify({ plan, stamp });
  store.db
    .prepare('INSERT INTO assistant_previews(id,thread_id,user_id,session_binding,expires_at,digest,document,result) VALUES(?,?,?,?,?,?,?,NULL)')
    .run(id, owner.thread, owner.who.id, owner.binding, Date.now() + 600000, createHash('sha256').update(document).digest('hex'), document);
  return '/assistant/previews/' + id + '/execute';
}
/** 部署模式：本机建好管理员，从域名登录、建一个会话 */
async function overDomain() {
  const f = autoConfirmAssistant(),
    p = await startProxied(f.store, { assistant: f.manager }),
    owner = { name: '虚构维护员', password: 'Fictional-owner-password' };
  assert.equal((await p.call(p.localPort, '/auth/setup', { body: owner })).code, 200);
  const login = await p.call(p.proxyPort, '/auth/login', { headers: p.remote, body: owner });
  assert.equal(login.code, 200);
  const cookie = cookieOf(login);
  const send = (path: string, body?: unknown) => p.call(p.proxyPort, path, { headers: p.remote, cookie, body });
  const thread = readAs((await send('/assistant/threads', {})).value, { id: z.string() }).id;
  return {
    f,
    owner,
    send,
    thread,
    binding: sessionBinding(cookie),
    actorNow: async () => {
      const actor = stateActor((await send('/auth/state')).value);
      assert.ok(actor, '还在登录');
      return actor;
    },
    close: async () => (await p.close(), f.close()),
  };
}
function looseArrival(store: Store, who: Actor, reference: string) {
  const supplier = new OperationsService(store).saveSupplier({ name: '虚构供应商-' + reference }, who);
  return new FlowService(store).save('arrival', { date: today(), supplierId: supplier.id, reference, lines: [{ item: { name: '虚构纸板', unit: '张' }, quantity: '10' }] }, who);
}

test('从域名删档案：没进模式不出卡片；执行时卡片版本不对 409、没密码或密码错不删、中途退出模式不删，模式加本人密码才删；一键清空出不了也执行不了', async () => {
  const d = await overDomain();
  const { f, send, owner } = d;
  try {
    const victim = f.store.saveCustomer(customerSchema.parse({ name: '虚构代理入口客户' }));
    const args = { module: 'customers', id: victim.id };
    const plain = await d.actorNow();
    assert.equal(plain.superAdminMode, false);
    // 还没进超级管理员模式：和页面一样提示先进入，不出一张必然失败的卡片
    assert.throws(
      () => f.manager.tools.prepare('records.delete', args, plain, d.binding, { proxy: true }),
      (e: unknown) => e instanceof AppError && e.status === 403 && /进入超级管理员模式/.test(e.message),
    );
    assert.equal(stateActor((await send('/auth/super-admin/enter', { password: owner.password })).value)?.superAdminMode, true);
    const who = await d.actorNow();
    const plan = f.manager.tools.prepare('records.delete', args, who, d.binding, { proxy: true });
    const path = savePreview(f.store, { thread: d.thread, who, binding: d.binding }, plan, f.manager.tools.stamp(plan, who));
    const execute = (body: Record<string, unknown>) => send(path, { acknowledged: true, deletionDigest: plan.args.deletionDigest, ...body });
    // 卡片停在旧版（别的标签页改了库存处理方式）：先拒绝，不去核验密码
    const stale = await execute({ deletionDigest: 'fictional-old-digest', password: 'Fictional-wrong-1' });
    assert.equal(stale.code, 409);
    assert.match(String(stale.value.message), /重新核算/);
    const missing = await execute({});
    assert.notEqual(missing.code, 200);
    assert.match(String(missing.value.message), /密码/);
    const wrong = await execute({ password: 'Fictional-wrong-1' });
    assert.equal(wrong.code, 401);
    assert.match(String(wrong.value.message), /密码不正确/);
    await send('/auth/super-admin/exit', {});
    const expired = await execute({ password: owner.password });
    assert.equal(expired.code, 403);
    assert.match(String(expired.value.message), /进入超级管理员模式/);
    assert.ok(f.store.customer(victim.id, true));
    await send('/auth/super-admin/enter', { password: owner.password });
    const done = await execute({ password: owner.password });
    assert.equal(done.code, 200, JSON.stringify(done.value));
    assert.equal(f.store.customer(victim.id, true), undefined);
    const kept = f.store.saveCustomer(customerSchema.parse({ name: '虚构清空不掉的客户' }));
    assert.throws(
      () => f.manager.tools.prepare('management.reset', { scope: 'business' }, who, d.binding, { proxy: true }),
      (e: unknown) => e instanceof AppError && e.status === 403 && /一键清空只能在服务器本机做/.test(e.message),
    );
    const resetPlan = { tool: 'management.reset', args: { scope: 'business' }, label: '一键清空业务数据', highRisk: true, before: {}, after: {}, warnings: [] };
    const reset = await send(savePreview(f.store, { thread: d.thread, who, binding: d.binding }, resetPlan), { acknowledged: true, password: owner.password });
    assert.equal(reset.code, 403);
    assert.match(String(reset.value.message), /一键清空只能在服务器本机做/);
    assert.ok(f.store.customer(kept.id, true));
  } finally {
    await d.close();
  }
});

test('从域名删还没核对的单据：点确认就删、不用密码；已执行的卡片再点（网络重试）直接返回原结果', async () => {
  const d = await overDomain();
  const { f, send } = d;
  try {
    const who = await d.actorNow();
    const draft = looseArrival(f.store, who, '虚构待删到货-域名');
    const plan = f.manager.tools.prepare('records.delete', { module: 'arrivals', id: draft.id }, who, d.binding, { proxy: true });
    const path = savePreview(f.store, { thread: d.thread, who, binding: d.binding }, plan, f.manager.tools.stamp(plan, who));
    const seen = { acknowledged: true, deletionDigest: plan.args.deletionDigest };
    const first = await send(path, seen);
    assert.equal(first.code, 200, JSON.stringify(first.value));
    assert.throws(() => new FlowService(f.store).get(draft.id), /不存在/);
    const second = await send(path, seen);
    assert.equal(second.code, 200, JSON.stringify(second.value));
    assert.deepEqual(second.value, first.value);
  } finally {
    await d.close();
  }
});

test('不是部署的本机入口：不是本机最高管理员的执行删除卡片要带本人密码，错了不删', async () => {
  const f = autoConfirmAssistant(),
    password = 'Fictional-owner-456',
    h = await startHttp(f.store, { assistant: f.manager, admin: { name: '虚构老板', password } });
  try {
    const send = (path: string, body?: unknown) => h.send(path, body, h.cookie);
    assert.equal((await send('/auth/super-admin/enter', { password })).status, 200);
    const who = stateActor(readAs(await (await send('/auth/state')).json(), {}));
    assert.ok(who, '还在登录');
    assert.notEqual(who.localAdministrator, true);
    const thread = readAs(await (await send('/assistant/threads', {})).json(), { id: z.string() });
    const victim = f.store.saveCustomer(customerSchema.parse({ name: '虚构要密码客户' }));
    const binding = sessionBinding(h.cookie);
    const plan = f.manager.tools.prepare('records.delete', { module: 'customers', id: victim.id }, who, binding);
    const path = savePreview(f.store, { thread: thread.id, who, binding }, plan, f.manager.tools.stamp(plan, who));
    const seen = { acknowledged: true, deletionDigest: plan.args.deletionDigest };
    for (const body of [seen, { ...seen, password: 'Fictional-wrong-1' }]) {
      const r = await send(path, body);
      assert.notEqual(r.status, 200);
      assert.match(readAs(await r.json(), { message: z.string() }).message, /密码/);
    }
    assert.ok(f.store.customer(victim.id, true));
    const done = await send(path, { ...seen, password });
    assert.equal(done.status, 200, await done.clone().text());
    assert.equal(f.store.customer(victim.id, true), undefined);
  } finally {
    await h.close();
    f.close();
  }
});
