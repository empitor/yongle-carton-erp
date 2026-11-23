// 识别导入路由（server/import/router.ts）：上传异常与编码回退、文件内联/下载、状态读写、业务预览与导入执行入口。
// 内存库、临时目录、虚构数据、假模型。
import { sales } from '../server/sales/index.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { apiErrorHandler } from '../server/http-errors.js';
import { orderDraftSchema } from '../shared/import/index.js';
import '../server/flow/index.js';
import { ImportExecutionService } from '../server/import/import-execution.js';
import { importRouter } from '../server/import/router.js';
import { pageActor } from './actor-fixture.js';
import { httpError } from './fake-deepseek.js';
import { listen } from './http-fixture.js';
import { imageFixture } from './import-fixtures.js';
import { filledForm, importWorkspace, tempDir } from './order-import-fixture.js';

const editor = pageActor({ id: 'router-editor', name: '虚构业务员', permissions: ['business:edit', 'import:execute'] });

function startRouter(options: { chat?: () => unknown; withBusiness?: boolean } = {}) {
  const temp = tempDir('erp-import-router-');
  const store = options.withBusiness ? new Store(':memory:') : undefined;
  const f = importWorkspace(options.chat ?? (() => filledForm()), store ? { store, archiveDirectory: join(temp.dir, 'archive') } : {});
  const execution = store ? new ImportExecutionService(store, f.manager) : undefined;
  const app = express();
  app.use(express.json());
  app.use(
    '/api/ai/imports',
    importRouter(
      f.manager,
      () => editor,
      undefined,
      store ? { store, execution } : undefined,
    ),
  );
  app.use(apiErrorHandler);
  return {
    f,
    store,
    app,
    async open() {
      const server = await listen(app);
      const token = f.settings.csrfToken;
      const postJson = (path: string, body: unknown) =>
        fetch(server.origin + '/api/ai/imports' + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-ERP-AI-Token': token },
          body: JSON.stringify(body),
        });
      const get = (path: string) =>
        fetch(server.origin + '/api/ai/imports' + path, { headers: { 'X-ERP-AI-Token': token } });
      return {
        origin: server.origin,
        token,
        get,
        postJson,
        async close() {
          await server.close();
          store?.close();
          f.close();
          temp.remove();
        },
      };
    },
  };
}

const errorSchema = z.object({ message: z.string(), code: z.string().optional(), failureId: z.string().optional() });
const workspaceReply = z.object({ id: z.string(), revision: z.number() });
const listReply = z.object({ workspaces: z.array(workspaceReply) });
const draftReply = workspaceReply.extend({ draft: orderDraftSchema });
const newChoice = z.object({ mode: z.literal('new') });
const mappingReply = workspaceReply.extend({
  mapping: z.object({
    customer: newChoice,
    products: z.record(z.string(), newChoice),
    roundingPolicy: z.string(),
  }),
});
const previewReply = z.object({
  previewDigest: z.string(),
  plan: z.object({ customer: newChoice, products: z.array(newChoice), total: z.string() }),
});
const executeReply = z.object({ orderId: z.number(), orderNumber: z.string(), sourceId: z.string(), digest: z.string() });

test('上传路由：缺文件名 415、非法识别类型 422、文件名无法解码按缺名拒收并记为“未知上传文件”、超 10MB 记错误档案并回 413', async () => {
  const ctx = startRouter();
  const s = await ctx.open();
  try {
    const missingName = await fetch(s.origin + '/api/ai/imports/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-ERP-AI-Token': s.token },
      body: imageFixture(),
    });
    assert.equal(missingName.status, 415);

    const badMode = await fetch(s.origin + '/api/ai/imports/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-ERP-AI-Token': s.token,
        'X-File-Name': encodeURIComponent('虚构.png'),
        'X-Import-Mode': 'invalid-mode',
      },
      body: imageFixture(),
    });
    assert.equal(badMode.status, 422);
    assert.equal(errorSchema.parse(await badMode.json()).code, 'schema');

    const badEncoding = await fetch(s.origin + '/api/ai/imports/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-ERP-AI-Token': s.token,
        'X-File-Name': '%E0%A4%A.png',
      },
      body: imageFixture(),
    });
    assert.equal(badEncoding.status, 415);
    const { failureId } = errorSchema.parse(await badEncoding.json());
    assert.ok(failureId);
    const failure = ctx.f.manager.failures().items.find((item) => item.id === failureId);
    assert.equal(failure?.fileName, '未知上传文件');

    const oversize = await fetch(s.origin + '/api/ai/imports/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-ERP-AI-Token': s.token,
        'X-File-Name': encodeURIComponent('超大.png'),
      },
      body: Buffer.alloc(10 * 1024 * 1024 + 16),
    });
    assert.equal(oversize.status, 413);
    assert.equal(errorSchema.parse(await oversize.json()).code, 'file-size');
    assert.equal(ctx.f.manager.failures().total, 4);
    assert.equal(ctx.f.manager.failures().items[0].fileName, '超大.png');
  } finally {
    await s.close();
  }
});

