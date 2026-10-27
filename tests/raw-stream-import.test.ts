import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { SseParser } from '../shared/sse.js';
import { ResponsesStream } from '../server/ai/responses-stream.js';
import { consumeWireResponse, type WireRequest, type AiTransport } from '../server/ai/transport.js';
import { completeResponses } from '../server/ai/compatible-responses.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { ImportManager } from '../server/import/manager.js';
import { headerFields, lineFields, blankField } from '../shared/order-draft.js';
import { AI_REQUEST_TIMEOUT_MS, AI_HTTP_TIMEOUT_MS } from '../shared/ai-runtime.js';
import { imageFixture, docxFixture, xlsxFixture } from './import-fixtures.js';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';
import { DatabaseSync } from 'node:sqlite';
const key = 'sk-fictional-raw-stream-test',
  aes = randomBytes(32),
  profile = {
    provider: 'compatible' as const,
    endpoint: 'https://api.example.com/v1',
    model: 'test-model',
    apiStyle: 'responses' as const,
  };
const protector = {
  protect(s: string) {
    const iv = randomBytes(12),
      c = createCipheriv('aes-256-gcm', aes, iv),
      data = Buffer.concat([c.update(s), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
  },
  unprotect(s: string) {
    const b = Buffer.from(s, 'base64'),
      c = createDecipheriv('aes-256-gcm', aes, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString();
  },
};
function analysis() {
  const header = Object.fromEntries(
      headerFields.map((k) => [k, { value: null, certainty: 'needs-review', note: '' }]),
    ),
    line = Object.fromEntries(
      lineFields.map((k) => [k, { value: null, certainty: 'needs-review', note: '' }]),
    );
  Object.assign(header, {
    buyerName: { value: '虚构客户', certainty: 'recognized', note: '' },
    orderDate: { value: '2026-10-01', certainty: 'recognized', note: '' },
    deliveryDate: { value: '2026-10-25', certainty: 'recognized', note: '' },
  });
  Object.assign(line, {
    productName: { value: '虚构纸箱', certainty: 'recognized', note: '' },
    quantity: { value: '1000', certainty: 'recognized', note: '' },
    unitPrice: { value: '1.3000', certainty: 'recognized', note: '' },
    unit: { value: '只', certainty: 'recognized', note: '' },
  });
  return { header, lines: [line], warnings: [] };
}
const body = (text = JSON.stringify(analysis())) => ({
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    },
  ],
});
const event = (type: string, value: unknown) => ({
  event: type,
  data: JSON.stringify({ type, ...(value as object) }),
});
async function fixture(transport: AiTransport) {
  const directory = mkdtempSync(join(tmpdir(), 'erp-raw-sse-')),
    settings = new AiSettingsManager({ protector, transport });
  let v = settings.saveDraft({
    name: '虚构协议测试',
    endpoint: profile.endpoint,
    model: profile.model,
    apiStyle: 'responses',
    apiKey: key,
    expectedRevision: 0,
  });
  v = settings.activate({ id: v.presets[0].id, expectedRevision: v.revision });
  const manager = new ImportManager({
    directory,
    settings,
    parser: async () => {
      throw new Error('本地解析器绝不能被调用');
    },
  });
  return {
    manager,
    settings,
    directory,
    grant(w: any) {
      const p = settings.view().active!;
      return manager.consent(w.id, {
        expectedRevision: w.revision,
        accepted: true,
        presetId: p.id,
        endpoint: p.endpoint,
        model: p.model,
        apiStyle: 'responses',
      });
    },
    close() {
      manager.close();
      settings.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('SSE分块、中文UTF8、多行data、CRLF和心跳能完整处理，缺失事件结束被拒绝', () => {
  const events: any[] = [],
    parser = new SseParser((e) => events.push(e)),
    decoder = new TextDecoder();
  const wire = Buffer.from(
    ': heartbeat\r\n\r\nevent: progress\r\ndata: {"text":\r\ndata: "纸箱📦"}\r\n\r\n',
  );
  for (const byte of wire) parser.push(decoder.decode(Uint8Array.of(byte), { stream: true }));
  parser.push(decoder.decode());
  parser.finish();
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0].data).text, '纸箱📦');
  const broken = new SseParser(() => {});
  broken.push('data: {}');
  assert.throws(() => broken.finish());
});

test('真实HTTP SSE客户端按网络数据处理事件，不把[Done]或output_text.done当完成', async () => {
  const completed = body(),
    collector = new ResponsesStream(() => {});
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    res.write(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"纸箱"}\n\n',
    );
    res.end(
      'event: response.completed\ndata: ' +
        JSON.stringify({ type: 'response.completed', response: completed }) +
        '\n\ndata: [DONE]\n\n',
    );
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  try {
    const response = await new Promise<any>((resolve, reject) =>
      get('http://127.0.0.1:' + (server.address() as any).port, (res) => {
        consumeWireResponse(res, {
          onSseEvent: collector.event,
          maxResponseBytes: 1024 * 1024,
        }).then(resolve, reject);
      }).on('error', reject),
    );
    assert.equal(response.streamed, true);
    assert.deepEqual(collector.finish(), completed);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  for (const type of ['response.output_text.done', 'done']) {
    const c = new ResponsesStream(() => {});
    c.event(event(type, { text: '{}' }));
    c.event({ event: 'message', data: '[DONE]' });
    assert.throws(() => c.finish());
  }
});

test('模型流式增量期间不写草稿，仅completed加EOF后校验并一次保存', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  let request: WireRequest | undefined;
  const f = await fixture(async (r) => {
    request = r;
    r.onSseEvent!(event('response.output_text.delta', { delta: '{"header":' }));
    entered();
    await gate;
    r.onSseEvent!(event('response.completed', { response: body() }));
    return { status: 200, body: null, streamed: true };
  });
  try {
    let w = f.grant((await f.manager.upload(xlsxFixture(), '订单.xlsx')).workspace);
    const progress: any[] = [];
    const pending = f.manager.analyze(w.id, { expectedRevision: w.revision, stream: true }, (p) =>
      progress.push(p),
    );
    await started;
    assert.equal(f.manager.get(w.id).draft, null);
    assert.equal(f.manager.get(w.id).revision, w.revision);
    assert.ok(progress.some((p) => p.receivedChars > 0));
    assert.ok(!JSON.stringify(progress).includes('header'));
    release();
    w = await pending;
    assert.equal(w.evaluation!.totalAmount, '1300.0000');
    assert.equal(request!.timeoutMs, 600000);
    assert.equal((request!.body as any).stream, true);
    assert.deepEqual(w.draft!.header.buyerName.sources, []);
    assert.equal(w.draft!.header.buyerName.certainty, 'needs-review');
    assert.equal(w.revision, 2);
  } finally {
    f.close();
  }
});

