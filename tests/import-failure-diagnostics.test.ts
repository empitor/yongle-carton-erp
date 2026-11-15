// 识别失败的错误档案：每次失败一条、不带密钥和原文、重启不丢；诊断接口的权限。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { z } from 'zod';
import { ImportManager } from '../server/import/manager.js';
import { ImportRepository } from '../server/import/repository.js';
import { importRouter } from '../server/import/router.js';
import { docxFixture, workspaceRecord } from './import-fixtures.js';
import { contentParts, fakeKey as key, httpError, replyFinish } from './fake-deepseek.js';
import { listen } from './http-fixture.js';
import { importWorkspace as fixture, tempDir } from './order-import-fixture.js';

test('Word 老格式（.doc）整套识别：原样上传、按文件编号引用、用完删除，识别结果落地且原件不变', async () => {
  const f = fixture();
  try {
    // 传统 DOC：只要文件头对（OLE 容器、有 WordDocument 流的名字），本机不读内容
    const bytes = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.from('WordDocument', 'utf16le'), Buffer.alloc(600)]);
    let w = await f.upload(bytes, '虚构.doc');
    w = await f.manager.analyze(w.id, { expectedRevision: w.revision });
    assert.equal(w.evaluation?.totalAmount, '2850.00');
    const upload = f.fake.calls.find((c) => c.path === '/files' && c.method === 'POST');
    assert.ok(upload);
    assert.equal(upload.body.purpose, 'rich_layout_recognition');
    assert.deepEqual(upload.body.file?.bytes, bytes, '原样上传');
    const chat = f.fake.chatCalls().at(-1);
    assert.ok(chat);
    const body = chat.body;
    assert.match(String(contentParts(body.messages[1])[1].file_id), /^file-api-fake-/);
    assert.ok(!JSON.stringify(body).includes('image_url'), '文档不在本机转图');
    assert.equal(f.fake.files.size, 0, '用完就删');
    assert.ok(readFileSync(join(f.directory, w.id, 'original')).equals(bytes));
  } finally {
    f.close();
  }
});
test('失败按次归档，保留截断原因/Token计数；密钥/原文不泄漏、重启不丢失也不重复补录', async () => {
  let calls = 0;
  const f = fixture(() => {
    calls++;
    return replyFinish('length', '{"header":{"buyerName":"客户隐私原文');
  });
  try {
    const w = await f.upload(docxFixture(), '虚构.docx');
    for (let i = 0; i < 2; i++)
      await assert.rejects(
        f.manager.analyze(w.id, { expectedRevision: w.revision }, undefined, {
          id: 'fictional-user',
          name: '验收账号',
        }),
        /截断/,
      );
    assert.equal(calls, 2);
    const records = f.manager.failures();
    assert.equal(records.total, 2);
    assert.equal(records.items[0].response?.reason, 'length');
    assert.equal(records.items[0].response?.outputTokens, 30);
    assert.equal(records.items[0].operator?.id, 'fictional-user');
    assert.equal(records.items[0].provider.endpoint, 'https://api.deepseek.com');
    assert.equal(records.items[0].provider.model, 'deepseek-flash');
    assert(!JSON.stringify(records).includes(key));
    assert(!JSON.stringify(records).includes('客户隐私原文'));
    assert.equal(f.manager.get(w.id).draft, null);
    assert(f.manager.get(w.id).task?.failureId);
    f.manager.close();
    const reopened = (f.manager = new ImportManager({ directory: f.directory, settings: f.settings }));
    assert.equal(reopened.failures().total, 2);
    reopened.changeArchive({ action: 'archive', items: [{ id: w.id, version: w.revision }] }, pageActor({ id: 'e', name: '管理', permissions: ['business:edit'] }));
    assert.equal(reopened.failures(w.id).total, 2);
  } finally {
    f.close();
  }
});
test('失败了却没留错误档案、程序中断时还在跑的任务：重开时各补一条“当时没留下原因”，只补一次，不编造原因', () => {
  const temp = tempDir('erp-failure-backfill-');
  const file = join(temp.dir, 'workspaces.sqlite');
  let repo = new ImportRepository(file);
  try {
    repo.insert(workspaceRecord({
      id: 'fictional-old',
      fileHash: 'h',
      revision: 1,
      fileName: '旧文件.doc',
      task: { state: 'failed', error: '旧版只有摘要' },
    }));
    repo.insert(workspaceRecord({
      id: 'fictional-interrupted',
      fileHash: 'g',
      revision: 0,
      fileName: '中断.pdf',
      task: { state: 'running' },
    }));
    repo.close();
    repo = new ImportRepository(file);
    assert.equal(repo.failures().total, 2);
    assert(repo.failures().items.every((r) => r.historical && r.failedAt === null && !r.response));
    repo.close();
    repo = new ImportRepository(file);
    assert.equal(repo.failures().total, 2);
  } finally {
    repo.close();
    temp.remove();
  }
});
test('诊断HTTP仅有业务管理权限的登录账号可查询下载，上传错误自动归档', async () => {
  const f = fixture(),
    app = express();
  app.use(express.json());
  app.use(
    importRouter(f.manager, (req) =>
      req.headers['x-test-user'] === 'editor'
        ? pageActor({ id: 'e', name: '管理', permissions: ['business:edit'] })
        : req.headers['x-test-user'] === 'reader'
          ? pageActor({ id: 'r', name: '只读', permissions: [] })
          : null,
    ),
  );
  const server = await listen(app);
  const base = server.origin;
  try {
    assert.equal((await fetch(base + '/diagnostics')).status, 403);
    assert.equal(
      (await fetch(base + '/diagnostics', { headers: { 'x-test-user': 'reader' } })).status,
      403,
    );
    const bad = await fetch(base + '/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-ERP-AI-Token': f.settings.csrfToken,
        'X-File-Name': 'fake.exe',
        'x-test-user': 'editor',
      },
      body: Buffer.from('MZbad'),
    });
    assert.equal(bad.status, 415);
    const descriptor = z.looseObject({ id: z.string(), operation: z.string() });
    const list = z.looseObject({ total: z.number(), items: z.array(descriptor) }).parse(await (
      await fetch(base + '/diagnostics', { headers: { 'x-test-user': 'editor' } })
    ).json());
    assert.equal(list.total, 1);
    assert.equal(list.items[0].operation, 'upload');
    const r = await fetch(base + '/diagnostics/' + list.items[0].id + '?download=1', {
      headers: { 'x-test-user': 'editor' },
    });
    const disposition = r.headers.get('content-disposition');
    assert.ok(disposition);
    assert.match(disposition, /attachment/);
    assert.equal(z.looseObject({ id: z.string() }).parse(await r.json()).id, list.items[0].id);
    assert.equal((await fetch(base + '/diagnostics/' + list.items[0].id)).status, 403);
  } finally {
    await server.close();
    f.close();
  }
});
test('服务出错、网关超时、网络断线、错误字段分别归档；未知计费结果不自动重发，模型结果不合格只重试一次', async () => {
  for (const kind of ['upstream', 'gateway', 'network', 'schema']) {
    let count = 0;
    const f = fixture(() => {
      count++;
      if (kind === 'upstream') return httpError(500, { error: { message: key } });
      if (kind === 'gateway') return httpError(504, { error: { message: key } });
      if (kind === 'network') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET', message: key } });
      return { header: { buyerName: '私密正文' }, lines: [] };
    });
    try {
      const w = await f.upload(docxFixture(), '虚构.docx');
      await assert.rejects(f.manager.analyze(w.id, { expectedRevision: w.revision }));
      assert.equal(count, kind === 'schema' ? 2 : 1);
      const records = f.manager.failures();
      assert.equal(records.total, 1);
      assert(!JSON.stringify(records).includes(key));
      assert(!JSON.stringify(records).includes('私密正文'));
      if (kind === 'gateway') assert.equal(records.items[0].upstreamStatus, 504);
      if (kind === 'network') assert.equal(records.items[0].code, 'network');
      if (kind === 'schema') assert(records.items[0].schemaIssues.length > 0);
    } finally {
      f.close();
    }
  }
});