test('工作区路由：列表、详情、图片内联预览与附件下载、入队、识别失败回话与取消', async () => {
  let failAnalyze = true;
  const s = await startRouter({
    chat: () => (failAnalyze ? httpError(502) : filledForm()),
  }).open();
  try {
    const uploaded = await fetch(s.origin + '/api/ai/imports/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-ERP-AI-Token': s.token,
        'X-File-Name': encodeURIComponent('原件.png'),
      },
      body: imageFixture(),
    });
    assert.equal(uploaded.status, 201);
    const w = z.object({ workspace: workspaceReply }).parse(await uploaded.json()).workspace;

    assert.equal(listReply.parse(await (await s.get('')).json()).workspaces.length, 1);
    assert.equal(workspaceReply.parse(await (await s.get('/' + w.id)).json()).id, w.id);

    const inline = await s.get('/' + w.id + '/file?view=image');
    assert.equal(inline.status, 200);
    assert.match(inline.headers.get('content-disposition') ?? '', /^inline;/);

    const download = await s.get('/' + w.id + '/file');
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);

    const failed = await s.postJson('/' + w.id + '/analyze', { expectedRevision: w.revision, stream: false });
    assert.equal(failed.status, 502);
    assert.equal(errorSchema.parse(await failed.json()).code, 'upstream');

    failAnalyze = false;
    const enqueued = await s.postJson('/' + w.id + '/enqueue', { expectedRevision: w.revision });
    assert.equal(enqueued.status, 202);
    const afterEnqueue = workspaceReply.parse(await enqueued.json());

    const cancelRes = await s.postJson('/' + w.id + '/cancel', { expectedRevision: afterEnqueue.revision });
    assert.equal(cancelRes.status, 200);
  } finally {
    await s.close();
  }
});

async function businessWorkspace(t: TestContext) {
  const ctx = startRouter({ withBusiness: true });
  const s = await ctx.open();
  t.after(s.close);
  const w = await ctx.f.upload(imageFixture(), '订单.png');
  const path = '/' + w.id;
  const analyzed = await s.postJson(path + '/analyze', { expectedRevision: w.revision, stream: false });
  assert.equal(analyzed.status, 200);
  const current = draftReply.parse(await analyzed.json());
  assert.equal(current.id, w.id);
  assert.equal(current.draft.header.buyerName.value, '虚构客户');
  return { ctx, s, current, path };
}

async function mapNewRecords({ s, current, path }: Awaited<ReturnType<typeof businessWorkspace>>) {
  const mapping = {
    customer: { mode: 'new' },
    products: Object.fromEntries(current.draft.lines.map((line) => [line.id, { mode: 'new' }])),
    roundingPolicy: 'exact-cents',
  };
  const mapped = await s.postJson(path + '/mapping', { expectedRevision: current.revision, mapping });
  assert.equal(mapped.status, 200);
  const reply = mappingReply.parse(await mapped.json());
  assert.deepEqual(reply.mapping, mapping);
  return reply;
}

