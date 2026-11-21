// 单据的保存、取消、归档和恢复（server/flow/）：已核对的不能普通保存，重复提交原样返回，写接口要登录和页面凭证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { count as countRows } from '../server/core/index.js';
import { flowViewSchema } from '../shared/business/index.js';
import { flowFixture, clerk } from './flow-fixture.js';
import { archiveDoc } from './receive-fixture.js';
import { startHttp } from './http-fixture.js';
import { readAs } from './read-result.js';

const looseLine = (f: ReturnType<typeof flowFixture>, quantity: string) => [{ stockId: f.raw.id, item: { name: f.raw.name, unit: '张' }, quantity }];
/** 归档、恢复（POST /flow/batch）逐条的结果 */
const batchResults = z.array(z.looseObject({ success: z.boolean(), message: z.string() }));

test('已核对的单据不能再按普通保存改；没有业务权限不能存单据；已入库的到货归档、恢复不动库存；取消的待送货单归档后不在列表里，恢复后回来', () => {
  const f = flowFixture();
  try {
    const a = f.arrive('虚构归档', '100');
    assert.throws(() => f.flow.save('arrival', { ...a, version: a.version }, clerk, a.id), /只能修改还没核对的单据/);
    assert.throws(() => f.flow.save('task', { date: '2026-10-20', productId: f.product.id, quantity: '10', unit: '只' }, { ...clerk, permissions: [] }), /没有.*权限/);
    assert.equal(archiveDoc(f.flow, a.id, false, clerk, f.flow.get(a.id).version).archived, true);
    assert.equal(f.ops.repo.balance(f.raw.id), 100000);
    archiveDoc(f.flow, a.id, true, clerk, f.flow.get(a.id).version);
    assert.equal(f.flow.get(a.id).archived, false);
    const order = f.order(10);
    const draft = f.draft('delivery', { customerId: f.customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity: '10' }] });
    f.flow.cancel(draft.id, { version: draft.version, reason: '暂缓', acknowledged: true }, clerk);
    archiveDoc(f.flow, draft.id, false, clerk, f.flow.get(draft.id).version);
    assert.equal(f.flow.list('delivery').some((x) => x.id === draft.id), false);
    archiveDoc(f.flow, draft.id, true, clerk, f.flow.get(draft.id).version);
    assert.equal(f.flow.get(draft.id).archived, false);
  } finally {
    f.store.close();
  }
});

test('取消、归档同样的请求重复提交原样返回', () => {
  const f = flowFixture();
  try {
    const d = f.draft('arrival', { supplierId: f.supplier.id, reference: 'X1', lines: looseLine(f, '10') });
    const body = { version: d.version, reason: '不要了', acknowledged: true };
    assert.equal(f.flow.cancel(d.id, body, clerk).status, 'cancelled');
    assert.equal(f.flow.cancel(d.id, body, clerk).status, 'cancelled');
    const a = f.arrive('X2', '5');
    const version = f.flow.get(a.id).version;
    assert.equal(archiveDoc(f.flow, a.id, false, clerk, version).archived, true);
    assert.equal(archiveDoc(f.flow, a.id, false, clerk, version).archived, true);
  } finally {
    f.store.close();
  }
});