test('流提前断开、拒答、失败及截断均不保存半份JSON', async () => {
  for (const terminal of ['missing', 'response.incomplete', 'error', 'response.refusal.delta']) {
    const f = await fixture(async (r) => {
      r.onSseEvent!(event('response.output_text.delta', { delta: JSON.stringify(analysis()) }));
      if (terminal !== 'missing') r.onSseEvent!(event(terminal, {}));
      return { status: 200, body: null, streamed: true };
    });
    try {
      const w = f.grant((await f.manager.upload(docxFixture(), '订单.docx')).workspace);
      await assert.rejects(f.manager.analyze(w.id, { expectedRevision: w.revision, stream: true }));
      assert.equal(f.manager.get(w.id).draft, null);
      assert.equal(f.manager.get(w.id).revision, w.revision);
    } finally {
      f.close();
    }
  }
});

test('JPG/DOCX/XLSX两种模式均发送完整原始字节并生成草稿，不调用本地解析', async () => {
  for (const stream of [true, false]) {
    const requests: WireRequest[] = [];
    const f = await fixture(async (r) => {
      requests.push(r);
      if ((r.body as any).stream) {
        r.onSseEvent!(event('response.output_text.delta', { delta: '{"header":' }));
        r.onSseEvent!(event('response.completed', { response: body() }));
        return { status: 200, body: null, streamed: true };
      }
      return { status: 200, body: body() };
    });
    try {
      for (const [name, bytes] of [
        ['a.jpg', imageFixture(true)],
        ['a.docx', docxFixture()],
        ['a.xlsx', xlsxFixture()],
      ] as const) {
        let w = (await f.manager.upload(bytes, name)).workspace;
        assert.deepEqual(w.parsed.blocks, []);
        assert.deepEqual((await f.manager.file(w.id)).bytes, bytes);
        w = f.grant(w);
        w = await f.manager.analyze(w.id, { expectedRevision: w.revision, stream });
        assert.equal(w.draft!.lines.length, 1);
        const wire = requests.at(-1)!,
          input = (wire.body as any).input.flatMap((m: any) =>
            Array.isArray(m.content) ? m.content : [],
          ),
          part = input.find((p: any) => p.type === 'input_file' || p.type === 'input_image'),
          encoded = part.file_data || part.image_url;
        assert.ok(Buffer.from(encoded.split(',')[1], 'base64').equals(bytes));
        assert.equal(part.type, name.endsWith('.jpg') ? 'input_image' : 'input_file');
        assert.equal((wire.body as any).stream, stream);
        assert.ok(!JSON.stringify(wire.body).includes('sourceBlocks'));
        assert.ok(!JSON.stringify(wire.body).includes('source-1'));
      }
    } finally {
      f.close();
    }
  }
});

