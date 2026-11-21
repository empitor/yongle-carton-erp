// 供应商送货单识别（server/import/receipt-ai.ts、到货识别的接口）：原件怎么发给模型、结果怎么存、怎么变成待核对的到货单。
// 假模型、内存库、临时目录、虚构数据。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/core/db.js';
import { count, one, rows } from '../server/core/index.js';
import { ReceiptAi } from '../server/import/receipt-ai.js';
import { supplierDefaultPreset } from '../server/import/default-prompts/supplier-delivery.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { defaultPromptPreset } from '../server/import/default-prompts/sales-order.js';
import { testImports } from './order-import-fixture.js';
import { promptTable } from './assistant-fixture.js';
import { ImportExecutionService } from '../server/import/import-execution.js';
import { FlowService } from '../server/flow/service.js';
import { OperationsService } from '../server/operations/index.js';
import { recognizedArrivalDraft, arrivalTotals } from '../shared/business/arrival-draft.js';
import { SseParser } from '../shared/core/sse.js';
import { receiptResultSchema } from '../shared/import/index.js';
import { z } from 'zod';
import { contentParts, fakeAiSettings, fakeKey, replyCutOff, replyFinish, type FakeChat } from './fake-deepseek.js';
import { imageFixture, docxFixture, xlsxFixture, pdfFixture } from './import-fixtures.js';
import { startHttp } from './http-fixture.js';

const actor = pageActor({
    id: 'fictional-ai-receiver',
    name: '送货验收（虚构）',
    permissions: ['business:edit'],
  }),
  secret = fakeKey;
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
const recognizedSource = z.looseObject({ id: z.string(), result: receiptResultSchema });
const sourceView = recognizedSource.extend({ fileName: z.string() });
const uploadedWorkspace = z.looseObject({ workspace: z.looseObject({ id: z.string(), mode: z.string() }) });
const promptState = z.looseObject({ presets: z.array(z.looseObject({ name: z.string() })) });

function streamedSource(text: string) {
  const results: unknown[] = [];
  new SseParser((e) => {
    if (e.event === 'result') results.push(JSON.parse(e.data));
  }).push(text);
  return recognizedSource.parse(results.at(-1));
}

function fixture(chat: FakeChat) {
  const store = new Store(':memory:'),
    prompts = new PromptPresetManager(':memory:', supplierDefaultPreset),
    { settings, fake } = fakeAiSettings({ chat });
  const ai = new ReceiptAi(store, settings, prompts);
  return {
    store,
    ai,
    prompts,
    settings,
    fake,
    input: () => ({}),
    close() {
      store.close();
      prompts.close();
      settings.close();
    },
  };
}

test('供应商图片发原图、DOCX/XLSX/PDF原样上传后按文件编号引用、用完删除，启用自定义提示词，仅完整结果落草稿且不改库存', async () => {
  const f = fixture(() => analysis());
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
      ['送货.jpg', imageFixture(true)],
      ['送货.docx', docxFixture()],
      ['送货.xlsx', xlsxFixture()],
      ['送货.pdf', await pdfFixture()],
    ];
    for (const [fileName, bytes] of files) {
        const unique = bytes,
          source = f.ai.upload(unique, fileName, actor);
        let progress = 0;
        const result = await f.ai.analyze(
          String(source.id),
          f.input(),
          actor,
          () => progress++,
        );
        assert.equal(result.result?.lines[0].quantity, '100');
        assert.equal(f.store.orders().length, 0);
        assert.equal(new OperationsService(f.store).items().length, 0);
        assert.equal(count(f.store.db, 'SELECT COUNT(*) FROM stock_movements'), 0);
        const req = f.fake.chatCalls().at(-1);
        assert.ok(req);
        assert.equal(req.url.href, 'https://api.deepseek.com/chat/completions');
        assert.equal(req.headers.get('authorization'), 'Bearer ' + secret);
        assert.equal(req.body.stream, true);
        assert.match(JSON.stringify(req.body), /FICTIONAL_SUPPLIER_RULE/);
        const parts = contentParts(req.body.messages[1]);
        if (fileName.endsWith('.jpg')) {
          const image = z.object({ image_url: z.object({ url: z.string() }) }).parse(parts.find((p) => p.type === 'image_url'));
          assert.deepEqual(Buffer.from(image.image_url.url.split(',')[1], 'base64'), unique);
          assert(!f.fake.calls.some((c) => c.path === '/files'), '图片不上传');
        } else {
          const upload = f.fake.calls.findLast((c) => c.path === '/files' && c.method === 'POST');
          assert.ok(upload);
          assert.equal(upload.body.purpose, fileName.endsWith('.xlsx') ? 'user_data' : 'rich_layout_recognition');
          assert.deepEqual(upload.body.file?.bytes, unique);
          assert.equal(upload.body['expires_after[seconds]'], '3600');
          assert(parts.some((p) => p.type === 'file' && typeof p.file_id === 'string' && /^file-api-fake-/.test(p.file_id)));
          assert.match(String(parts[0].text), /原文件《送货/);
          assert(!JSON.stringify(parts).includes(unique.toString('base64')), '对话里不带文件内容');
          assert.equal(f.fake.files.size, 0, '用完就删');
        }
        assert(!JSON.stringify(source).includes(secret));
        assert(progress > 0);
      }
    const audit = JSON.stringify(f.store.db.prepare('SELECT * FROM business_audit').all());
    assert(!audit.includes(secret));
    assert(!audit.includes('FICTIONAL_SUPPLIER_RULE'));
    assert(!audit.includes('K=A'));
  } finally {
    f.close();
  }
});

