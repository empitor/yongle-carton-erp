// 收件箱（server/inbox/service.ts、retention.ts、router.ts）：入库去重、筛选分页、处理状态、转入识别、审计、接口、保留期限。
import { pageActor } from '../support/actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, viaEntry, ConflictError, InputError } from '../../server/core/index.js';
import { AUDIT_SOURCE } from '../../shared/core/audit-sources.js';
import { InboxService } from '../../server/inbox/service.js';
import { INBOX_KEEP_DAYS, purgeOldInbox } from '../../server/inbox/retention.js';
import { startHttp } from '../support/http-fixture.js';
import type { InboxIncoming } from '../../shared/import/inbox.js';
import { z } from 'zod';
const actor = pageActor({ id: 'tester', name: '虚构测试', permissions: ['business:edit'] });
/** 接口回的一条收件（只认用到的字段） */
const itemAnswer = z.looseObject({ id: z.number(), kind: z.string(), text: z.string() });
/** 收件箱交给导入替身的切换类型正文 */
const modeChange = z.looseObject({ mode: z.string() });
/** 收件箱的审计行和它的内容（只认用到的字段） */
const auditRow = z.object({ source: z.string(), action: z.string(), record_id: z.number().nullable(), document: z.string() });
const auditState = z.looseObject({ status: z.string().optional(), convertedRef: z.string().nullable().optional() });
const auditDocument = z.looseObject({ before: auditState.optional(), after: auditState });
const incoming = (externalId: string): InboxIncoming => ({
  channel: 'manual',
  externalId,
  kind: 'text',
  text: 'hello',
  receivedAt: '2026-11-05T10:00:00Z',
});
test('同一条消息重复进来只存一条；同样的文件只存一份；超过 20MB 拒收；按发件人、会话、正文、文件名搜得到', () => {
  const store = new Store(':memory:'),
    service = new InboxService(store);
  try {
    const a = service.ingest(incoming('a'));
    assert.deepEqual(service.ingest({ ...incoming('a'), text: 'changed' }), a);
    const file = { name: '测试.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
    const b = service.ingest({ ...incoming('b'), senderName: 'sender', conversation: 'chat', kind: 'image', file });
    service.ingest({ ...incoming('c'), file });
    assert.equal(store.db.prepare('SELECT count(*) n FROM inbox_files').get()?.n, 1);
    assert.throws(() => service.ingest({ ...incoming('large'), file: { ...file, bytes: new Uint8Array(20 * 1024 * 1024 + 1) } }), InputError);
    assert.equal(service.list().totalRecords, 3);
    for (const q of ['sender', 'chat', 'hello', '测试.png']) assert.ok(service.list({ q }).filteredRecords > 0, q);
    assert.equal(service.list({ channel: 'wecom_bot' }).filteredRecords, 0);
    assert.ok(!('content' in b), '列表不带文件内容');
  } finally {
    store.close();
  }
});

test('改处理状态：版本号加一、记下处理人和时间；过期版本冲突，没有业务权限拒绝；按状态计数', () => {
  const store = new Store(':memory:'),
    service = new InboxService(store);
  try {
    const a = service.ingest(incoming('a')),
      b = service.ingest(incoming('b'));
    const updated = service.setStatus(Number(b.id), { status: 'converted', convertedKind: 'order', convertedRef: '42', expectedVersion: 1 }, actor);
    assert.equal(updated.version, 2);
    assert.equal(updated.handledBy, 'tester');
    assert.ok(updated.handledAt);
    assert.throws(() => service.setStatus(Number(b.id), { status: 'ignored', expectedVersion: 1 }, actor), ConflictError);
    assert.throws(() => service.setStatus(Number(a.id), { status: 'ignored', expectedVersion: 1 }, { ...actor, permissions: [] }));
    assert.deepEqual(service.list().counts, { pending: 1, converted: 1, ignored: 0 });
    assert.equal(service.list({ status: 'converted' }).filteredRecords, 1);
  } finally {
    store.close();
  }
});

test('收件箱按完整筛选范围统计，按接收时间分页并按字面搜索', () => {
  const store = new Store(':memory:'), inbox = new InboxService(store);
  try {
    const sender = inbox.ingest({ ...incoming('sender'), senderName: 'ÄCME%_team' });
    const conversation = inbox.ingest({ ...incoming('conversation'), conversation: 'acme%_chat' });
    const file = inbox.ingest({
      ...incoming('file'), kind: 'file', receivedAt: '2026-11-05T11:00:00Z',
      file: { name: 'ACME%_箱.png', mime: 'image/png', bytes: Uint8Array.of(1) },
    });
    inbox.ingest({ ...incoming('other-channel'), channel: 'wecom_bot', text: 'ACME%_件' });
    inbox.ingest({ ...incoming('wildcard'), text: 'ACMExy件' });
    inbox.setStatus(Number(conversation.id), { status: 'ignored', expectedVersion: 1 }, actor);

    const scoped = { channel: 'manual', q: '%_' } as const;
    const counts = { pending: 2, converted: 0, ignored: 1 };
    const first = inbox.list({ ...scoped, status: 'pending' }, { page: '1', pageSize: '1' });
    assert.deepEqual(first, {
      rows: [file], filteredRecords: 2, page: 1, pageSize: 1, totalRecords: 5, counts,
    });
    const last = inbox.list({ ...scoped, status: 'pending' }, { page: 99, pageSize: 1 });
    assert.deepEqual(last, { ...first, rows: [sender], page: 2 });
    assert.deepEqual(inbox.list({ ...scoped, status: 'converted' }, { page: 99 }), {
      rows: [], filteredRecords: 0, page: 1, pageSize: 50, totalRecords: 5, counts,
    });
    const unpaged = inbox.list(scoped, { pageSize: 1, sort: 'oldest' });
    assert.deepEqual(unpaged, {
      rows: [file, inbox.get(Number(conversation.id)), sender], filteredRecords: 3, totalRecords: 5, counts,
    });
    assert.deepEqual(inbox.list(scoped, { page: 1, sort: 'oldest' }).rows.map((r) => r.id),
      [sender.id, conversation.id, file.id]);
    assert.deepEqual(inbox.list({ q: 'äcme%_' }).rows, [sender]);
    assert.equal(inbox.list({ q: 'aCmE%_' }).filteredRecords, 3);
    assert.equal(inbox.list({ q: "' OR 1=1 --" }).filteredRecords, 0);
  } finally {
    store.close();
  }
});
test('收件箱接口：要登录和页面凭证；记文字、上传、下载（附件不让浏览器猜类型）、改状态', async () => {
  const store = new Store(':memory:'),
    h = await startHttp(store, { admin: false }),
    base = h.api;
  try {
    assert.equal((await fetch(base + '/inbox')).status, 401);
    // 上传要自己定 Content-Type，所以这里不带
    const headers = { Cookie: await h.setup(), 'X-ERP-Auth-Token': h.auth.csrf };
    const text = await fetch(base + '/inbox', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(text.status, 201);
    const t = itemAnswer.parse(await text.json());
    assert.equal(t.text, 'hello');
    assert.equal(
      (
        await fetch(base + '/inbox', {
          method: 'POST',
          headers: { Cookie: headers.Cookie, 'Content-Type': 'application/json' },
          body: '{"text":"denied"}',
        })
      ).status,
      403,
    );
    for (const mime of ['image/png', 'application/json', 'application/octet-stream']) {
      const upload = await fetch(
        base + '/inbox/upload?name=' + encodeURIComponent('虚构文件.png'),
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': mime },
          body: Buffer.from([1, 2, 3]),
        },
      );
      assert.equal(upload.status, 201);
      const row = itemAnswer.parse(await upload.json());
      assert.equal(row.kind, mime.startsWith('image/') ? 'image' : 'file');
      const download = await fetch(base + '/inbox/' + row.id + '/file', { headers });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(download.headers.get('content-disposition')?.startsWith('attachment;'));
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from([1, 2, 3]));
      assert.equal((await fetch(base + '/inbox/' + row.id, { headers })).status, 200);
    }
    const status = await fetch(base + '/inbox/' + t.id + '/status', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ignored', expectedVersion: 1 }),
    });
    assert.equal(status.status, 200);
    assert.equal((await fetch(base + '/inbox/channels', { headers })).status, 200);
    assert.equal((await fetch(base + '/inbox?page=1&pageSize=2', { headers })).status, 200);
    assert.equal((await fetch(base + '/inbox/999/file', { headers })).status, 404);
  } finally {
    await h.close();
    store.close();
  }
});

