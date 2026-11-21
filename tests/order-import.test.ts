// 订单识别：识别、核对修改、上传检查、接口权限（工作区并发、删除、正式导入在 order-import-workspace.test.ts）
import { pageActor } from './actor-fixture.js';
import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { detectFormat } from '../server/import/file-store.js';
import { evaluateDraft } from '../shared/import/draft-evaluation.js';
import { createApp } from '../server/app.js';
import { listen } from './http-fixture.js';
import { importRouter } from '../server/import/router.js';
import express from 'express';
import { Store } from '../server/core/db.js';
import { AppError } from '../server/core/index.js';
import { ReceiptAi } from '../server/import/receipt-ai.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { supplierDefaultPreset } from '../server/import/default-prompts/supplier-delivery.js';
import { errorMessage } from '../shared/core/index.js';
import { orderDraftSchema, receiptResultSchema, type OrderDraft } from '../shared/import/index.js';
import { xlsxFixture } from './import-fixtures.js';
import { fakeKey, messageText } from './fake-deepseek.js';
import { filledForm, asDraft, fixture, recognized, testImports } from './order-import-fixture.js';

test('识别成功后默认阻止覆盖草稿，显式 force 可重新识别一次', async () => {
  const f = await fixture();
  try {
    const w = await recognized(f);
    await assert.rejects(f.manager.analyze(w.id, { expectedRevision: w.revision }), /已有识别结果/);
    const again = await f.manager.analyze(w.id, {
      expectedRevision: w.revision,
      force: true,
      stream: false,
    });
    assert.ok(again.draft);
    assert.ok(again.revision > w.revision, '重新识别覆盖了原识别结果');
  } finally {
    f.close();
  }
});

test('原件没写订单日期：照样出识别结果，停在“订单日期缺失”等人补；拿不准的那栏标待核对、写明原因', async () => {
  const f = await fixture();
  try {
    const raw = filledForm({ orderDate: null, deliveryDate: null });
    raw.lines[0].deliveryDate = '2026-09-10';
    raw.uncertain = [{ line: 1, field: 'quantity', reason: '虚构：数字被盖章挡住' }];
    f.setReply(raw);
    const w = await recognized(f);
    assert.ok(w.draft, '有识别结果');
    assert.equal(w.task?.state, 'ready');
    assert.equal(w.draft.header.orderDate.value, null);
    assert.equal(w.draft.lines[0].fields.deliveryDate.certainty, 'recognized');
    const quantity = w.draft.lines[0].fields.quantity;
    assert.equal(quantity.certainty, 'needs-review');
    assert.match(quantity.note, /盖章挡住/);
    assert.ok(w.evaluation?.issues.some((i) => i.path === 'header.orderDate' && /订单日期缺失/.test(i.message)));
    // 填的是交订单的表，表上写明订单日期这一栏；提示词里没有业务目录和 JSON 结构（请求格式由 deepseek-client 守着）
    const call = f.calls().at(-1);
    assert.ok(call, '发了识别请求');
    const body = call.body;
    assert.equal(body.tools?.[0].function?.name, 'submit_order');
    const fields = <T extends z.ZodRawShape>(shape: T) => z.object({ properties: z.object(shape) });
    const form = fields({ header: fields({ orderDate: z.object({ description: z.string() }) }) }).parse(body.tools?.[0].function?.parameters);
    assert.ok(form.properties.header.properties.orderDate.description.includes('订单日期'));
    const system = messageText(body.messages[0]);
    assert.doesNotMatch(system, /JSON Schema|业务目录|unitPriceExact/);
  } finally {
    f.close();
  }
});