test('格式不对、模型回的不对、流中断都拒绝，不留结果；同一文件不重复存，原件被改了拒绝识别', async () => {
  let fail = false;
  const f = fixture(() => (fail ? { lines: [] } : analysis()));
  try {
    assert.throws(() => f.ai.upload(Buffer.from('text'), 'fake.pdf', actor), /格式不支持|文件头/);
    const bytes = docxFixture(),
      s = f.ai.upload(bytes, '真实类型.docx', actor);
    assert.equal(f.ai.upload(bytes, '第二次.docx', actor).id, s.id);
    fail = true;
    await assert.rejects(() => f.ai.analyze(String(s.id), f.input(), actor));
    assert.equal(f.ai.sources()[0].result, null);
    fail = false;
    const source = one(f.store.db, rows.flow_sources.pick({ bytes: true }), 'SELECT bytes FROM flow_sources WHERE id=?', s.id);
    assert.ok(source);
    assert.deepEqual(Buffer.from(source.bytes), bytes);
    f.store.db
      .prepare('UPDATE flow_sources SET bytes=? WHERE id=?')
      .run(Buffer.from('tampered'), s.id);
    await assert.rejects(() => f.ai.analyze(String(s.id), f.input(), actor), /完整性/);
  } finally {
    f.close();
  }
  const g = fixture(() => replyCutOff('{"supplierName":'));
  try {
    const s = g.ai.upload(docxFixture(), '中断.docx', actor);
    await assert.rejects(() => g.ai.analyze(String(s.id), g.input(), actor));
    assert.equal(g.ai.sources()[0].result, null);
  } finally {
    g.close();
  }
});

test('同一份识别原件只能入库一次，预览绑定原件哈希', async () => {
  const f = fixture(() => analysis());
  try {
    const source = f.ai.upload(docxFixture(), '有来源.docx', actor);
    await f.ai.analyze(String(source.id), f.input(), actor);
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
      p = flow.preview(first.id, actor);
    assert.equal(p.sourceHash, createHash('sha256').update(docxFixture()).digest('hex'));
    flow.confirm(
      first.id,
      { previewDigest: p.previewDigest, requestId: randomUUID(), acknowledged: true },
      actor,
    );
    const duplicate = flow.save('arrival', { ...input, reference: 'changed-reference' }, actor),
      p2 = flow.preview(duplicate.id, actor);
    assert.throws(
      () =>
        flow.confirm(
          duplicate.id,
          { previewDigest: p2.previewDigest, requestId: randomUUID(), acknowledged: true },
          actor,
        ),
      /已经确认入库/,
    );
    assert.equal(ops.items()[0].quantity, '100');
  } finally {
    f.close();
  }
});