test('Office只有有效文件头也可上传进入AI，不能因本地解压失败拦截；错误由API真实返回', async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return { status: 422, body: { error: { code: 'invalid_file' } } };
  });
  try {
    const bytes = Buffer.from('504b0304deadbeef', 'hex');
    let w = (await f.manager.upload(bytes, '客户原单.xlsx')).workspace;
    assert.equal(w.inputMode, 'raw-file');
    w = f.grant(w);
    await assert.rejects(f.manager.analyze(w.id, { expectedRevision: w.revision, stream: false }));
    assert.equal(calls, 1);
    assert.equal(f.manager.get(w.id).draft, null);
    assert.ok((await f.manager.file(w.id)).bytes.equals(bytes));
  } finally {
    f.close();
  }
});

test('HTTP 524明确标为外部网关超时，区别于本地600秒，不做自动回退或保存', async () => {
  const f = await fixture(async () => ({ status: 524, body: null }));
  try {
    const w = f.grant((await f.manager.upload(xlsxFixture(), '订单.xlsx')).workspace);
    await assert.rejects(
      f.manager.analyze(w.id, { expectedRevision: w.revision, stream: false }),
      (e: any) =>
        e.code === 'gateway_timeout' && e.message.includes('524') && e.message.includes('不能解除'),
    );
    assert.equal(f.manager.get(w.id).draft, null);
    assert.equal(AI_REQUEST_TIMEOUT_MS, 600000);
    assert.equal(AI_HTTP_TIMEOUT_MS, 630000);
  } finally {
    f.close();
  }
});

test('旧内容提取授权不能用于原件外发，草稿和原文件保留，重新授权后可识别', async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return { status: 200, body: body() };
  });
  try {
    const bytes = docxFixture();
    let w = f.grant((await f.manager.upload(bytes, '旧工作区.docx')).workspace);
    const db = new DatabaseSync(join(f.directory, 'workspaces.sqlite'));
    try {
      db.prepare(
        "UPDATE workspaces SET document=json_set(document,'$.consent.policyVersion',2) WHERE id=?",
      ).run(w.id);
    } finally {
      db.close();
    }
    assert.equal(f.manager.get(w.id).consent, null);
    await assert.rejects(
      f.manager.analyze(w.id, { expectedRevision: w.revision, stream: false }),
      (e: any) => e.code === 'consent',
    );
    assert.equal(calls, 0);
    assert.ok((await f.manager.file(w.id)).bytes.equals(bytes));
    w = f.grant(f.manager.get(w.id));
    assert.equal(w.consent!.policyVersion, 3);
    w = await f.manager.analyze(w.id, { expectedRevision: w.revision, stream: false });
    assert.equal(w.evaluation!.totalAmount, '1300.0000');
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});

test('本机流式接口只转发进度和最终草稿，异常流发error且正式执行仍403', async () => {
  let fail = false;
  const f = await fixture(async (r) => {
      r.onSseEvent!(
        event('response.output_text.delta', { delta: '{"potential_secret":"' + key + '"' }),
      );
      if (!fail) r.onSseEvent!(event('response.completed', { response: body() }));
      return { status: 200, body: null, streamed: true };
    }),
    store = new Store(':memory:'),
    server = createApp(store, { aiSettings: f.settings, imports: f.manager }).listen(
      0,
      '127.0.0.1',
    );
  await new Promise<void>((r) => server.once('listening', r));
  try {
    const url = 'http://127.0.0.1:' + (server.address() as any).port + '/api/ai/imports';
    for (const [index, bytes] of [docxFixture(), xlsxFixture()].entries()) {
      let w = f.grant((await f.manager.upload(bytes, index ? 'bad.xlsx' : 'ok.docx')).workspace);
      fail = index === 1;
      const res = await fetch(url + '/' + w.id + '/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ERP-AI-Token': f.settings.csrfToken },
        body: JSON.stringify({ expectedRevision: w.revision, stream: true }),
      });
      assert.match(res.headers.get('content-type')!, /event-stream/);
      const text = await res.text();
      assert.ok(text.includes('event: progress'));
      assert.ok(!text.includes(key));
      assert.equal(text.includes('event: result'), !fail);
      assert.equal(text.includes('event: error'), fail);
      assert.equal(!!f.manager.get(w.id).draft, !fail);
      const denied = await fetch(url + '/' + w.id + '/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ERP-AI-Token': f.settings.csrfToken },
        body: '{}',
      });
      assert.equal(denied.status, 403);
    }
    assert.equal(store.orders().length, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    f.close();
  }
});
