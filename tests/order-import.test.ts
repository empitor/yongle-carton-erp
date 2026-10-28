import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { parseUpload, detectFormat } from '../server/import/parse-file.js';
import { ImportManager } from '../server/import/manager.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { completeCompatible } from '../server/ai/compatible-chat.js';
import {
  evaluateDraft,
  multiplyExact,
  blankField,
  headerFields,
  lineFields,
  sourceReferenceSchema,
  type OrderDraft,
} from '../shared/order-draft.js';
import { createApp } from '../server/app.js';
import { importRouter } from '../server/import/router.js';
import express from 'express';
import { Store } from '../server/db.js';
import {
  xlsxFixture,
  docxFixture,
  pdfFixture,
  imageFixture,
  zipFixture,
} from './import-fixtures.js';

const key = 'sk-fictional-import-test-key';
const cryptoKey = randomBytes(32);
const protector = {
  protect(s: string) {
    const iv = randomBytes(12),
      c = createCipheriv('aes-256-gcm', cryptoKey, iv),
      data = Buffer.concat([c.update(s), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
  },
  unprotect(s: string) {
    const b = Buffer.from(s, 'base64'),
      c = createDecipheriv('aes-256-gcm', cryptoKey, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString();
  },
};
const sourceText =
  '虚构客户 供应方宁波甬勒包装制品有限公司 TEST-01 2026-09-01 2026-09-04 人民币 含税13% 纸箱A 300×200×150毫米 牛卡 B楞 单色印刷 数量1000只 单价1.39 金额1390.00 纸箱B 200×150×100毫米 白面纸 E楞 粘箱 数量2000只 单价0.73 金额1460.00 总数量3000 总金额2850.00';
function field(value: string | null) {
  return value === null
    ? blankField()
    : { value, sources: ['source-1'], quote: value, certainty: 'recognized' as const, note: '' };
}
function analysis() {
  const header = Object.fromEntries(headerFields.map((k) => [k, field(null)]));
  Object.assign(header, {
    buyerName: field('虚构客户'),
    supplierName: field('宁波甬勒包装制品有限公司'),
    purchaseOrderNumber: field('TEST-01'),
    orderDate: field('2026-09-01'),
    deliveryDate: field('2026-09-04'),
    currency: field('人民币'),
    taxRate: field('13'),
    taxMode: field('含税'),
    statedTotalQuantity: field('3000'),
    statedTotalAmount: field('2850.00'),
  });
  const lines = [
    ['纸箱A', '1000', '1.39', '1390.00'],
    ['纸箱B', '2000', '0.73', '1460.00'],
  ].map(([name, q, p, total]) =>
    Object.assign(Object.fromEntries(lineFields.map((k) => [k, field(null)])), {
      productName: field(name),
      specification: field('300×200×150毫米'),
      quantity: field(q),
      unit: field('只'),
      unitPrice: field(p),
      statedAmount: field(total),
    }),
  );
  return { header, lines, warnings: [] };
}
function asDraft(): OrderDraft {
  const a = analysis();
  return {
    header: a.header as any,
    lines: a.lines.map((fields) => ({ id: randomUUID(), fields: fields as any })),
    warnings: [],
  };
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'erp-order-workspace-'));
  const calls: any[] = [];
  let reply: unknown = analysis();
  const settings = new AiSettingsManager({
    protector,
    transport: async (r) => {
      calls.push(r);
      return {
        status: 200,
        body: {
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: JSON.stringify(reply) }],
            },
          ],
        },
      };
    },
  });
  settings.saveDraft({
    name: '测试预设',
    endpoint: 'https://api.example.com/v1',
    model: 'unit-model',
    apiStyle: 'responses',
    apiKey: key,
    expectedRevision: 0,
  });
  settings.activate({ id: settings.view().presets[0].id, expectedRevision: 1 });
  const manager = new ImportManager({
    directory,
    settings,
    parser: async (buffer, _name, id, dir) => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'original'), buffer);
      return {
        format: 'xlsx',
        blocks: [
          {
            id: 'source-1',
            text: sourceText,
            ref: { kind: 'excel', fileId: id, sheet: '虚构订单', row: 1 },
            method: 'xml',
          },
        ],
        previews: [],
        warnings: [],
        imagePages: [],
      };
    },
  });
  const w = (await manager.upload(xlsxFixture(), '虚构订单.xlsx')).workspace;
  return {
    directory,
    settings,
    manager,
    w,
    calls,
    setReply: (r: unknown) => {
      reply = r;
    },
    close() {
      manager.close();
      settings.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function consentData(f: Awaited<ReturnType<typeof fixture>>, revision: number) {
  const p = f.settings.view().active!;
  return {
    expectedRevision: revision,
    accepted: true,
    presetId: p.id,
    endpoint: p.endpoint,
    model: p.model,
    apiStyle: p.apiStyle,
  };
}
async function recognized(f: Awaited<ReturnType<typeof fixture>>) {
  const w = f.manager.consent(f.w.id, consentData(f, 0));
  return f.manager.analyze(w.id, { expectedRevision: w.revision });
}

test('识别成功后默认阻止覆盖草稿，显式 force 可重新识别一次', async () => {
  const f = await fixture();
  try {
    const w = await recognized(f);
    await assert.rejects(f.manager.analyze(w.id, { expectedRevision: w.revision }), /已有草稿/);
    const again = await f.manager.analyze(w.id, {
      expectedRevision: w.revision,
      force: true,
      stream: false,
    });
    assert.ok(again.draft);
    assert.ok(
      again.messages.some(
        (m) => m.role === 'assistant' && String(m.text).includes('已重新识别并覆盖原草稿'),
      ),
    );
  } finally {
    f.close();
  }
});

test('导入文件默认识别订单；可切换为到货单并保留两种草稿', async () => {
  const f = await fixture();
  try {
    let w = await recognized(f);
    assert.equal(w.mode || 'order', 'order');
    const original = await f.manager.original(w.id);
    assert.ok(original.bytes.length > 0);
    assert.equal(original.fileName, w.fileName);
    w = f.manager.setMode(w.id, { expectedRevision: w.revision, mode: 'arrival' });
    assert.equal(w.mode, 'arrival');
    assert.ok(w.draft, '切换类型不得删除原订单草稿');
    w = f.manager.linkArrival(w.id, { expectedRevision: w.revision, docId: 123, sourceId: null });
    assert.equal(w.arrivalDocId, 123);
    const reopened = f.manager.get(w.id);
    assert.equal(reopened.mode, 'arrival');
    assert.equal(reopened.arrivalDocId, 123);
    assert.ok(reopened.draft, '到货草稿关联不得删除原订单草稿');
    const summary = f.manager.status().workspaces.find((x: any) => x.id === w.id);
    assert.equal(summary.mode, 'arrival');
    assert.equal(summary.arrivalDocId, 123);
    const back = f.manager.setMode(w.id, { expectedRevision: w.revision, mode: 'order' });
    assert.equal(back.mode, 'order');
    assert.equal(back.arrivalDocId, 123, '切回订单识别仍保留到货草稿关联');
  } finally {
    f.close();
  }
});

test('到货单识别接口复用供应商 AI 识别服务并读取原工作区原件', async () => {
  const f = await fixture(),
    fakeReceiptAi = {
      settings: {
        view: () => ({
          active: {
            id: '00000000-0000-4000-8000-000000000901',
            endpoint: 'https://ai.example.test/v1',
            model: 'fake-arrival',
            apiStyle: 'responses',
            hasApiKey: true,
          },
        }),
      },
      upload: () => ({ id: '00000000-0000-4000-8000-000000000902' }),
      analyze: async () => ({
        id: '00000000-0000-4000-8000-000000000902',
        result: {
          supplierName: '虚构到货供应商',
          reference: 'SH-TEST-01',
          date: '2026-10-01',
          lines: [{ name: '虚构纸板', quantity: '10', unit: '张' }],
          warnings: [],
        },
      }),
    },
    app = express();
  app.use(express.json());
  app.use(
    '/api/ai/imports',
    importRouter(
      f.manager,
      () => ({ id: 'test-actor', name: '验收', permissions: ['business:edit'] }),
      fakeReceiptAi as any,
    ),
  );
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(500).json({ message: err.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    f.manager.setMode(f.w.id, { expectedRevision: f.w.revision, mode: 'arrival' });
    const r = await fetch(base + '/api/ai/imports/' + f.w.id + '/arrival/recognize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ERP-AI-Token': f.manager.csrfToken,
      },
      body: JSON.stringify({ consent: true, stream: false }),
    });
    assert.equal(r.status, 200);
    const data = (await r.json()) as any;
    assert.equal(data.result.reference, 'SH-TEST-01');
    assert.equal(data.result.supplierName, '虚构到货供应商');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});

test('外发授权撤销后，已有草稿仍可重新授权并继续重新识别', async () => {
  const f = await fixture();
  try {
    let w = await recognized(f);
    assert.ok(w.consent);
    w = f.manager.revoke(w.id, { expectedRevision: w.revision });
    assert.equal(w.consent, null);
    w = f.manager.consent(w.id, consentData(f, w.revision));
    assert.ok(w.consent);
    const again = await f.manager.analyze(w.id, {
      expectedRevision: w.revision,
      force: true,
      stream: false,
    });
    assert.ok(again.draft);
  } finally {
    f.close();
  }
});

test('精确十进制金额保留单价精度、合计数量与金额不混淆，不暗加13%税', () => {
  assert.equal(multiplyExact('1000', '1.39'), '1390.00');
  assert.equal(multiplyExact('2000', '0.73'), '1460.00');
  assert.equal(multiplyExact('500', '0.1234'), '61.7000');
  assert.equal(multiplyExact('1,000', '1.39'), null);
  const d = asDraft();
  let e = evaluateDraft(d);
  assert.equal(e.totalAmount, '2850.00');
  assert.equal(e.totalQuantity, '3000');
  d.header.statedTotalAmount.value = '3000';
  assert.ok(evaluateDraft(d).issues.some((i) => i.path === 'header.statedTotalAmount'));
  d.lines[1].fields.unitPrice.value = '0.7312';
  e = evaluateDraft(d);
  assert.equal(e.lineAmounts[d.lines[1].id], '1462.4000');
  assert.ok(!e.issues.some((i) => i.path.endsWith('unitPrice') && i.message.includes('无法')));
  d.header.buyerName.value = '宁波甬勒包装制品有限公司';
  assert.ok(evaluateDraft(d).issues.some((i) => i.path === 'header.buyerName'));
});

test('Excel/DOCX 真实容器解析、来源定位与公式缓存，原始单价1.2345不丢失', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-parse-office-'));
  try {
    for (const [name, buffer] of [
      ['虚构.xlsx', xlsxFixture()],
      ['虚构.docx', docxFixture()],
    ] as const) {
      const result = await parseUpload(buffer, name, randomUUID(), join(dir, name));
      assert.ok(result.blocks.some((b) => b.text.includes('虚构验收客户')));
      assert.ok(result.blocks.some((b) => b.text.includes('2850.00')));
      if (name.endsWith('xlsx')) {
        assert.ok(result.blocks.some((b) => b.text.includes('1.2345')));
        assert.ok(result.blocks.every((b) => b.ref.kind === 'excel'));
        assert.ok(result.warnings.some((w) => w.includes('公式')));
      } else assert.ok(result.blocks.every((b) => b.ref.kind === 'document'));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文字PDF、扫描PDF、PNG/JPEG真实解析并保留高细节视觉来源，不依赖OCR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-parse-media-'));
  try {
    const cases: [string, Buffer][] = [
      ['text.pdf', await pdfFixture()],
      ['scan.pdf', await pdfFixture(true)],
      ['image.png', imageFixture()],
      ['image.jpeg', imageFixture(true)],
    ];
    for (const [name, buffer] of cases) {
      const p = await parseUpload(buffer, name, randomUUID(), join(dir, name));
      assert.equal(p.previews.length, 1);
      assert.ok(p.blocks.length);
      if (name === 'text.pdf')
        assert.ok(p.blocks.some((b) => b.method === 'pdf-text' && b.text.includes('2850')));
      assert.ok(p.blocks.some((b) => b.method === 'vision-required'));
      assert.deepEqual(p.imagePages, [1]);
      assert.ok(!p.blocks.some((b) => b.method === 'windows-ocr'));
      for (const b of p.blocks) assert.ok(sourceReferenceSchema.safeParse(b.ref).success);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('传统 DOC 使用真实 OLE 测试文件，无需 Office；假DOC与类型伪装被拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-parse-doc-'));
  try {
    const p = await parseUpload(
      readFileSync(new URL('./fixtures/import/word-extractor-test01.doc', import.meta.url)),
      'test.doc',
      randomUUID(),
      join(dir, 'doc'),
    );
    assert.ok(p.blocks.some((b) => b.method === 'doc-binary' && b.text.length > 5));
    assert.throws(() => detectFormat(Buffer.from('fake'), 'test.doc'));
    assert.throws(() => detectFormat(Buffer.from('<html>'), 'test.pdf'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('拒绝宏、XML实体、错配Office格式、超大文件与PDF脚本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-malicious-'));
  try {
    assert.throws(() => detectFormat(Buffer.alloc(10 * 1024 * 1024 + 1), 'a.png'));
    const bad = [
      [
        'macro.xlsx',
        zipFixture({ '[Content_Types].xml': '<Types/>', 'xl/vbaProject.bin': 'macro' }),
      ],
      [
        'entity.docx',
        zipFixture({
          '[Content_Types].xml': '<Types/>',
          'word/document.xml': '<!DOCTYPE x [<!ENTITY x "evil">]><w:document/>',
        }),
      ],
      ['wrong.xlsx', docxFixture()],
      ['script.pdf', Buffer.from('%PDF-1.7\n/JavaScript')],
    ] as const;
    let n = 0;
    for (const [name, bytes] of bad)
      await assert.rejects(parseUpload(bytes, name, randomUUID(), join(dir, String(n++))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未授权不调用AI，重复上传恢复原件；原文和AI设置不包含正式ERP业务记录', async () => {
  const f = await fixture();
  try {
    assert.equal(f.calls.length, 0);
    await assert.rejects(
      f.manager.analyze(f.w.id, { expectedRevision: 0 }),
      (e: any) => e.code === 'consent',
    );
    assert.equal(f.calls.length, 0);
    assert.equal((await f.manager.upload(xlsxFixture(), '另一个名字.xlsx')).duplicate, true);
    const w = await recognized(f);
    assert.equal(w.evaluation?.totalAmount, '2850.00');
    assert.ok(!JSON.stringify(w).includes(key));
    const req = f.calls[0];
    assert.equal(req.url.pathname, '/v1/responses');
    assert.ok(!JSON.stringify(req.body).includes(key));
    assert.ok(!JSON.stringify(req.body).includes('customers().'));
    assert.equal(f.manager.status().writesEnabled, false);
  } finally {
    f.close();
  }
});

test('聊天受控修改同步表格与合计、差异可见、撤销可恢复；确认不写ERP且编辑使其失效', async () => {
  const f = await fixture();
  try {
    let w = await recognized(f);
    const second = w.draft!.lines[1].id;
    f.setReply({
      reply: '第二项数量已修改为500，原文金额保留以供核对。',
      operations: [
        {
          op: 'set-line',
          lineId: second,
          field: 'quantity',
          value: '500',
          reason: '用户要求第二项500',
        },
      ],
      questions: [],
    });
    w = await f.manager.chat(w.id, {
      expectedRevision: w.revision,
      message: '第二个产品的数量改成500。',
    });
    assert.equal(w.draft!.lines[1].fields.quantity.value, '500');
    assert.equal(w.evaluation!.totalAmount, '1755.00');
    assert.ok(w.messages.at(-1)!.text.includes('后端已重算'));
    assert.ok(w.messages.at(-1)!.text.includes('1755.00'));
    assert.equal(w.changes[0].before, '2000');
    assert.equal(w.changes[0].after, '500');
    assert.ok(w.canUndo);
    w = f.manager.undo(w.id, { expectedRevision: w.revision });
    assert.equal(w.evaluation!.totalAmount, '2850.00');
    w = f.manager.confirm(w.id, { expectedRevision: w.revision, acknowledged: true });
    assert.equal(w.confirmedRevision, w.revision);
    w = f.manager.edit(w.id, {
      expectedRevision: w.revision,
      operations: [{ op: 'set-header', field: 'notes', value: '核对备注', reason: '测试' }],
    });
    assert.equal(w.confirmedRevision, null);
    assert.throws(() => f.manager.confirm(w.id, { expectedRevision: 0, acknowledged: true }));
  } finally {
    f.close();
  }
});

test('原件直读不依赖来源编号，SQL操作、未知行和一边提问一边修改仍被拒绝', async () => {
  const f = await fixture();
  try {
    let a = analysis();
    a.header.buyerName.sources = ['fake-source'];
    f.setReply(a);
    const granted = f.manager.consent(f.w.id, consentData(f, 0));
    const w = await f.manager.analyze(f.w.id, { expectedRevision: granted.revision });
    assert.deepEqual(w.draft!.header.buyerName.sources, []);
    for (const response of [
      { reply: '执行SQL', operations: [{ op: 'sql', sql: 'DROP TABLE orders' }], questions: [] },
      {
        reply: '改未知行',
        operations: [
          { op: 'set-line', lineId: randomUUID(), field: 'quantity', value: '3', reason: 'test' },
        ],
        questions: [],
      },
      {
        reply: '不确定',
        operations: [{ op: 'set-header', field: 'notes', value: '猜测', reason: 'test' }],
        questions: ['哪一行？'],
      },
    ]) {
      f.setReply(response);
      await assert.rejects(
        f.manager.chat(w.id, { expectedRevision: w.revision, message: '检查一下' }),
      );
      assert.deepEqual(f.manager.get(w.id).draft, w.draft);
    }
  } finally {
    f.close();
  }
});

test('切换AI或撤销授权后不外发；原件篡改拦截；工作区独立持久恢复', async () => {
  const f = await fixture();
  try {
    let w = await recognized(f);
    w = f.manager.revoke(w.id, { expectedRevision: w.revision });
    await assert.rejects(
      f.manager.chat(w.id, { expectedRevision: w.revision, message: '交期？' }),
      (e: any) => e.code === 'consent',
    );
    w = f.manager.consent(w.id, consentData(f, w.revision));
    writeFileSync(join(f.directory, w.id, 'original'), 'modified');
    await assert.rejects(
      f.manager.chat(w.id, { expectedRevision: w.revision, message: '交期？' }),
      (e: any) => e.code === 'source',
    );
    const reopened = new ImportManager({ directory: f.directory, settings: f.settings });
    assert.equal(reopened.get(w.id).draft!.lines.length, 2);
    reopened.close();
    f.settings.disable({ expectedRevision: f.settings.view().revision });
    await assert.rejects(
      f.manager.chat(w.id, { expectedRevision: w.revision, message: '交期？' }),
      (e: any) => e.code === 'consent',
    );
  } finally {
    f.close();
  }
});

test('真实Chat Completions输出校验：截断、非JSON、密钥回显和400图像失败不伪造成功', async () => {
  const p = {
    provider: 'compatible' as const,
    endpoint: 'https://api.example.com/v1',
    model: 'unit-model',
    apiStyle: 'chat-completions' as const,
  };
  for (const body of [
    { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ key }) } }] },
  ])
    await assert.rejects(
      completeCompatible(p, key, [{ role: 'user', content: '虚构' }], async () => ({
        status: 200,
        body,
      })),
    );
  await assert.rejects(
    completeCompatible(p, key, [{ role: 'user', content: [] }], async () => ({
      status: 400,
      body: { error: { message: key } },
    })),
    (e: any) => !e.message.includes(key),
  );
});

test('兼容API优先要求JSON输出，仅明确不支持response_format时降级，认证失败不重试', async () => {
  const profile = {
    provider: 'compatible' as const,
    endpoint: 'https://api.example.com/v1',
    model: 'unit-model',
    apiStyle: 'chat-completions' as const,
  };
  const success = {
    status: 200,
    body: {
      choices: [
        {
          finish_reason: 'stop',
          message: { content: '{"reply":"核对成功","operations":[],"questions":[]}' },
        },
      ],
    },
  };
  const requests: any[] = [];
  const result = await completeCompatible(
    profile,
    key,
    [{ role: 'user', content: 'JSON核对' }],
    async (request) => {
      requests.push(request);
      return requests.length === 1
        ? { status: 400, body: { error: { message: 'unsupported response_format' } } }
        : success;
    },
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body.response_format, { type: 'json_object' });
  assert.equal(requests[1].body.response_format, undefined);
  assert.deepEqual(result, { reply: '核对成功', operations: [], questions: [] });
  let calls = 0;
  await assert.rejects(
    completeCompatible(profile, key, [{ role: 'user', content: '核对' }], async () => {
      calls++;
      return { status: 401, body: { error: { message: 'unsupported response_format' } } };
    }),
  );
  assert.equal(calls, 1);
});

test('上传/编辑/聊天/确认API要求CSRF，正式执行403；全流程不修改业务表', async () => {
  const f = await fixture(),
    store = new Store(':memory:');
  store.saveCustomer({ name: '保留的ERP虚构客户', contact: '', phone: '', address: '', notes: '' });
  const before = JSON.stringify(store.customers());
  const server = createApp(store, { aiSettings: f.settings, imports: f.manager }).listen(
    0,
    '127.0.0.1',
  );
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/ai/imports`;
  const post = (path: string, body: unknown, token = f.settings.csrfToken) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-AI-Token': token },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post('/' + f.w.id + '/consent', consentData(f, 0), '')).status, 403);
    assert.equal((await fetch(base, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const upload = await fetch(base + '/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-ERP-AI-Token': f.settings.csrfToken,
        'X-File-Name': encodeURIComponent('重复.xlsx'),
      },
      body: new Uint8Array(xlsxFixture()),
    });
    assert.equal(upload.status, 201);
    assert.equal((await upload.json()).duplicate, true);
    const grant = await (await post('/' + f.w.id + '/consent', consentData(f, 0))).json();
    const analyzed = await (
      await post('/' + f.w.id + '/analyze', { expectedRevision: grant.revision })
    ).json();
    assert.equal(analyzed.draft.lines.length, 2);
    assert.equal(
      (
        await post('/' + f.w.id + '/execute', {
          expectedRevision: analyzed.revision,
          source: 'manual-ui',
        })
      ).status,
      403,
    );
    assert.equal(JSON.stringify(store.customers()), before);
    assert.equal(store.products().length, 0);
    assert.equal(store.orders().length, 0);
    assert.ok(!JSON.stringify(f.calls[0].body).includes('保留的ERP虚构客户'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    f.close();
  }
});

test('授权绑定用户看到的准确API目标；数量/日期非法修改不保存', async () => {
  const f = await fixture();
  try {
    assert.throws(
      () =>
        f.manager.consent(f.w.id, {
          ...consentData(f, 0),
          endpoint: 'https://different.example.com/v1',
        }),
      (e: any) => e.code === 'consent',
    );
    assert.equal(f.calls.length, 0);
    const w = await recognized(f);
    for (const op of [
      {
        op: 'set-line',
        lineId: w.draft!.lines[0].id,
        field: 'quantity',
        value: '-10',
        reason: '非法数量',
      },
      { op: 'set-header', field: 'deliveryDate', value: '9月4号', reason: '未知年份' },
    ])
      assert.throws(() => f.manager.edit(w.id, { expectedRevision: w.revision, operations: [op] }));
    assert.deepEqual(f.manager.get(w.id).draft, w.draft);
  } finally {
    f.close();
  }
});

test('图像接口不受支持时明确报错，不伪造识别或返回密钥', async () => {
  await assert.rejects(
    completeCompatible(
      { provider: 'compatible', endpoint: 'https://api.example.com/v1', model: 'unit-model' },
      key,
      [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,fake' } }],
        },
      ],
      async () => ({ status: 400, body: { error: { message: key } } }),
    ),
    (e: any) => e.code === 'model' && e.message.includes('图像') && !e.message.includes(key),
  );
});

test('传统DOC的FibBase加密标记在提取正文前被拒绝', async () => {
  const original = readFileSync(
    new URL('./fixtures/import/word-extractor-test01.doc', import.meta.url),
  );
  const modified = Buffer.from(original);
  const position = modified.indexOf(Buffer.from('eca5', 'hex'));
  assert.ok(position >= 0);
  modified[position + 11] |= 1;
  const dir = mkdtempSync(join(tmpdir(), 'erp-encrypted-doc-'));
  try {
    await assert.rejects(
      parseUpload(modified, 'encrypted.doc', randomUUID(), join(dir, 'doc')),
      (e: any) => e.message.includes('加密'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI请求期间另一页面保存草稿时，旧AI结果不得覆盖新修订', async () => {
  const f = await fixture();
  try {
    const w = await recognized(f),
      lineId = w.draft!.lines[1].id;
    f.setReply({
      reply: '数量改500',
      operations: [{ op: 'set-line', lineId, field: 'quantity', value: '500', reason: '聊天修改' }],
      questions: [],
    });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    const original = f.settings.completeOrderJson.bind(f.settings);
    f.settings.completeOrderJson = async (
      ...args: Parameters<AiSettingsManager['completeOrderJson']>
    ) => {
      entered();
      await gate;
      return original(...args);
    };
    const pending = f.manager.chat(w.id, {
      expectedRevision: w.revision,
      message: '第二项数量改成500',
    });
    await started;
    const manual = f.manager.edit(w.id, {
      expectedRevision: w.revision,
      operations: [
        { op: 'set-line', lineId, field: 'quantity', value: '2500', reason: '另一页面的新修改' },
      ],
    });
    release();
    await assert.rejects(pending, (e: any) => e.code === 'stale');
    assert.equal(f.manager.get(w.id).draft!.lines[1].fields.quantity.value, '2500');
    assert.equal(f.manager.get(w.id).revision, manual.revision);
  } finally {
    f.close();
  }
});

test('多文件草稿隔离：删除A后B不变，重开不复活，回收站可恢复A', async () => {
  const f = await fixture();
  try {
    const a = await recognized(f);
    let b = (
      await f.manager.upload(
        Buffer.concat([xlsxFixture(), Buffer.from('another-file')]),
        '另一个订单.xlsx',
      )
    ).workspace;
    b = f.manager.consent(b.id, consentData(f, b.revision));
    b = await f.manager.analyze(b.id, { expectedRevision: b.revision });
    const before = JSON.stringify(f.manager.get(b.id));
    await f.manager.remove(a.id, { expectedRevision: a.revision, acknowledged: true });
    assert.throws(() => f.manager.get(a.id));
    assert.equal(JSON.stringify(f.manager.get(b.id)), before);
    assert.equal(f.manager.status().workspaces.length, 1);
    const reopened = new ImportManager({ directory: f.directory, settings: f.settings });
    assert.equal(reopened.status().workspaces.length, 1);
    assert.equal(reopened.status().trash.length, 1);
    reopened.close();
    const restored = await f.manager.restore(a.id);
    assert.equal(restored.draft!.lines.length, 2);
    assert.equal(f.manager.status().workspaces.length, 2);
  } finally {
    f.close();
  }
});

test('删除正在识别文件时取消请求；即使供应商迟到返回也不能写回已删除草稿', async () => {
  const f = await fixture();
  try {
    const w = f.manager.consent(f.w.id, consentData(f, 0));
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r)),
      original = f.settings.completeOrderJson.bind(f.settings);
    f.settings.completeOrderJson = async (...args) => {
      entered();
      await gate;
      return original(...args);
    };
    const pending = f.manager.analyze(w.id, { expectedRevision: w.revision });
    await started;
    await f.manager.remove(w.id, { expectedRevision: w.revision, acknowledged: true });
    release();
    await assert.rejects(pending);
    assert.equal(f.manager.status().workspaces.length, 0);
    const restored = await f.manager.restore(w.id);
    assert.equal(restored.draft, null);
  } finally {
    f.close();
  }
});

test('取消当前识别保留原件，可重试，其他文件不受影响', async () => {
  const f = await fixture();
  try {
    const w = f.manager.consent(f.w.id, consentData(f, 0));
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r)),
      original = f.settings.completeOrderJson.bind(f.settings);
    f.settings.completeOrderJson = async (...args) => {
      entered();
      await gate;
      return original(...args);
    };
    const task = f.manager.analyze(w.id, { expectedRevision: w.revision });
    await started;
    const cancelled = f.manager.cancel(w.id, { expectedRevision: w.revision });
    release();
    await assert.rejects(task);
    assert.equal(f.manager.get(w.id).draft, null);
    assert.equal(f.manager.get(w.id).task?.state, 'cancelled');
    f.settings.completeOrderJson = original;
    const retried = await f.manager.analyze(w.id, { expectedRevision: cancelled.revision });
    assert.equal(retried.draft!.lines.length, 2);
  } finally {
    f.close();
  }
});

test('客户产品关联计划仅保存在草稿，修改后确认及关联失效，拒绝跨文件明细ID', async () => {
  const f = await fixture();
  try {
    let w = await recognized(f);
    const mapping = {
      customer: { mode: 'new' },
      products: Object.fromEntries(w.draft!.lines.map((l) => [l.id, { mode: 'new' }])),
      roundingPolicy: 'exact-cents',
    };
    w = f.manager.mapping(w.id, { expectedRevision: w.revision, mapping });
    assert.equal(w.mapping?.customer.mode, 'new');
    w = f.manager.confirm(w.id, { expectedRevision: w.revision, acknowledged: true });
    const changed = f.manager.edit(w.id, {
      expectedRevision: w.revision,
      operations: [
        {
          op: 'set-line',
          lineId: w.draft!.lines[0].id,
          field: 'quantity',
          value: '1200',
          reason: '人工修改',
        },
      ],
    });
    assert.equal(changed.confirmedRevision, null);
    assert.equal(changed.mapping, undefined);
    assert.throws(() =>
      f.manager.mapping(w.id, {
        expectedRevision: changed.revision,
        mapping: { ...mapping, products: { [randomUUID()]: { mode: 'new' } } },
      }),
    );
  } finally {
    f.close();
  }
});

test('真实XLS二进制解析保留工作表、行列、显示格式和四位单价，不把2900当金额', async () => {
  const XLSX = await import('xlsx'),
    dir = mkdtempSync(join(tmpdir(), 'erp-xls-biff-'));
  try {
    const ws = XLSX.utils.aoa_to_sheet([
      ['虚构客户', '数量', '单价', '金额'],
      ['ES001', 1400, 1.3, 1820],
      ['ES002', 100, 8.78, 878],
      ['ES003', 1400, 0.17, 238],
      ['合计', 2900, '', 2936],
    ]);
    ws.C2.z = ws.C3.z = ws.C4.z = '0.0000';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '虚构订单');
    const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' });
    const result = await parseUpload(bytes, '真实格式虚构订单.xls', randomUUID(), join(dir, 'xls'));
    assert.equal(result.format, 'xls');
    assert.ok(result.blocks.some((b) => b.text.includes('1.3000')));
    assert.ok(result.blocks.some((b) => b.text.includes('2936')));
    assert.ok(result.blocks.every((b) => b.ref.kind === 'excel' && b.method === 'xls-binary'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('视觉消息包含原图data URL和high细节，不发送127.0.0.1地址或错误OCR文本', async () => {
  const f = await fixture(),
    dir = join(f.directory, 'visual');
  const manager = new ImportManager({ directory: dir, settings: f.settings });
  try {
    const bytes = imageFixture();
    let w = (await manager.upload(bytes, '原图.png')).workspace;
    w = manager.consent(w.id, consentData(f, w.revision));
    await manager.analyze(w.id, { expectedRevision: w.revision });
    const req = f.calls.at(-1),
      parts = req.body.input.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])),
      image = parts.find((x: any) => x.type === 'input_image');
    assert.equal(image.detail, 'high');
    assert.equal(image.image_url, 'data:image/png;base64,' + bytes.toString('base64'));
    assert.ok(!JSON.stringify(req.body).includes('127.0.0.1'));
    assert.ok(!JSON.stringify(req.body).includes('windows-ocr'));
  } finally {
    manager.close();
    f.close();
  }
});

test('提示词独立版本化、包含角色、行业字段、精度规则与只修改当前订单限制', async () => {
  const p = await import('../server/import/prompts.js');
  assert.ok(p.PROMPT_VERSION);
  assert.match(p.analysisPrompt(), /甲方/);
  assert.match(p.analysisPrompt(), /unitPriceExact/);
  assert.match(p.analysisPrompt(), /productCode/);
  assert.match(p.chatPrompt(), /当前明确选中/);
  assert.match(p.chatPrompt(), /operations/);
});

test('档案候选不等于自动关联；标准草稿使用正式字段名，不能编造内部ID', async () => {
  const f = await fixture(),
    store = new Store(':memory:');
  try {
    let w = await recognized(f);
    const customer = store.saveCustomer({
      name: '宁波虚构客户有限公司',
      contact: '',
      phone: '',
      address: '',
      notes: '',
    });
    const { matchDraft } = await import('../server/import/matching.js'),
      { standardOrderDraft } = await import('../server/import/standard-order.js');
    const before = JSON.stringify(store.customers()),
      matches = matchDraft(store, w);
    assert.ok(matches.customerCandidates.some((c) => c.id === customer.id));
    assert.equal(w.mapping, undefined);
    const candidate = standardOrderDraft(store, w)!;
    assert.equal(candidate.fields.customerId, null);
    assert.equal(candidate.fields.externalPurchaseOrder, 'TEST-01');
    assert.equal(candidate.fields.lines[0].unitPriceExact, '1.39');
    assert.equal(candidate.fields.taxRate, '13');
    assert.equal(candidate.validatedInput, null);
    assert.equal(candidate.writesEnabled, false);
    assert.equal(JSON.stringify(store.customers()), before);
  } finally {
    store.close();
    f.close();
  }
});

test('工作区文件移动后突然中断，重启能修复活动文件引用', async () => {
  const f = await fixture();
  try {
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(f.directory, '_trash'), { recursive: true });
    await fs.rename(join(f.directory, f.w.id), join(f.directory, '_trash', f.w.id));
    const reopened = new ImportManager({ directory: f.directory, settings: f.settings });
    const original = await reopened.file(f.w.id);
    assert.ok(original.bytes.length);
    assert.equal(reopened.status().trash.length, 0);
    reopened.close();
  } finally {
    f.close();
  }
});
