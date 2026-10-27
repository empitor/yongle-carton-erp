import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { ImportManager } from '../server/import/manager.js';
import { ImportRepository } from '../server/import/repository.js';
import { importRouter } from '../server/import/router.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { ResponsesStream } from '../server/ai/responses-stream.js';
import { responsesText } from '../server/ai/responses-format.js';
import { completeCompatible } from '../server/ai/compatible-chat.js';
import { AiConnectionError } from '../server/ai/connection-error.js';
import { blankField } from '../shared/order-draft.js';
import type { AiTransport, WireRequest } from '../server/ai/transport.js';
import { docxFixture, xlsxFixture, pdfFixture } from './import-fixtures.js';
const key = 'sk-fictional-diagnostic-secret';
test('DeepSeek聊天补全使用相同受控预算，不混入Responses参数', async () => {
  let body: any;
  await completeCompatible(
    {
      provider: 'compatible',
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      apiStyle: 'chat-completions',
    },
    key,
    [{ role: 'user', content: '只输出JSON' }],
    async (r) => {
      body = r.body;
      return {
        status: 200,
        body: { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] },
      };
    },
    undefined,
    { maxOutputTokens: 16000, disableThinking: true },
  );
  assert.equal(body.max_tokens, 16000);
  assert.equal(body.thinking.type, 'disabled');
  assert.equal(body.reasoning, undefined);
  assert.equal(body.max_output_tokens, undefined);
});
const field = (value: string) => ({ ...blankField(), value, certainty: 'recognized' });
const analysis = () => ({
  header: { buyerName: field('虚构验收客户') },
  lines: [
    {
      productName: field('虚构纸箱'),
      quantity: field('1000'),
      unitPrice: field('1.3900'),
      unit: field('只'),
    },
  ],
});
const response = () => ({
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(analysis()) }],
    },
  ],
});
function fixture(transport: AiTransport) {
  const dir = mkdtempSync(join(tmpdir(), 'erp-recognition-diagnostics-'));
  const settings = new AiSettingsManager({
    protector: { protect: () => 'opaque', unprotect: () => key },
    transport,
  });
  const s = settings.saveDraft({
    name: '虚构DeepSeek',
    endpoint: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    apiKey: key,
    apiStyle: 'responses',
    expectedRevision: 0,
  });
  settings.activate({ id: s.presets[0].id, expectedRevision: s.revision });
  const manager = new ImportManager({ directory: dir, settings });
  return {
    dir,
    settings,
    manager,
    grant(w: any) {
      const p = settings.view().active!;
      return manager.consent(w.id, {
        accepted: true,
        expectedRevision: w.revision,
        presetId: p.id,
        endpoint: p.endpoint,
        model: p.model,
        apiStyle: p.apiStyle,
      });
    },
    close() {
      manager.close();
      settings.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('DeepSeek订单DOC/DOCX/XLSX/PDF兼容提取，流式/非流式完整草稿落地且原件不变', async () => {
  const requests: WireRequest[] = [];
  const f = fixture(async (r) => {
    requests.push(r);
    if ((r.body as any).stream) {
      r.onSseEvent!({
        event: 'response.completed',
        data: JSON.stringify({ type: 'response.completed', response: response() }),
      });
      return { status: 200, body: null, streamed: true };
    }
    return { status: 200, body: response() };
  });
  try {
    const files: [string, Buffer][] = [
      ['虚构.doc', readFileSync('tests/fixtures/import/word-extractor-test01.doc')],
      ['虚构.docx', docxFixture()],
      ['虚构.xlsx', xlsxFixture()],
      ['虚构.pdf', await pdfFixture()],
      ['扫描.pdf', await pdfFixture(true)],
    ];
    for (const stream of [true, false])
      for (const [name, bytes] of files) {
        let w = f.grant((await f.manager.upload(bytes, name)).workspace);
        assert.equal(w.consent?.policyVersion, 4);
        w = await f.manager.analyze(w.id, { expectedRevision: w.revision, stream });
        assert.equal(w.evaluation?.totalAmount, '1390.0000');
        assert.equal(w.inputMode, 'deepseek-compatible');
        const req = requests.at(-1)!,
          body = req.body as any;
        assert.equal(body.reasoning.effort, 'none');
        assert.equal(body.max_output_tokens, 16000);
        assert(!JSON.stringify(body).includes('input_file'));
        if (name === '扫描.pdf') assert(JSON.stringify(body).includes('input_image'));
        else assert(body.input[1].content[0].text.length > 100);
        assert(readFileSync(join(f.dir, w.id, 'original')).equals(bytes));
      }
  } finally {
    f.close();
  }
});
test('失败按次归档，保留截断原因/Token计数；密钥/原文不泄漏、重启不丢失也不重复补录', async () => {
  let calls = 0;
  const f = fixture(async (r) => {
    calls++;
    r.onSseEvent!({
      event: 'response.incomplete',
      data: JSON.stringify({
        type: 'response.incomplete',
        response: {
          id: 'resp-fictional-123',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          error: { message: key + '客户隐私原文' },
          usage: { output_tokens: 7000, output_tokens_details: { reasoning_tokens: 6980 } },
        },
      }),
    });
    return { status: 200, body: null, streamed: true };
  });
  let reopened: ImportManager | undefined;
  try {
    let w = f.grant((await f.manager.upload(docxFixture(), '虚构.docx')).workspace);
    for (let i = 0; i < 2; i++)
      await assert.rejects(
        f.manager.analyze(w.id, { expectedRevision: w.revision, stream: true }, undefined, {
          id: 'fictional-user',
          name: '验收账号',
        }),
        /输出上限/,
      );
    assert.equal(calls, 2);
    const records = f.manager.failures();
    assert.equal(records.total, 2);
    assert.equal(records.items[0].response?.reason, 'max_output_tokens');
    assert.equal(records.items[0].response?.reasoningTokens, 6980);
    assert.equal(records.items[0].operator?.id, 'fictional-user');
    assert(!JSON.stringify(records).includes(key));
    assert(!JSON.stringify(records).includes('客户隐私原文'));
    assert.equal(f.manager.get(w.id).draft, null);
    assert(f.manager.get(w.id).task?.failureId);
    f.manager.close();
    reopened = new ImportManager({ directory: f.dir, settings: f.settings });
    assert.equal(reopened.failures().total, 2);
    await reopened.remove(w.id, { expectedRevision: w.revision, acknowledged: true });
    assert.equal(reopened.failures(w.id).total, 2);
  } finally {
    if (reopened) {
      reopened.close();
      f.settings.close();
      rmSync(f.dir, { recursive: true, force: true });
    } else f.close();
  }
});
test('旧版四类摘要与程序中断仅补录一次；未知历史原因不编造', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-old-failure-'));
  const file = join(dir, 'workspaces.sqlite');
  let repo = new ImportRepository(file);
  try {
    repo.insert({
      id: 'fictional-old',
      fileHash: 'h',
      revision: 1,
      fileName: '旧文件.doc',
      task: { state: 'failed', error: '旧版只有摘要' },
    });
    repo.insert({
      id: 'fictional-interrupted',
      fileHash: 'g',
      revision: 0,
      fileName: '中断.pdf',
      task: { state: 'running' },
    });
    repo.close();
    repo = new ImportRepository(file);
    assert.equal(repo.failures().total, 2);
    assert(repo.failures().items.every((r) => r.historical && r.failedAt === null && !r.response));
    repo.close();
    repo = new ImportRepository(file);
    assert.equal(repo.failures().total, 2);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('旧DeepSeek外发授权失效；新兼容范围须重新确认，普通接口仍原件直传', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { status: 200, body: response() };
  });
  try {
    let w = f.grant((await f.manager.upload(docxFixture(), '虚构.docx')).workspace);
    const db = new DatabaseSync(join(f.dir, 'workspaces.sqlite'));
    const current = JSON.parse(
      String(db.prepare('SELECT document FROM workspaces WHERE id=?').get(w.id)!.document),
    );
    current.consent.policyVersion = 3;
    db.prepare('UPDATE workspaces SET document=? WHERE id=?').run(JSON.stringify(current), w.id);
    db.close();
    assert.equal(f.manager.get(w.id).consent, null);
    await assert.rejects(f.manager.analyze(w.id, { expectedRevision: w.revision }), /外发范围/);
    assert.equal(calls, 0);
    w = f.grant(f.manager.get(w.id));
    await f.manager.analyze(w.id, { expectedRevision: w.revision, stream: false });
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});
test('流式和非流式均保留真实失败原因，失败不能误判完成', () => {
  const r = {
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    usage: { output_tokens: 7000 },
    output: [],
  };
  assert.throws(
    () => responsesText(r),
    (e: any) => e.diagnostic?.reason === 'max_output_tokens',
  );
  const stream = new ResponsesStream(() => {});
  assert.throws(
    () =>
      stream.event({
        event: 'response.failed',
        data: JSON.stringify({
          type: 'response.failed',
          response: { status: 'failed', error: { code: 'insufficient_quota', message: key } },
        }),
      }),
    (e: any) => e.message.includes('额度') && !JSON.stringify(e).includes(key),
  );
});
test('诊断HTTP仅有业务管理权限的登录账号可查询下载，上传错误自动归档', async () => {
  const f = fixture(async () => ({ status: 200, body: response() })),
    app = express();
  app.use(express.json());
  app.use(
    importRouter(f.manager, (req) =>
      req.headers['x-test-user'] === 'editor'
        ? { id: 'e', name: '管理', permissions: ['business:edit'] }
        : req.headers['x-test-user'] === 'reader'
          ? { id: 'r', name: '只读', permissions: [] }
          : null,
    ),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
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
    const list = await (
      await fetch(base + '/diagnostics', { headers: { 'x-test-user': 'editor' } })
    ).json();
    assert.equal(list.total, 1);
    assert.equal(list.items[0].operation, 'upload');
    const r = await fetch(base + '/diagnostics/' + list.items[0].id + '?download=1', {
      headers: { 'x-test-user': 'editor' },
    });
    assert.match(r.headers.get('content-disposition')!, /attachment/);
    assert.equal((await r.json()).id, list.items[0].id);
    assert.equal((await fetch(base + '/diagnostics/' + list.items[0].id)).status, 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
test('SSE限流/HTTP524/网络断线/错误字段分别归档且未知计费结果不自动重发', async () => {
  for (const kind of ['sse-rate', 'gateway', 'network', 'schema']) {
    let count = 0;
    const f = fixture(async (r) => {
      count++;
      if (kind === 'sse-rate') {
        r.onSseEvent!({
          event: 'response.failed',
          data: JSON.stringify({
            type: 'response.failed',
            response: { error: { code: 'rate_limit_exceeded', message: key } },
          }),
        });
        throw Error('unreachable');
      }
      if (kind === 'gateway') return { status: 524, body: { error: { message: key } } };
      if (kind === 'network') throw Object.assign(Error(key), { code: 'ECONNRESET' });
      const b = response();
      b.output[0].content[0].text = JSON.stringify({
        header: { buyerName: '私密正文' },
        lines: [],
      });
      return { status: 200, body: b };
    });
    try {
      const w = f.grant((await f.manager.upload(docxFixture(), '虚构.docx')).workspace);
      await assert.rejects(f.manager.analyze(w.id, { expectedRevision: w.revision, stream: true }));
      assert.equal(count, 1);
      const records = f.manager.failures();
      assert.equal(records.total, 1);
      assert(!JSON.stringify(records).includes(key));
      assert(!JSON.stringify(records).includes('私密正文'));
      if (kind === 'gateway') assert.equal(records.items[0].upstreamStatus, 524);
      if (kind === 'schema') assert(records.items[0].schemaIssues.length > 0);
    } finally {
      f.close();
    }
  }
});
