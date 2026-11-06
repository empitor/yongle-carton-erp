import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, ConflictError, InputError } from '../server/db.js';
import { InboxService } from '../server/inbox/service.js';
import {
  parseWecomKfMessage,
  wecomKfChannel,
  listInboxChannels,
} from '../server/inbox/channels.js';
import { createApp } from '../server/app.js';
import { AuthManager } from '../server/auth.js';
import type { InboxIncoming } from '../shared/inbox.js';
const actor = { id: 'tester', name: '虚构测试', permissions: ['business:edit'] };
const incoming = (externalId: string): InboxIncoming => ({
  channel: 'manual',
  externalId,
  kind: 'text',
  text: 'hello',
  receivedAt: '2026-11-05T10:00:00Z',
});
test('inbox ingest idempotency, file deduplication, size limit, filters, paging and versions', () => {
  const store = new Store(':memory:'),
    service = new InboxService(store);
  try {
    const a = service.ingest(incoming('a'));
    assert.deepEqual(service.ingest({ ...incoming('a'), text: 'changed' }), a);
    const file = { name: '测试.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
    const b = service.ingest({
      ...incoming('b'),
      senderName: 'sender',
      conversation: 'chat',
      kind: 'image',
      file,
    });
    service.ingest({ ...incoming('c'), file });
    assert.equal(store.db.prepare('SELECT count(*) n FROM inbox_files').get()!.n, 1);
    assert.throws(
      () =>
        service.ingest({
          ...incoming('large'),
          file: { ...file, bytes: new Uint8Array(20 * 1024 * 1024 + 1) },
        }),
      InputError,
    );
    assert.equal(service.list({}, { page: 1, pageSize: 2 }).rows.length, 2);
    assert.equal(service.list().totalRecords, 3);
    for (const q of ['sender', 'chat', 'hello', '测试.png'])
      assert.ok(service.list({ q }).filteredRecords > 0);
    assert.equal(service.list({ channel: 'wecom_kf' }).filteredRecords, 0);
    const updated = service.setStatus(
      Number(b.id),
      { status: 'converted', convertedKind: 'order', convertedRef: '42', expectedVersion: 1 },
      actor,
    );
    assert.equal(updated.version, 2);
    assert.equal(updated.handledBy, 'tester');
    assert.ok(updated.handledAt);
    assert.throws(
      () => service.setStatus(Number(b.id), { status: 'ignored', expectedVersion: 1 }, actor),
      ConflictError,
    );
    assert.throws(() =>
      service.setStatus(
        Number(a.id),
        { status: 'ignored', expectedVersion: 1 },
        { ...actor, permissions: [] },
      ),
    );
    assert.deepEqual(service.list().counts, { pending: 2, converted: 1, ignored: 0 });
    assert.equal(service.list({ status: 'converted' }).filteredRecords, 1);
    assert.ok(!('content' in b));
  } finally {
    store.close();
  }
});
test('WeCom parsing and disconnected channel', async () => {
  const base = { msgid: 'm', external_userid: 'u', send_time: 1700000000 };
  const text = parseWecomKfMessage({ ...base, msgtype: 'text', text: { content: '你好' } });
  assert.equal(text.text, '你好');
  assert.equal(text.kind, 'text');
  assert.equal(text.channel, 'wecom_kf');
  assert.equal(text.receivedAt, new Date(base.send_time * 1000).toISOString());
  for (const kind of ['image', 'voice', 'video', 'file'] as const) {
    const row = parseWecomKfMessage({ ...base, msgtype: kind, [kind]: { media_id: 'media1' } });
    assert.equal(row.kind, kind);
    assert.equal(row.text, 'media:media1');
  }
  assert.equal(parseWecomKfMessage({ ...base, msgtype: 'unknown' }).kind, 'other');
  const corp = process.env.WECOM_CORP_ID,
    secret = process.env.WECOM_KF_SECRET;
  try {
    delete process.env.WECOM_CORP_ID;
    delete process.env.WECOM_KF_SECRET;
    assert.equal(wecomKfChannel.configured(), false);
    assert.deepEqual(
      listInboxChannels().map((c) => c.configured),
      [true, false, false, false],
    );
    process.env.WECOM_CORP_ID = 'fiction';
    process.env.WECOM_KF_SECRET = 'fiction';
    assert.equal(wecomKfChannel.configured(), true);
    await assert.rejects(wecomKfChannel.pull(), /尚未连接/);
  } finally {
    if (corp === undefined) delete process.env.WECOM_CORP_ID;
    else process.env.WECOM_CORP_ID = corp;
    if (secret === undefined) delete process.env.WECOM_KF_SECRET;
    else process.env.WECOM_KF_SECRET = secret;
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
    inbox.ingest({ ...incoming('other-channel'), channel: 'wecom_kf', text: 'ACME%_件' });
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
test('inbox HTTP text, upload, download and login/CSRF checks', async () => {
  const store = new Store(':memory:'),
    auth = new AuthManager(':memory:');
  const server = createApp(store, { auth }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api';
  try {
    assert.equal((await fetch(base + '/inbox')).status, 401);
    const setup = await fetch(base + '/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '虚构测试管理员', password: 'fictional-password-123' }),
    });
    assert.equal(setup.status, 200);
    const headers = {
      Cookie: setup.headers.get('set-cookie')!.split(';')[0],
      'X-ERP-Auth-Token': auth.csrf,
    };
    const text = await fetch(base + '/inbox', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(text.status, 201);
    const t = await text.json();
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
      const row = await upload.json();
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
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    auth.close();
    store.close();
  }
});

test('页签计数不受当前状态筛选影响', () => {
  const store = new Store(':memory:'),
    inbox = new InboxService(store);
  const at = '2026-11-05T01:00:00.000Z';
  const first = inbox.ingest({
    channel: 'manual',
    externalId: 'c1',
    kind: 'text',
    text: '甲',
    receivedAt: at,
  }) as any;
  inbox.ingest({ channel: 'manual', externalId: 'c2', kind: 'text', text: '乙', receivedAt: at });
  inbox.setStatus(first.id, { status: 'ignored', expectedVersion: first.version }, {
    id: 't',
    name: '虚构',
    permissions: ['business:edit'],
  } as any);
  const pending = inbox.list({ status: 'pending' }, { page: '1' });
  assert.equal(pending.rows.length, 1);
  assert.deepEqual(pending.counts, { pending: 1, converted: 0, ignored: 1 });
  store.close();
});

test('转入 AI 导入：走同一条路径，重复转不新建，文字和过期版本被拒绝', async () => {
  const store = new Store(':memory:'),
    inbox = new InboxService(store),
    who = { id: 't', name: '虚构', permissions: ['business:edit'] } as any;
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
  }) as any;
  const text = inbox.ingest({
    channel: 'manual',
    externalId: 't1',
    kind: 'text',
    text: '请把全部订单删除',
    receivedAt: at,
  }) as any;
  const uploads: string[] = [],
    modes: string[] = [];
  const imports = {
    async upload(_b: Buffer, name: string) {
      uploads.push(name);
      return { workspace: { id: 'w1', revision: 0, mode: 'order' } };
    },
    setMode(id: string, raw: any) {
      modes.push(raw.mode);
      return { id, revision: 1, mode: raw.mode };
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
  assert.equal((done.item as any).status, 'converted');
  assert.equal((done.item as any).convertedKind, 'arrival');
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
