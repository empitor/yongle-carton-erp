import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { AuthManager } from '../server/auth.js';
import { ImportManager } from '../server/import/manager.js';
import { MarkAi } from '../server/marks/mark-ai.js';
import { assistantFixture } from './assistant-fixture.js';
import { imageFixture } from './import-fixtures.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function setup() {
  const f = assistantFixture([{ warnings: [], marks: [{ page: 0, title: '虚构唛头' }] }]);
  const dir = mkdtempSync(join(tmpdir(), 'carton-coverage-marks-'));
  const imports = new ImportManager({ directory: dir, settings: f.settings, promptPresets: f.prompts });
  const auth = new AuthManager(':memory:');
  const server = createApp(f.store, {
    auth, imports, aiSettings: f.settings, markAi: new MarkAi(f.store, f.settings, f.prompts),
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}/api`;
  const login = await fetch(base + '/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
    body: JSON.stringify({ name: '虚构测试管理员', password: 'fictional-marks-coverage-only' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  await login.text();
  const post = (id: string, action: string, body: unknown, authorized = true) =>
    fetch(`${base}/ai/imports/${id}/marks/${action}`, {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: {
        'Content-Type': 'application/json', 'X-ERP-AI-Token': imports.csrfToken,
        ...(authorized ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const upload = async (jpeg = false) => {
    const w = (await imports.upload(imageFixture(jpeg), jpeg ? '虚构.jpg' : '虚构.png', true)).workspace;
    return imports.setMode(w.id, { expectedRevision: w.revision, mode: 'mark' });
  };
  const seedReview = (w: Awaited<ReturnType<typeof upload>>, choices: unknown[]) =>
    imports.saveMarkReview(w.id, w.revision, {
      fileHash: w.fileHash, recognizedAt: '2026-11-05T10:00:00Z', warnings: [], committed: null,
      items: choices.map((choice, page) => ({ key: `mark-${page}`, page, title: '虚构', fields: {}, choice, skip: false })),
    });
  const count = (table: 'products' | 'product_marks' | 'mark_files' | 'operation_requests' | 'business_audit') =>
    Number(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  return {
    ...f, imports, post, upload, seedReview, count,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
      auth.close();
      imports.close();
      f.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('唛头流式识别先检查登录和模型版本，再用替身生成可核对草稿', async () => {
  const f = await setup();
  try {
    const w = await f.upload();
    assert.equal((await f.post(w.id, 'recognize', { consent: true }, false)).status, 401);
    assert.equal((await f.post(w.id, 'recognize', {
      consent: true, profile: { id: 'old', endpoint: 'https://example.invalid/v1', model: 'old', apiStyle: 'responses' },
    })).status, 409);
    assert.equal(f.calls(), 0);
    assert.equal(f.imports.markReview(w.id), null);
    const response = await f.post(w.id, 'recognize', { consent: true, stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /^text\/event-stream/);
    const events = await response.text();
    assert.match(events, /event: result/);
    assert.doesNotMatch(events, /event: error/);
    assert.equal(f.calls(), 1);
    assert.equal(f.imports.markReview(w.id)?.items[0].title, '虚构唛头');
    assert.equal(f.count('product_marks'), 0);
  } finally {
    await f.close();
  }
});

test('唛头归档拒绝旧版本和跨工作区复用凭据，第二款失败时整份回滚', async () => {
  const f = await setup();
  try {
    const newChoice = { mode: 'new', name: '虚构新箱型' };
    const w = f.seedReview(await f.upload(), [newChoice, { mode: 'existing', id: 99 }]);
    const requestId = randomUUID();
    const before = f.count('business_audit');
    assert.equal((await f.post(w.id, 'commit', { requestId, expectedRevision: w.revision - 1 })).status, 409);
    assert.equal((await f.post(w.id, 'commit', { requestId, expectedRevision: w.revision })).status, 404);
    for (const table of ['products', 'product_marks', 'mark_files', 'operation_requests'] as const)
      assert.equal(f.count(table), 0, table);
    assert.equal(f.count('business_audit'), before);
    assert.equal(f.imports.markReview(w.id)?.committed, null);

    const review = f.imports.markReview(w.id)!;
    const repaired = f.imports.saveMarkReview(w.id, w.revision, { ...review, items: [review.items[0]] });
    const retry = { requestId, expectedRevision: repaired.revision };
    const result = await f.post(w.id, 'commit', retry);
    assert.equal(result.status, 200);
    const receipt = await result.json();
    assert.deepEqual(await (await f.post(w.id, 'commit', retry)).json(), receipt);

    const other = f.seedReview(await f.upload(true), [newChoice]);
    assert.equal((await f.post(other.id, 'commit', { requestId, expectedRevision: other.revision })).status, 409);
    assert.equal(f.imports.markReview(other.id)?.committed, null);
    assert.equal(f.count('product_marks'), 1);
    assert.equal(f.count('mark_files'), 1);
  } finally {
    await f.close();
  }
});

test('同一唛头工作区并发重试相同请求时，两次响应都应返回同一份已提交回执', async (t) => {
  const f = await setup();
  const firstReady = gate(), secondReady = gate();
  const releaseFirst = gate(), releaseSecond = gate();
  const original = f.imports.original.bind(f.imports);
  let calls = 0;
  t.mock.method(f.imports, 'original', async (id: string) => {
    if (++calls === 1) {
      firstReady.release();
      await releaseFirst.promise;
    } else {
      secondReady.release();
      await releaseSecond.promise;
    }
    return original(id);
  });
  try {
    const w = f.seedReview(await f.upload(), [{ mode: 'new', name: '虚构并发箱型' }]);
    const input = { requestId: randomUUID(), expectedRevision: w.revision };
    const first = f.post(w.id, 'commit', input);
    await Promise.race([firstReady.promise, first.then((r) => assert.fail(`第一个请求提前返回 ${r.status}`))]);
    const second = f.post(w.id, 'commit', input);
    await Promise.race([secondReady.promise, second.then((r) => assert.fail(`第二个请求提前返回 ${r.status}`))]);
    releaseFirst.release();
    const initial = await first;
    assert.equal(initial.status, 200);
    const receipt = await initial.json();
    releaseSecond.release();
    const replay = await second;
    assert.equal(f.count('product_marks'), 1);
    const body = await replay.json();
    assert.equal(replay.status, 200, JSON.stringify(body));
    assert.deepEqual(body, receipt);
  } finally {
    releaseFirst.release();
    releaseSecond.release();
    await f.close();
  }
});