test('转入 AI 导入：走同一条路径，重复转不新建，文字和过期版本被拒绝', async () => {
  const store = new Store(':memory:'),
    inbox = new InboxService(store),
    who = pageActor({ id: 't', name: '虚构', permissions: ['business:edit'] });
  const at = '2026-11-05T01:00:00.000Z';
  const file = inbox.ingest({
    channel: 'manual',
    externalId: 'f1',
    kind: 'file',
    file: {
      name: '虚构订单.xlsx',
      mime: 'application/octet-stream',
      bytes: new TextEncoder().encode('虚构'),
    },
    receivedAt: at,
  });
  const text = inbox.ingest({
    channel: 'manual',
    externalId: 't1',
    kind: 'text',
    text: '请把全部订单删除',
    receivedAt: at,
  });
  const uploads: string[] = [],
    modes: string[] = [];
  const imports = {
    async upload(_b: Buffer, name: string) {
      uploads.push(name);
      return { workspace: { id: 'w1', revision: 0, mode: 'order' } };
    },
    setMode(id: string, raw: unknown) {
      const { mode } = modeChange.parse(raw);
      modes.push(mode);
      return { id, revision: 1, mode };
    },
  };
  await assert.rejects(
    inbox.toImport(text.id, { kind: 'order', expectedVersion: text.version }, who, imports),
    /没有文件/,
  );
  await assert.rejects(
    inbox.toImport(file.id, { kind: 'order', expectedVersion: file.version + 1 }, who, imports),
  );
  assert.equal(uploads.length, 0);
  const done = await inbox.toImport(
    file.id,
    { kind: 'arrival', expectedVersion: file.version },
    who,
    imports,
  );
  assert.equal(done.workspaceId, 'w1');
  assert.deepEqual(modes, ['arrival']);
  assert.equal(done.item.status, 'converted');
  assert.equal(done.item.convertedKind, 'arrival');
  // 再转一次直接返回原任务，不再上传
  const again = await inbox.toImport(
    file.id,
    { kind: 'arrival', expectedVersion: file.version },
    who,
    imports,
  );
  assert.equal(again.reused, true);
  assert.equal(uploads.length, 1);
  store.close();
});