test('原件只有行交期：整单交期由代码取最晚一行、标明出处待核对；有一行没写就留空问人', async () => {
  const f = await fixture();
  try {
    const raw = filledForm({ deliveryDate: null });
    raw.lines[0].deliveryDate = '2026-09-20';
    raw.lines[1].deliveryDate = '2026-09-10';
    f.setReply(raw);
    let w = await recognized(f);
    assert.ok(w.draft, '有识别结果');
    const header = w.draft.header.deliveryDate;
    assert.equal(header.value, '2026-09-20');
    assert.equal(header.certainty, 'needs-review');
    assert.match(header.note, /最晚.*第 1 行/);
    assert.deepEqual(w.draft.lines.map((l) => l.fields.deliveryDate.value), ['2026-09-20', '2026-09-10'], '行交期原样保留');
    assert.ok(w.evaluation?.issues.some((i) => i.path === 'header.deliveryDate' && /第 1 行/.test(i.message)));
    raw.lines[1].deliveryDate = null;
    f.setReply(raw);
    w = await f.manager.analyze(w.id, { expectedRevision: w.revision, force: true, stream: false });
    assert.ok(w.draft, '重新识别后有识别结果');
    assert.equal(w.draft.header.deliveryDate.value, null, '有一行没交期，不替人定');
    assert.ok(w.evaluation?.issues.some((i) => i.path === 'header.deliveryDate' && /交货日期缺失/.test(i.message)));
  } finally {
    f.close();
  }
});

test('改了数量、改前金额对得上：靠字段上的标记把金额差异降成提醒，不看备注怎么写；改前就对不上的仍是错', async () => {
  const f = await fixture();
  try {
    let w = await recognized(f);
    assert.ok(w.draft, '有识别结果');
    const line = w.draft.lines[0];
    w = f.manager.edit(w.id, {
      expectedRevision: w.revision,
      operations: [{ op: 'set-line', lineId: line.id, field: 'quantity', value: '1200', reason: '虚构改量' }],
    });
    assert.ok(w.draft, '改后有识别结果');
    const quantity = w.draft.lines[0].fields.quantity;
    assert.equal(quantity.recalculated, true);
    assert.doesNotMatch(quantity.note, /原金额一致/, '备注只给人看');
    const issue = (d: OrderDraft | null) => {
      assert.ok(d, '有识别结果');
      return evaluateDraft(d).issues.find((i) => i.path === 'lines.' + line.id + '.statedAmount');
    };
    assert.equal(issue(w.draft)?.severity, 'review');
    // 行金额和两个合计都是这一件事：用同一句话，给人看时合成一条
    const recalculated = evaluateDraft(w.draft).issues.filter((i) => i.message.includes('数量或单价改过'));
    assert.equal(recalculated.length, 3);
    assert.equal(new Set(recalculated.map((i) => i.message)).size, 1);
    const forged = structuredClone(w.draft);
    delete forged.lines[0].fields.quantity.recalculated;
    forged.lines[0].fields.quantity.note = '后端确认修改前原金额一致；人工修改：虚构';
    assert.equal(issue(forged)?.severity, 'error', '备注写成老前缀也不算');
    // 原文金额本来就对不上的：再改数量（助手改的也一样）也盖不掉这个错
    const set = (field: string, value: string, origin?: 'ai') =>
      (w = f.manager.edit(w.id, { expectedRevision: w.revision, operations: [{ op: 'set-line', lineId: line.id, field, value, reason: '虚构' }] }, origin));
    set('statedAmount', '1');
    set('quantity', '1300', 'ai');
    assert.equal(w.draft?.lines[0].fields.statedAmount.value, '1', '原文金额留着');
    assert.equal(issue(w.draft)?.severity, 'error');
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
    // 关联的到货单要真在业务库里（不在的会被当成已删除、解除关联）
    const at = new Date().toISOString();
    f.manager.options.store.db
      .prepare("INSERT INTO flow_documents(id,kind,number,date,status,document,actor_id,actor_name,created_at,updated_at) VALUES(123,'arrival','DH-虚构-123','2026-11-01','draft','{\"lines\":[]}','虚构','虚构',?,?)")
      .run(at, at);
    w = f.manager.linkArrival(w.id, { expectedRevision: w.revision, docId: 123, sourceId: null });
    assert.equal(w.arrivalDocId, 123);
    const reopened = f.manager.get(w.id);
    assert.equal(reopened.mode, 'arrival');
    assert.equal(reopened.arrivalDocId, 123);
    assert.ok(reopened.draft, '到货草稿关联不得删除原订单草稿');
    const summary = f.manager.status().workspaces.find((x) => x.id === w.id);
    assert.equal(summary?.mode, 'arrival');
    assert.equal(summary?.arrivalDocId, 123);
    const back = f.manager.setMode(w.id, { expectedRevision: w.revision, mode: 'order' });
    assert.equal(back.mode, 'order');
    assert.equal(back.arrivalDocId, 123, '切回订单识别仍保留到货草稿关联');
  } finally {
    f.close();
  }
});