test('单据保存的对外地址（新建、修改）请求号必填：不带就拒，不会多出单据、内容也不变；带了的重发只建一张', async () => {
  const f = flowFixture(),
    h = await startHttp(f.store);
  try {
    const count = () => countRows(f.store.db, 'SELECT count(*) n FROM flow_documents');
    const task = { date: '2026-10-20', productId: f.product.id, quantity: '100', unit: '只' };
    for (let i = 0; i < 2; i++) {
      const r = await h.send('/flow/task', task, h.cookie);
      assert.equal(r.status, 400);
      assert.match(readAs(await r.json(), { message: z.string() }).message, /提交编号/);
    }
    assert.equal(count(), 0, '没带请求号的一张都没建');
    const requestId = randomUUID();
    const created = flowViewSchema('task').parse(await (await h.send('/flow/task', { ...task, requestId }, h.cookie)).json());
    assert.equal((await h.send('/flow/task', { ...task, requestId }, h.cookie)).status, 201);
    assert.equal(count(), 1, '同一请求号重发只建一张');
    const draft = f.draft('arrival', { supplierId: f.supplier.id, reference: 'PUT-NO-REQUEST', lines: looseLine(f, '10') });
    const put = await h.send('/flow/' + draft.id, { ...draft, notes: '虚构改备注', version: draft.version }, h.cookie, { method: 'PUT' });
    assert.equal(put.status, 400);
    assert.equal(f.flow.get(draft.id).notes, '', '没带请求号的修改没生效');
    assert.equal(created.status, 'confirmed');
  } finally {
    await h.close();
    f.store.close();
  }
});

test('单据写接口要登录和页面凭证；同一核对请求并发只入库一次，两张单据抢着核对时后到的预览失效；归档、恢复逐条返回结果', async () => {
  const f = flowFixture(),
    h = await startHttp(f.store);
  try {
    const req = (path: string, body: unknown, authenticated = true, csrf = true) =>
      h.send(path, body, authenticated ? h.cookie : '', csrf ? {} : { csrf: null });
    const task = { date: '2026-10-20', productId: f.product.id, quantity: '100', unit: '只', requestId: randomUUID() };
    assert.equal((await req('/flow/task', task, false)).status, 401);
    assert.equal((await req('/flow/task', task, true, false)).status, 403);
    assert.equal((await req('/flow/task', task)).status, 201);
    const preview = async (id: number) => readAs(await (await req('/flow/' + id + '/preview', {})).json(), { previewDigest: z.string() }).previewDigest;
    const confirm = (id: number, previewDigest: string, requestId = randomUUID()) =>
      req('/flow/' + id + '/confirm', { previewDigest, requestId, acknowledged: true });
    const draft = (reference: string, quantity: string) => f.draft('arrival', { supplierId: f.supplier.id, reference, lines: looseLine(f, quantity) });
    const a = draft('HTTP-CONCURRENT-1', '100'),
      pa = await preview(a.id),
      requestId = randomUUID();
    assert.deepEqual((await Promise.all([confirm(a.id, pa, requestId), confirm(a.id, pa, requestId)])).map((r) => r.status), [200, 200]);
    assert.equal(f.ops.repo.balance(f.raw.id), 100000);
    const b = draft('HTTP-CONCURRENT-2', '50'),
      c = draft('HTTP-CONCURRENT-3', '50');
    const [pb, pc] = [await preview(b.id), await preview(c.id)];
    assert.deepEqual((await Promise.all([confirm(b.id, pb), confirm(c.id, pc)])).map((r) => r.status).sort(), [200, 409]);
    assert.equal(f.ops.repo.balance(f.raw.id), 150000);
    const waiting = draft('VERSION-LIFECYCLE', '10'),
      edited = f.flow.save('arrival', { ...waiting, notes: '另一用户已改内容' }, clerk, waiting.id);
    const batch = async (action: string, version?: number) => {
      const r = await req('/flow/batch', { action, acknowledged: true, items: [{ id: waiting.id, ...(version ? { version } : {}) }] });
      return { status: r.status, result: r.status === 200 ? readAs(await r.json(), { results: batchResults }).results.at(0) : null };
    };
    let outcome = await batch('archive', waiting.version);
    assert.deepEqual([outcome.status, outcome.result?.success, outcome.result?.message], [200, false, '记录已修改，请刷新。']);
    assert.equal((await batch('archive')).status, 400, '不带版本');
    outcome = await batch('archive', edited.version);
    assert.ok(outcome.result);
    assert.equal(outcome.result.success, false);
    assert.match(outcome.result.message, /还没核对的单据不能归档/);
    assert.equal((await batch('restore', edited.version)).result?.message, '已经恢复');
  } finally {
    await h.close();
    f.store.close();
  }
});