test('识别结果的备注可以编辑，撤销后恢复原备注', async (t) => {
  const { s, current, path } = await businessWorkspace(t);
  const edited = await s.postJson(path + '/edit', {
    expectedRevision: current.revision,
    operations: [{ op: 'set-header', field: 'notes', value: '路由修改', reason: '补充' }],
  });
  assert.equal(edited.status, 200);
  const afterEdit = draftReply.parse(await edited.json());
  assert.equal(afterEdit.draft.header.notes.value, '路由修改');

  const undone = await s.postJson(path + '/undo', { expectedRevision: afterEdit.revision });
  assert.equal(undone.status, 200);
  const afterUndo = draftReply.parse(await undone.json());
  assert.equal(afterUndo.draft.header.notes.value, current.draft.header.notes.value);
});

test('匹配路由返回档案候选和每条识别明细对应的产品候选', async (t) => {
  const { ctx, s, current, path } = await businessWorkspace(t);
  assert.ok(ctx.store);
  const customer = sales(ctx.store).createCustomer({ name: '虚构客户', contact: '', phone: '', address: '', notes: '' });
  const matches = await s.get(path + '/matches');
  assert.equal(matches.status, 200);
  const reply = z.object({
    revision: z.number(),
    customerCandidates: z.array(z.object({ id: z.number(), name: z.string() })),
    productCandidates: z.record(z.string(), z.array(z.object({ id: z.number() }))),
  }).parse(await matches.json());
  assert.equal(reply.revision, current.revision);
  assert.deepEqual(reply.customerCandidates, [{ id: customer.id, name: '虚构客户' }]);
  assert.deepEqual(reply.productCandidates, Object.fromEntries(current.draft.lines.map((line) => [line.id, []])));
});

test('标准订单投影使用保存后的档案映射，返回客户和明细且不写入', async (t) => {
  const fixture = await businessWorkspace(t);
  await mapNewRecords(fixture);
  const standard = await fixture.s.get(fixture.path + '/standard-order');
  assert.equal(standard.status, 200);
  const reply = z.object({
    fields: z.object({
      externalPurchaseOrder: z.string(),
      lines: z.array(z.object({ productName: z.string(), quantity: z.number() })),
    }),
    newCustomerPlan: z.object({ name: z.string() }),
    writesEnabled: z.boolean(),
  }).parse(await standard.json());
  assert.equal(reply.newCustomerPlan.name, '虚构客户');
  assert.equal(reply.fields.externalPurchaseOrder, 'TEST-01');
  assert.deepEqual(reply.fields.lines, [{ productName: '纸箱A', quantity: 1000 }, { productName: '纸箱B', quantity: 2000 }]);
  assert.equal(reply.writesEnabled, false);
});

test('导入预览缺版本时按全站校验返回 400，不记识别失败档案', async (t) => {
  const { ctx, s, path } = await businessWorkspace(t);
  const badPreview = await s.postJson(path + '/preview', {});
  assert.equal(badPreview.status, 400);
  assert.match(errorSchema.parse(await badPreview.json()).message, /^版本[：:]/);
  assert.equal(ctx.f.manager.failures().total, 0);
});

test('按预览正式导入后，回执对应新订单和原识别文件', async (t) => {
  const fixture = await businessWorkspace(t);
  const { ctx, s, current, path } = fixture;
  const afterMap = await mapNewRecords(fixture);
  const preview = await s.postJson(path + '/preview', { expectedRevision: afterMap.revision });
  assert.equal(preview.status, 200);
  const { previewDigest, plan } = previewReply.parse(await preview.json());
  assert.equal(plan.customer.mode, 'new');
  assert.equal(plan.products.length, 2);
  assert.equal(Number(plan.total), 2850);

  const executed = await s.postJson(path + '/execute', {
    expectedRevision: afterMap.revision,
    previewDigest,
    acknowledged: true,
  });
  assert.equal(executed.status, 200);
  const receipt = executeReply.parse(await executed.json());
  assert.ok(receipt.orderId > 0);
  assert.equal(receipt.sourceId, current.id);
  assert.equal(receipt.digest, previewDigest);
  assert.ok(ctx.store);
  const order = sales(ctx.store).order(receipt.orderId);
  assert.ok(order);
  assert.equal(order.number, receipt.orderNumber);
  assert.equal(order.externalPurchaseOrder, 'TEST-01');
});