test('到货单识别接口复用供应商 AI 识别服务并读取原工作区原件', async () => {
  const f = await fixture(),
    // 真的供应商送货单识别服务（内存库）；模型替身交回一张填好的送货单
    receiptStore = new Store(':memory:'),
    receiptPrompts = new PromptPresetManager(':memory:', supplierDefaultPreset),
    receiptAi = new ReceiptAi(receiptStore, f.settings, receiptPrompts),
    app = express();
  f.setReply({
    supplierName: '虚构到货供应商',
    reference: 'SH-TEST-01',
    date: '2026-10-01',
    lines: [{ name: '虚构纸板', quantity: '10', unit: '张' }],
    warnings: [],
  });
  app.use(express.json());
  app.use(
    '/api/ai/imports',
    importRouter(f.manager, () => pageActor({ id: 'test-actor', name: '验收', permissions: ['business:edit'] }), receiptAi),
  );
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(500).json({ message: errorMessage(err) }),
  );
  const server = await listen(app);
  const base = server.origin;
  try {
    f.manager.setMode(f.w.id, { expectedRevision: f.w.revision, mode: 'arrival' });
    const r = await fetch(base + '/api/ai/imports/' + f.w.id + '/arrival/recognize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ERP-AI-Token': f.manager.csrfToken,
      },
      body: JSON.stringify({ stream: false }),
    });
    assert.equal(r.status, 200);
    const data = z.object({ result: receiptResultSchema }).parse(await r.json());
    assert.equal(data.result.reference, 'SH-TEST-01');
    assert.equal(data.result.supplierName, '虚构到货供应商');
  } finally {
    await server.close();
    receiptPrompts.close();
    receiptStore.close();
    f.close();
  }
});