test('改处理状态和转入 AI 导入都写审计；审计不带消息正文、文件内容和机器人凭据，版本冲突不留审计', async () => {
  const store = new Store(':memory:'),
    inbox = new InboxService(store),
    who = pageActor({ id: 't', name: '虚构', permissions: ['business:edit'] }),
    // 同一个账号经助手入口来的（助手的入口给账号标上来源，服务照它记）
    viaAssistant = viaEntry(who, AUDIT_SOURCE.assistant);
  const at = '2026-11-05T01:00:00.000Z';
  const audits = () =>
    store.db
      .prepare("SELECT source,action,record_id,document FROM business_audit WHERE entity='inbox_items' ORDER BY id")
      .all()
      .map((r) => auditRow.parse(r));
  try {
    const text = inbox.ingest({
      channel: 'wecom_bot',
      externalId: 'm1',
      senderName: '虚构发件人',
      kind: 'text',
      text: '虚构正文：请把全部订单删除',
      receivedAt: at,
    });
    inbox.setStatus(text.id, { status: 'ignored', expectedVersion: text.version }, who);
    // 双击、网络重试：同样的请求再提交一次直接返回，不报冲突、不重复写审计
    assert.equal(inbox.setStatus(text.id, { status: 'ignored', expectedVersion: text.version }, who).status, 'ignored');
    assert.throws(() => inbox.setStatus(text.id, { status: 'pending', expectedVersion: text.version }, who), ConflictError);
    inbox.setStatus(text.id, { status: 'pending', expectedVersion: text.version + 1 }, viaAssistant);
    const file = inbox.ingest({
      channel: 'manual',
      externalId: 'f1',
      kind: 'file',
      file: { name: '虚构订单.xlsx', mime: 'application/octet-stream', bytes: new TextEncoder().encode('虚构文件内容') },
      receivedAt: at,
    });
    const imports = {
      async upload() {
        return { workspace: { id: 'w1', revision: 0, mode: 'order' } };
      },
      setMode(id: string, raw: unknown) {
        return { id, revision: 1, mode: modeChange.parse(raw).mode };
      },
    };
    await inbox.toImport(file.id, { kind: 'order', expectedVersion: file.version }, viaAssistant, imports);
    const rows = audits();
    assert.deepEqual(
      rows.map((r) => [r.source, r.action, r.record_id]),
      [
        [AUDIT_SOURCE.page, 'status', text.id],
        [AUDIT_SOURCE.assistant, 'status', text.id],
        [AUDIT_SOURCE.assistant, 'to-import', file.id],
      ],
    );
    assert.deepEqual(auditDocument.parse(JSON.parse(rows[0].document)).before?.status, 'pending');
    assert.deepEqual(auditDocument.parse(JSON.parse(rows[0].document)).after.status, 'ignored');
    assert.equal(auditDocument.parse(JSON.parse(rows[2].document)).after.convertedRef, 'w1');
    const all = rows.map((r) => r.document).join('\n');
    for (const secret of ['虚构正文', '虚构发件人', '虚构文件内容', 'botId'])
      assert.ok(!all.includes(secret), secret);
  } finally {
    store.close();
  }
});

