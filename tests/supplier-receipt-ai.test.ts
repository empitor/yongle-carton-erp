import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv, createDecipheriv, randomUUID, createHash } from 'node:crypto';
import { Store } from '../server/db.js';
import { ReceiptAi, supplierDefaultPreset } from '../server/flow/receipt-ai.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import type { WireRequest, AiTransport } from '../server/ai/transport.js';
import { imageFixture, docxFixture, xlsxFixture, pdfFixture } from './import-fixtures.js';
import { FlowService } from '../server/flow/service.js';
import { OperationsService } from '../server/operations/service.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
const actor = {
    id: 'fictional-ai-receiver',
    name: '送货验收（虚构）',
    permissions: ['business:edit'],
  },
  secret = 'sk-fictional-supplier-test',
  aes = randomBytes(32);
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
const analysis = () => ({
  supplierName: '虚构送货纸板厂',
  reference: 'TEST-DH-1',
  purchaseNumber: null,
  date: '2026-10-25',
  notes: null,
  warnings: [],
  lines: [
    {
      name: '测试纸板',
      specification: '100x80cm',
      material: 'K=A',
      flute: 'BC',
      length: '100',
      width: '80',
      dimensionUnit: 'cm',
      quantity: '100',
      unit: '张',
      area: '80',
      unitPrice: '2.1234',
      priceBasis: 'area',
      notes: null,
    },
  ],
});
const body = (result: unknown) => ({
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(result) }],
    },
  ],
});
function fixture(transport: AiTransport) {
  const store = new Store(':memory:'),
    prompts = new PromptPresetManager(':memory:', supplierDefaultPreset),
    settings = new AiSettingsManager({ protector, transport });
  let s = settings.saveDraft({
    name: '虚构模型服务',
    endpoint: 'https://api.example.com/v1',
    model: 'test-model',
    apiStyle: 'responses',
    apiKey: secret,
    expectedRevision: 0,
  });
  settings.activate({ id: s.presets[0].id, expectedRevision: s.revision });
  const ai = new ReceiptAi(store, settings, prompts);
  return {
    store,
    ai,
    prompts,
    settings,
    input: (stream: boolean) => ({ consent: true, stream, profile: settings.view().active }),
    close() {
      store.close();
      prompts.close();
      settings.close();
    },
  };
}
test('供应商图片/DOCX/XLSX/PDF原字节直传，启用自定义提示词，流式/非流式均仅完整结果落草稿且不改库存', async () => {
  const requests: WireRequest[] = [],
    transport: AiTransport = async (r) => {
      requests.push(r);
      if ((r.body as any)?.stream) {
        r.onSseEvent?.({
          event: 'response.output_text.delta',
          data: JSON.stringify({ type: 'response.output_text.delta', delta: '识别中' }),
        });
        r.onSseEvent?.({
          event: 'response.completed',
          data: JSON.stringify({ type: 'response.completed', response: body(analysis()) }),
        });
        return { status: 200, body: {} };
      }
      return { status: 200, body: body(analysis()) };
    };
  const f = fixture(transport);
  try {
    const s = f.prompts.view(),
      p = s.presets[0];
    p.entries.push({
      id: randomUUID(),
      name: '测试定制规则',
      enabled: true,
      content: '保留客户独立备注：FICTIONAL_SUPPLIER_RULE',
    });
    f.prompts.change('save', { expectedRevision: s.revision, preset: p, activate: true });
    const files: [string, Buffer][] = [
      ['送货.jpg', await imageFixture(true)],
      ['送货.docx', docxFixture()],
      ['送货.xlsx', xlsxFixture()],
      ['送货.pdf', await pdfFixture()],
    ];
    for (const stream of [false, true])
      for (const [fileName, bytes] of files) {
        // 不同虚构文件内容，避免上传哈希去重影响本测试。
        const unique = Buffer.concat([bytes, Buffer.from(stream ? '\nTEST-SSE' : '\nTEST-JSON')]),
          source = f.ai.upload(unique, fileName, actor)!;
        let progress = 0;
        const result = await f.ai.analyze(
          String(source.id),
          f.input(stream),
          actor,
          () => progress++,
        );
        assert.equal(result?.result.lines[0].quantity, '100');
        assert.equal(f.store.orders().length, 0);
        assert.equal(f.store.stock_items().length, 0);
        assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM stock_movements').get()!.n, 0);
        const req = requests.at(-1)!;
        assert.equal(req.timeoutMs, 600000);
        assert.equal(req.url.pathname, '/v1/responses');
        assert.equal(req.headers.Authorization, 'Bearer ' + secret);
        assert.match(JSON.stringify(req.body), /FICTIONAL_SUPPLIER_RULE/);
        const part = (req.body as any).input[1].content[1];
        assert.equal(part.type, fileName.endsWith('.jpg') ? 'input_image' : 'input_file');
        assert.deepEqual(
          Buffer.from((part.image_url || part.file_data).split(',')[1], 'base64'),
          unique,
        );
        assert(!JSON.stringify(source).includes(secret));
        if (stream) assert(progress > 0);
      }
    const audit = JSON.stringify(f.store.db.prepare('SELECT * FROM business_audit').all());
    assert(!audit.includes(secret));
    assert(!audit.includes('FICTIONAL_SUPPLIER_RULE'));
    assert(!audit.includes('K=A'));
  } finally {
    f.close();
  }
});
test('未授权/预设切换/错误格式/模型响应错误/流中断拒绝；同文件识别防重复且文件哈希防篡改', async () => {
  let fail = false;
  const f = fixture(async () => ({ status: 200, body: body(fail ? { lines: [] } : analysis()) }));
  try {
    assert.throws(() => f.ai.upload(Buffer.from('text'), 'fake.pdf', actor), /格式不支持|文件头/);
    const bytes = docxFixture(),
      s = f.ai.upload(bytes, '真实类型.docx', actor)!;
    assert.equal(f.ai.upload(bytes, '第二次.docx', actor)!.id, s.id);
    await assert.rejects(() =>
      f.ai.analyze(String(s.id), { ...f.input(false), consent: false }, actor),
    );
    await assert.rejects(
      () =>
        f.ai.analyze(
          String(s.id),
          { ...f.input(false), profile: { ...f.settings.view().active, model: 'another' } },
          actor,
        ),
      /已变化/,
    );
    fail = true;
    await assert.rejects(() => f.ai.analyze(String(s.id), f.input(false), actor));
    assert.equal(f.ai.sources()[0].result, null);
    fail = false;
    const source = f.store.db.prepare('SELECT * FROM flow_sources WHERE id=?').get(s.id)!;
    assert.deepEqual(Buffer.from(source.bytes as Uint8Array), bytes);
    f.store.db
      .prepare('UPDATE flow_sources SET bytes=? WHERE id=?')
      .run(Buffer.from('tampered'), s.id);
    await assert.rejects(() => f.ai.analyze(String(s.id), f.input(false), actor), /完整性/);
  } finally {
    f.close();
  }
  const g = fixture(async (r) => {
    r.onSseEvent?.({
      event: 'response.output_text.delta',
      data: JSON.stringify({ type: 'response.output_text.delta', delta: '{"supplierName":' }),
    });
    return { status: 200, body: {} };
  });
  try {
    const s = g.ai.upload(docxFixture(), '中断.docx', actor)!;
    await assert.rejects(() => g.ai.analyze(String(s.id), g.input(true), actor));
    assert.equal(g.ai.sources()[0].result, null);
  } finally {
    g.close();
  }
});
test('同一AI原件不可二次入库，预览绑定原件哈希，收货只经人工受控确认', async () => {
  const f = fixture(async () => ({ status: 200, body: body(analysis()) }));
  try {
    const source = f.ai.upload(docxFixture(), '有来源.docx', actor)!;
    await f.ai.analyze(String(source.id), f.input(false), actor);
    const ops = new OperationsService(f.store),
      supplier = ops.saveSupplier({ name: '虚构送货纸板厂' }, actor),
      flow = new FlowService(f.store);
    const input = {
      date: '2026-10-25',
      supplierId: supplier.id,
      reference: 'AI-DH1',
      sourceId: source.id,
      lines: [
        {
          item: {
            name: '测试纸板',
            unit: '张',
            length: 100,
            width: 80,
            dimensionUnit: 'cm',
            material: 'K=A',
            flute: 'BC',
            specification: '100x80cm',
          },
          quantity: '100',
          unitPrice: '2.1234',
        },
      ],
    };
    const first = flow.save('arrival', input, actor),
      p = flow.preview(first.id, actor, 'session');
    assert.equal(p.sourceHash, createHash('sha256').update(docxFixture()).digest('hex'));
    flow.confirm(
      first.id,
      { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
      actor,
      'session',
    );
    const duplicate = flow.save('arrival', { ...input, reference: 'changed-reference' }, actor),
      p2 = flow.preview(duplicate.id, actor, 'session');
    assert.throws(
      () =>
        flow.confirm(
          duplicate.id,
          { previewId: p2.previewId, requestId: randomUUID(), acknowledged: true },
          actor,
          'session',
        ),
      /已经确认入库/,
    );
    assert.equal(ops.repo.items()[0].quantity, '100');
  } finally {
    f.close();
  }
});
test('供应商文件上传HTTP入口、流式识别与原件下载实际联通，凭据不进入浏览器', async () => {
  const f = fixture(async () => ({ status: 200, body: body(analysis()) })),
    auth = new AuthManager(':memory:'),
    server = createApp(f.store, { auth, aiSettings: f.settings, receiptAi: f.ai }).listen(
      0,
      '127.0.0.1',
    );
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    const setup = await fetch(base + '/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
        body: JSON.stringify({ name: '虚构验收', password: 'fictional-receipt-password-123' }),
      }),
      cookie = setup.headers.get('set-cookie')!.split(';')[0],
      bytes = docxFixture();
    const upload = await fetch(base + '/api/flow/sources/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Cookie: cookie,
        'X-ERP-Auth-Token': auth.csrf,
        'X-File-Name': encodeURIComponent('真实直传.docx'),
      },
      body: new Uint8Array(bytes),
    });
    assert.equal(upload.status, 201);
    const source = await upload.json();
    assert.equal(source.fileName, '真实直传.docx');
    assert(!JSON.stringify(source).includes(secret));
    const response = await fetch(base + '/api/flow/sources/' + source.id + '/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-ERP-Auth-Token': auth.csrf,
      },
      body: JSON.stringify(f.input(false)),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.supplierName, '虚构送货纸板厂');
    const original = await fetch(base + '/api/flow/sources/' + source.id + '/file', {
      headers: { Cookie: cookie },
    });
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    const state = await fetch(base + '/api/ai/receipt-prompts', {
      headers: { Cookie: cookie },
    }).then((r) => r.json());
    assert.equal(state.presets[0].name, '供应商送货单识别 · 默认');
    assert(!JSON.stringify(state).includes(secret));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    auth.close();
    f.close();
  }
});