test('精确十进制金额保留单价精度、合计数量与金额不混淆，不暗加13%税', () => {
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

test('识别出的单价分开说：没填、不是数、超过四位小数、超过一百万元上限各给各的提示，上限和保存时一致', async () => {
  // 投影成正式订单（standardOrderDraft 有识别结果时就是它，没关联客户产品）
  const { projectOrder } = await import('../server/import/standard-order.js');
  const store = new Store(':memory:');
  try {
    const priceIssues = (price: string | null) => {
      const d = asDraft();
      d.lines[0].fields.unitPrice.value = price;
      const lineId = d.lines[0].id;
      return {
        draft: evaluateDraft(d).issues.filter((i) => i.path === 'lines.' + lineId + '.unitPrice').map((i) => i.message),
        order: projectOrder(store, d, undefined).issues.filter((m: string) => /单价/.test(m)),
      };
    };
    const name = asDraft().lines[0].fields.productName.value;
    assert.deepEqual(priceIssues('').order.includes('产品单价缺失：' + name), true);
    assert.deepEqual(priceIssues('1.2a').order.includes('产品单价不是有效的非负数：' + name), true);
    let r = priceIssues('1.23456');
    assert.ok(r.order.includes('产品单价超过四位小数（不自动四舍五入）：' + name), r.order.join('；'));
    assert.ok(r.draft.some((m) => m.includes('超过四位小数')));
    // 上限：1000000 正好可以，多一个万分之一元就超
    r = priceIssues('1000000.0001');
    assert.ok(r.order.includes('产品单价超过 1000000 元的上限：' + name), r.order.join('；'));
    assert.deepEqual(r.draft, ['原文单价超过 1000000 元的上限，识别出的原值已保留。']);
    r = priceIssues('20000000');
    assert.ok(r.order.includes('产品单价超过 1000000 元的上限：' + name), r.order.join('；'));
    assert.deepEqual(r.draft, ['原文单价超过 1000000 元的上限，识别出的原值已保留。']);
    r = priceIssues('1000000');
    assert.deepEqual(r.draft, []);
    assert.ok(!r.order.some((m: string) => /上限|缺失|四位小数|有效的非负数/.test(m)), r.order.join('；'));
  } finally {
    store.close();
  }
});

test('上传时空文件、超过 10MB、文件头和扩展名对不上的都拒收', () => {
  assert.throws(() => detectFormat(Buffer.alloc(0), 'a.xlsx'), /10MB/);
  assert.throws(() => detectFormat(Buffer.alloc(10 * 1024 * 1024 + 1), 'a.png'), /10MB/);
  assert.throws(() => detectFormat(Buffer.from('fake'), 'test.doc'), /文件头与扩展名不符/);
  assert.throws(() => detectFormat(Buffer.from('<html>'), 'test.pdf'), /文件头与扩展名不符/);
  assert.equal(detectFormat(xlsxFixture(), '虚构.xlsx'), 'xlsx');
});

test('上传原件不调用 AI，重复上传复用原件；请求和结果不带密钥和正式业务记录', async () => {
  const f = await fixture();
  try {
    assert.equal(f.calls().length, 0);
    assert.equal((await f.manager.upload(xlsxFixture(), '另一个名字.xlsx')).duplicate, true);
    const w = await recognized(f);
    assert.equal(w.evaluation?.totalAmount, '2850.00');
    assert.ok(!JSON.stringify(w).includes(fakeKey));
    const req = f.calls()[0];
    assert.equal(req.url.href, 'https://api.deepseek.com/chat/completions');
    assert.ok(!JSON.stringify(req.body).includes(fakeKey));
    assert.ok(!JSON.stringify(req.body).includes('customers().'));
  } finally {
    f.close();
  }
});

test('助手受控修改同步表格与合计、差异可见、标明助手改的、撤销可恢复', async () => {
  const f = await fixture();
  try {
    let w = await recognized(f);
    assert.ok(w.draft, '有识别结果');
    const second = w.draft.lines[1].id;
    // 页面上“让 AI 改”打开全局助手，它按用户的话调 edit（origin=ai）改识别结果
    w = f.manager.edit(
      w.id,
      {
        expectedRevision: w.revision,
        operations: [{ op: 'set-line', lineId: second, field: 'quantity', value: '500', reason: '用户要求第二项500' }],
      },
      'ai',
    );
    assert.ok(w.draft, '改后有识别结果');
    assert.equal(w.draft.lines[1].fields.quantity.value, '500');
    assert.equal(w.evaluation?.totalAmount, '1755.00');
    assert.equal(w.changes[0].before, '2000');
    assert.equal(w.changes[0].after, '500');
    assert.ok(w.canUndo);
    // 来源如实记：助手改的就标助手改的，不说成“用户说的”
    const edited = w.draft.lines[1].fields.quantity;
    assert.equal(edited.editedBy, 'assistant');
    assert.match(edited.note, /^助手改的：/);
    assert.doesNotMatch(edited.note, /用户聊天/);
    assert.equal(w.changes[0].by, 'assistant');
    // 人在识别结果页上再改这一格，就不再算助手改的
    const byHand = f.manager.edit(w.id, {
      expectedRevision: w.revision,
      operations: [{ op: 'set-line', lineId: second, field: 'quantity', value: '600', reason: '虚构人工核对' }],
    });
    assert.ok(byHand.draft, '人改后有识别结果');
    assert.equal(byHand.draft.lines[1].fields.quantity.editedBy, undefined);
    assert.match(byHand.draft.lines[1].fields.quantity.note, /^人工修改：/);
    assert.equal(byHand.changes[0].by, 'person');
    w = f.manager.undo(byHand.id, { expectedRevision: byHand.revision });
    w = f.manager.undo(w.id, { expectedRevision: w.revision });
    assert.equal(w.evaluation?.totalAmount, '2850.00');
  } finally {
    f.close();
  }
});

test('模型多给的栏目丢掉；SQL操作和未知行的修改被拒绝', async () => {
  const f = await fixture();
  try {
    const form = filledForm();
    f.setReply({ ...form, header: { ...form.header, sources: ['fake-source'] }, sql: 'DROP TABLE orders' });
    const w = await f.manager.analyze(f.w.id, { expectedRevision: f.w.revision });
    assert.ok(w.draft, '有识别结果');
    assert.deepEqual(Object.keys(w.draft.header.buyerName).sort(), ['certainty', 'note', 'value']);
    for (const operations of [
      [{ op: 'sql', sql: 'DROP TABLE orders' }],
      [{ op: 'set-line', lineId: randomUUID(), field: 'quantity', value: '3', reason: 'test' }],
    ]) {
      assert.throws(() => f.manager.edit(w.id, { expectedRevision: w.revision, operations }, 'ai'));
      assert.deepEqual(f.manager.get(w.id).draft, w.draft);
    }
  } finally {
    f.close();
  }
});

test('删除密钥后不外发；原件篡改拦截；工作区独立持久恢复', async () => {
  const f = await fixture();
  try {
    const w = await recognized(f);
    writeFileSync(join(f.directory, w.id, 'original'), 'modified');
    await assert.rejects(
      f.manager.analyze(w.id, { expectedRevision: w.revision, force: true }),
      (e: unknown) => e instanceof AppError && e.code === 'source',
    );
    const reopened = testImports({ directory: f.directory, settings: f.settings });
    assert.equal(reopened.get(w.id).draft?.lines.length, 2);
    reopened.close();
    f.settings.removeKey({ confirmed: true, expectedRevision: f.settings.view().revision });
    await assert.rejects(
      f.manager.analyze(w.id, { expectedRevision: w.revision, force: true }),
      (e: unknown) => e instanceof AppError && e.code === 'key_required',
    );
  } finally {
    f.close();
  }
});

test('识别接口要页面凭证、跨站请求被拒；没开正式导入时没有执行地址；识别全流程不改业务表、不外发业务档案', async () => {
  const f = await fixture(),
    store = new Store(':memory:');
  store.saveCustomer({ name: '保留的ERP虚构客户', contact: '', phone: '', address: '', notes: '' });
  const before = JSON.stringify(store.customers());
  const server = await listen(createApp(store, { aiSettings: f.settings, imports: f.manager }));
  const base = server.origin + '/api/ai/imports';
  const post = (path: string, body: unknown, token = f.settings.csrfToken) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-AI-Token': token },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post('/' + f.w.id + '/analyze', { expectedRevision: 0 }, '')).status, 403);
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
    assert.equal(z.object({ duplicate: z.boolean() }).parse(await upload.json()).duplicate, true);
    const analyzed = z
      .object({ revision: z.number(), draft: orderDraftSchema })
      .parse(await (await post('/' + f.w.id + '/analyze', { expectedRevision: f.w.revision })).json());
    assert.equal(analyzed.draft.lines.length, 2);
    // 不开正式导入（没接 execution）时没有正式执行这条地址
    assert.equal(
      (
        await post('/' + f.w.id + '/execute', {
          expectedRevision: analyzed.revision,
          source: 'manual-ui',
        })
      ).status,
      404,
    );
    assert.equal(JSON.stringify(store.customers()), before);
    assert.equal(store.products().length, 0);
    assert.equal(store.orders().length, 0);
    assert.ok(!JSON.stringify(f.calls()[0].body).includes('保留的ERP虚构客户'));
  } finally {
    await server.close();
    store.close();
    f.close();
  }
});

test('数量/日期非法修改不保存', async () => {
  const f = await fixture();
  try {
    const w = await recognized(f);
    assert.ok(w.draft, '有识别结果');
    for (const op of [
      {
        op: 'set-line',
        lineId: w.draft.lines[0].id,
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
test('提示词带版本号、讲清甲方乙方；整单交期一栏写明原件只写了各行交期就留空，不让模型自己挑一行填', async () => {
  const p = await import('../server/import/prompts.js');
  const { orderFormTool } = await import('../shared/import/order-form.js');
  assert.ok(p.PROMPT_VERSION);
  assert.match(p.analysisPrompt(), /甲方/);
  assert.match(JSON.stringify(orderFormTool()), /原件只写了各行交期就留空/);
});