test('识别结果变成到货单草稿：不猜日期、单位和计价方式；重新识别沿用原来那张；尺寸换单位面积不变', () => {
  const valid = analysis();
  const result = { ...valid, date: null, lines: [{ ...valid.lines[0], dimensionUnit: '未知', unit: '件', priceBasis: null }] };
  const r = recognizedArrivalDraft({ id: randomUUID(), result }, [], { id: 8, version: 2, status: 'draft' });
  assert.deepEqual([r.draft.id, r.draft.version, r.draft.date, r.draft.lines[0].quantity], [8, 2, '', '']);
  assert.equal(r.draft.lines[0].item.dimensionUnit, null);
  assert.equal(r.draft.lines[0].priceBasis, null);
  assert(r.warnings.some((w) => w.includes('不会自动使用今天')));
  const normal = recognizedArrivalDraft({ id: randomUUID(), result: analysis() }, []).draft;
  assert.equal(arrivalTotals(normal.lines).area, '80');
});

/** 起服务：到货识别走 AI 导入的工作区（到货类型）；chat 换成坏回复用 broken(true) */
async function served() {
  let broken = false;
  const f = fixture(() => (broken ? replyFinish('length', JSON.stringify(analysis()).slice(0, 20)) : analysis())),
    dir = mkdtempSync(join(tmpdir(), 'erp-receipt-http-')),
    imports = testImports({ directory: join(dir, 'imports'), archiveDirectory: join(dir, 'archive'), settings: f.settings, store: f.store, receiptAi: f.ai }),
    h = await startHttp(f.store, { aiSettings: f.settings, receiptAi: f.ai, imports, promptModules: promptTable({ 'sales-order': imports.promptPresets, 'supplier-delivery': f.ai.prompts }) });
  const headers = (login = true) => ({
    'Content-Type': 'application/json',
    'X-ERP-Auth-Token': h.auth.csrf,
    'X-ERP-AI-Token': imports.csrfToken,
    ...(login ? { Cookie: h.cookie } : {}),
  });
  const post = (path: string, body: unknown, login = true) =>
    fetch(h.origin + path, { method: 'POST', headers: headers(login), body: JSON.stringify(body) });
  const get = (path: string) => fetch(h.origin + path, { headers: { Cookie: h.cookie } });
  /** 按到货识别，流式；返回整段回传 */
  const recognize = async (id: string) => (await post('/api/ai/imports/' + id + '/arrival/recognize', { consent: true, stream: true })).text();
  return {
    ...f, dir, imports, h, post, get, recognize,
    broken: (v: boolean) => (broken = v),
    async close() {
      await h.close();
      imports.close();
      f.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('送货单走 AI 导入的到货类型：上传、识别、读识别记录和原件都联通，凭据不进浏览器；订单类型的工作区先换成到货才识别，结果存在工作区里，重开还在；识别坏了不留结果', async () => {
  const f = await served();
  try {
    const bytes = docxFixture();
    const upload = await fetch(f.h.origin + '/api/ai/imports/upload', {
      method: 'POST',
      headers: { Cookie: f.h.cookie, 'X-ERP-Auth-Token': f.h.auth.csrf, 'X-ERP-AI-Token': f.imports.csrfToken, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('真实直传.docx'), 'X-Import-Mode': 'arrival' },
      body: new Uint8Array(bytes),
    });
    assert.equal(upload.status, 201);
    const { workspace } = uploadedWorkspace.parse(await upload.json());
    assert.equal(workspace.mode, 'arrival', '页面说明了按到货单识别');
    const response = await f.post('/api/ai/imports/' + workspace.id + '/arrival/recognize', { stream: false });
    assert.equal(response.status, 200);
    const rawRecognized: unknown = await response.json();
    const recognized = recognizedSource.parse(rawRecognized);
    assert.equal(recognized.result.supplierName, '虚构送货纸板厂');
    assert(!JSON.stringify(rawRecognized).includes(secret));
    const source = sourceView.parse(await (await f.get('/api/flow/sources/' + recognized.id)).json());
    assert.deepEqual([source.fileName, source.result.lines[0].quantity], ['真实直传.docx', '100']);
    assert.deepEqual(Buffer.from(await (await f.get('/api/flow/sources/' + recognized.id + '/file')).arrayBuffer()), bytes);
    const state = promptState.parse(await (await f.get('/api/ai/prompt-modules/supplier-delivery')).json());
    assert.equal(state.presets[0].name, '供应商送货单识别 · 默认');
    assert(!JSON.stringify(state).includes(secret));
    // 订单类型的工作区：先换成到货再识别；流式回完整结果，挂到工作区上
    let w = (await f.imports.upload(imageFixture(), '到货.png')).workspace;
    assert.equal((await f.post('/api/ai/imports/' + w.id + '/arrival/recognize', { consent: true, stream: false })).status, 409);
    w = f.imports.setMode(w.id, { mode: 'arrival', expectedRevision: w.revision });
    const streamed = streamedSource(await f.recognize(w.id));
    assert(streamed.result);
    assert.deepEqual([f.imports.get(w.id).arrivalSourceId, f.imports.get(w.id).draft], [streamed.id, null]);
    const restarted = testImports({ directory: join(f.dir, 'imports'), settings: f.settings, store: f.store, receiptAi: f.ai, promptPresets: new PromptPresetManager(':memory:', defaultPromptPreset) });
    assert.equal(restarted.get(w.id).arrivalSourceId, streamed.id);
    restarted.close();
    // 模型回的半截：回传错误，不留识别结果
    f.broken(true);
    let bad = (await f.imports.upload(xlsxFixture(), '失败到货.xlsx')).workspace;
    bad = f.imports.setMode(bad.id, { mode: 'arrival', expectedRevision: bad.revision });
    const failed = await f.recognize(bad.id);
    assert.match(failed, /event: error/);
    assert(!failed.includes('event: result'));
    assert.equal(f.imports.failures(bad.id).total, 1);
    assert.deepEqual(f.ai.sources().filter((s) => s.result).map((s) => s.id).sort(), [recognized.id, streamed.id].sort(), '只有成功的两份有结果');
  } finally {
    await f.close();
  }
});

test('识别结果关联到货单：要登录、换别的原件被拒；核对入库后不能再换识别类型，也不能按订单导入；重复核对只入库一次', async () => {
  const f = await served();
  try {
    let w = (await f.imports.upload(imageFixture(), '到货.png')).workspace;
    w = f.imports.setMode(w.id, { mode: 'arrival', expectedRevision: w.revision });
    const source = streamedSource(await f.recognize(w.id));
    const path = '/api/ai/imports/' + w.id;
    const ops = new OperationsService(f.store),
      supplier = ops.saveSupplier({ name: '虚构送货纸板厂' }, actor),
      flow = new FlowService(f.store);
    const doc = flow.save('arrival', { ...recognizedArrivalDraft(source, [supplier]).draft, requestId: randomUUID() }, actor);
    const link = (sourceId: string, login = true) =>
      f.post(path + '/arrival/link', { expectedRevision: f.imports.get(w.id).revision, docId: doc.id, sourceId }, login);
    assert.equal((await link(source.id, false)).status, 401);
    assert.equal((await link(source.id)).status, 200);
    const input = { previewDigest: flow.preview(doc.id, actor).previewDigest, requestId: randomUUID(), acknowledged: true };
    flow.confirm(doc.id, input, actor);
    flow.confirm(doc.id, input, actor);
    assert.equal((await f.post(path + '/mode', { mode: 'order', expectedRevision: f.imports.get(w.id).revision })).status, 409);
    const items = ops.items();
    assert.deepEqual([items.length, items[0].kind, items[0].quantity, ops.movements().length, f.store.orders().length], [1, 'raw', '100', 1, 0]);
    const other = f.ai.upload(docxFixture(), '其他.docx', actor);
    assert.equal((await link(other.id)).status, 409);
    const importer = new ImportExecutionService(f.store, f.imports);
    await assert.rejects(
      () => importer.preview(w.id, { expectedRevision: f.imports.get(w.id).revision }, { ...actor, permissions: ['business:edit', 'import:execute'] }),
      /到货单/,
    );
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await f.close();
  }
});