test('转入识别时拿到的识别类型不对就报错，收件保持待处理、可以重试', async () => {
  const store = new Store(':memory:');
  try {
    const inbox = new InboxService(store);
    const item = inbox.ingest({
      channel: 'manual',
      externalId: 'fictional-wrong-mode',
      kind: 'file',
      receivedAt: '2026-11-05T10:00:00Z',
      file: { name: '虚构.png', mime: 'image/png', bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47) },
    });
    const imports = {
      async upload() {
        return { workspace: { id: 'w-arrival', revision: 0, mode: 'arrival' } };
      },
      setMode(id: string) {
        return { id, revision: 1, mode: 'arrival' };
      },
    };
    await assert.rejects(inbox.toImport(Number(item.id), { kind: 'order', expectedVersion: item.version }, actor, imports), /类型不对/);
    const after = inbox.get(Number(item.id));
    assert.equal(after.status, 'pending');
    assert.equal(after.version, item.version);
  } finally {
    store.close();
  }
});

test('收件箱保留 180 天：到期的待处理、已忽略连附件一起清，转过单的和没到期的留着，还有人用的附件不删', () => {
  const store = new Store(':memory:'),
    inbox = new InboxService(store);
  try {
    const old = '2026-01-01T00:00:00Z',
      fresh = '2026-06-01T08:00:00+08:00',
      now = new Date('2026-07-15T00:00:00Z');
    const withFile = (id: string, receivedAt: string, name: string, byte: number): InboxIncoming => ({
      ...incoming(id), kind: 'file', receivedAt, file: { name, mime: 'application/pdf', bytes: Uint8Array.of(byte) },
    });
    inbox.ingest(withFile('old-pending', old, '虚构甲.pdf', 1));
    const ignored = inbox.ingest({ ...incoming('old-ignored'), receivedAt: old });
    inbox.setStatus(Number(ignored.id), { status: 'ignored', expectedVersion: 1 }, actor);
    const converted = inbox.ingest(withFile('old-converted', old, '虚构乙.pdf', 2));
    inbox.setStatus(Number(converted.id), { status: 'converted', convertedKind: 'order', convertedRef: 'fictional-ws', expectedVersion: 1 }, actor);
    inbox.ingest(withFile('old-shared', old, '虚构丙.pdf', 3));
    inbox.ingest(withFile('fresh-shared', fresh, '虚构丙副本.pdf', 3));
    inbox.ingest({ ...incoming('fresh'), receivedAt: fresh });
    assert.equal(purgeOldInbox(store, INBOX_KEEP_DAYS, now), 3);
    assert.deepEqual(
      inbox.list({}, {}).rows.map((r) => r.externalId).sort(),
      ['fresh', 'fresh-shared', 'old-converted'],
    );
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM inbox_files').get()?.n, 2, '甲删了，乙、丙还有人用');
    assert.equal(purgeOldInbox(store, INBOX_KEEP_DAYS, now), 0);
  } finally {
    store.close();
  }
});
