// 识别导入的正式执行（server/import/import-execution.ts）：按预览摘要确认、登录、事务回滚、去重、同名档案确认。
// 文件库、临时目录、虚构数据；模型替身直接交回填好的表。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/core/db.js';
import { AuthManager } from '../server/accounts/index.js';
import { testImports } from './order-import-fixture.js';
import { ImportExecutionService } from '../server/import/import-execution.js';
import { customerSchema, productSchema } from '../shared/core/domain.js';
import { startHttp } from './http-fixture.js';
import { imageFixture } from './import-fixtures.js';
import { fakeAiSettings } from './fake-deepseek.js';
import { z } from 'zod';
import { count, one as oneRow, parseStoredJson, rows } from '../server/core/index.js';
import { storedReceipt } from '../server/import/import-receipt.js';

const editor = pageActor({ id: 'fictional-editor', name: '虚构业务员', permissions: ['business:edit'] });
/** 导入预览回答里这几条测试要看的几项（比对的值原样取，不在这里定类型） */
const previewReply = z.object({
  previewDigest: z.string(),
  plan: z.object({
    source: z.object({ revision: z.number() }),
    customer: z.object({ mode: z.unknown(), name: z.string() }),
    products: z.array(z.object({ mode: z.unknown() })),
    order: z.object({ lines: z.array(z.object({ notes: z.unknown() })) }),
    confirmations: z.array(z.object({ existing: z.array(z.string()) })),
  }),
});
/** 正式导入的回执：建了哪张订单（原件归档在哪只记在库里的导入记录） */
const receiptReply = z.object({ orderId: z.number() });
/** 被拒时的回答：说明和出错代码 */
const failureReply = z.object({ message: z.string(), code: z.string().optional() });
/** 模型替身交回的表：一行纸箱 1000 只、单价 1.39，采购单号 FICTIONAL-PO-001 */
const filled = () => ({
  header: {
    buyerName: '虚构测试买方',
    supplierName: '宁波甬勒包装制品有限公司',
    orderDate: '2026-10-25',
    deliveryDate: '2026-11-01',
    purchaseOrderNumber: 'FICTIONAL-PO-001',
    currency: 'CNY',
    taxRate: '13',
    taxMode: '含税',
    notes: '整单备注',
  },
  lines: [
    {
      productName: '原存货名A',
      specification: '300×200×150mm',
      notes: '每捆20只，防潮',
      length: '300',
      width: '200',
      height: '150',
      dimensionUnit: 'mm',
      material: '牛卡',
      flute: 'B',
      requirements: '粘箱',
      quantity: '1000',
      unit: '只',
      unitPrice: '1.3900',
    },
  ],
  warnings: [],
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-formal-')),
    store = new Store(join(dir, 'business.sqlite')),
    { settings } = fakeAiSettings({ chat: () => filled() });
  const manager = testImports({
      directory: join(dir, 'imports'),
      archiveDirectory: join(dir, 'source-archive'),
      settings,
      store,
    }),
    h = await startHttp(store, {
      aiSettings: settings,
      imports: manager,
      execution: new ImportExecutionService(store, manager),
      auth: new AuthManager(join(dir, 'users.sqlite')),
      admin: { name: '测试管理员', password: 'Test-password-at-least-12' },
    });
  const request = (path: string, body?: unknown, anonymous = false) =>
    h.send(path, body, anonymous ? '' : h.cookie, { headers: { 'X-ERP-AI-Token': settings.csrfToken } });
  const preview = (w: { id: string; revision: number }) => request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision });
  const execute = (w: { id: string }, body: object) => request('/ai/imports/' + w.id + '/execute', { acknowledged: true, ...body });
  return {
    dir,
    store,
    settings,
    manager,
    request,
    preview,
    execute,
    async draft(suffix = '') {
      const w = (await manager.upload(Buffer.concat([imageFixture(), Buffer.from(suffix)]), '虚构订单.png')).workspace;
      return manager.analyze(w.id, { expectedRevision: w.revision, stream: false });
    },
    async close() {
      await h.close();
      manager.close();
      settings.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('正式导入要登录和绑定的预览、要确认；字段、精度、来源、审计都保存，同一预览重试不重复建单，重开库还在', async () => {
  const f = await fixture();
  try {
    const w = await f.draft();
    assert.equal((await f.request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision }, true)).status, 401);
    let r = await f.preview(w);
    assert.equal(r.status, 200);
    const preview = previewReply.parse(await r.json());
    assert.equal(f.store.customers().length, 0, '预览不建档案');
    assert.equal(f.store.orders().length, 0);
    assert.equal(preview.plan.order.lines[0].notes, '每捆20只，防潮');
    assert.equal((await f.execute(w, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest, acknowledged: false })).status, 400);
    assert.equal((await f.execute(w, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest, actor: { id: 'forged' } })).status, 400, '不收请求里带的操作人');
    r = await f.execute(w, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest });
    assert.equal(r.status, 200);
    const receipt = receiptReply.parse(await r.json()),
      order = f.store.order(receipt.orderId);
    assert.ok(order, '建了订单');
    assert.deepEqual(
      [order.lines[0].productName, order.lines[0].specification, order.lines[0].notes, order.lines[0].unit, order.lines[0].unitPriceExact],
      ['原存货名A', '300×200×150mm', '每捆20只，防潮', '只', '1.3900'],
    );
    assert.equal(order.totalAmountExact, '1390.0000');
    assert.equal(order.externalPurchaseOrder, 'FICTIONAL-PO-001');
    // 导入是谁做的记在导入执行台账里
    const execution = oneRow(f.store.db, rows.import_executions.pick({ document: true }), 'SELECT document FROM import_executions WHERE order_id=?', order.id);
    assert.ok(execution, '记了导入执行台账');
    const stored = parseStoredJson(storedReceipt, execution.document, 'import_executions.document');
    assert.equal(stored.actor.name, '测试管理员');
    assert.ok(readFileSync(stored.sourcePath).equals(imageFixture()));
    assert.ok(count(f.store.db, 'SELECT COUNT(*) n FROM business_audit') >= 3);
    const replay = receiptReply.parse(await (await f.execute(w, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest })).json());
    assert.equal(replay.orderId, receipt.orderId);
    assert.equal(f.store.orders().length, 1);
    assert.equal(f.manager.get(w.id).imported?.orderId, order.id);
    assert.throws(() => f.manager.edit(w.id, { expectedRevision: w.revision, operations: [] }));
    // 归档识别工作区不动订单和原件
    const removed = f.manager.changeArchive({ action: 'archive', acknowledged: true, items: [{ id: w.id, version: w.revision }] }, editor);
    assert.equal(removed.results[0].success, true);
    assert.equal(f.store.orders().length, 1);
    assert.ok(existsSync(stored.sourcePath));
    const reopened = testImports({ directory: join(f.dir, 'imports'), settings: f.settings, store: f.store });
    assert.equal(reopened.status().workspaces.length, 0);
    reopened.close();
    // 已导入过的原件再次上传另建任务，历史订单只作提示；采购单号重复的预览拦下
    const second = await f.manager.upload(imageFixture(), '再次上传.png');
    assert.equal(second.duplicate, false);
    assert.equal(second.workspace.imported, undefined);
    assert.equal(second.workspace.historyImport?.orderId, order.id);
    assert.equal((await f.preview(second.workspace)).status, 409);
    const persisted = new Store(join(f.dir, 'business.sqlite'));
    assert.equal(persisted.orders()[0].lines[0].notes, '每捆20只，防潮');
    assert.equal(count(persisted.db, 'SELECT COUNT(*) n FROM import_executions'), 1);
    persisted.close();
  } finally {
    await f.close();
  }
});

test('订单写到一半失败时新客户、新产品、审计一起回滚，修好后同一预览能重试', async () => {
  const f = await fixture();
  try {
    const w = await f.draft(),
      preview = previewReply.parse(await (await f.preview(w)).json());
    f.store.db.exec("CREATE TRIGGER fail_order BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    assert.equal((await f.execute(w, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest })).status, 500);
    assert.deepEqual([f.store.customers().length, f.store.products().length, f.store.orders().length], [0, 0, 0]);
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM business_audit'), 0);
    f.store.db.exec('DROP TRIGGER fail_order');
    assert.equal((await f.execute(w, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest })).status, 200);
    assert.equal(f.store.orders().length, 1);
  } finally {
    await f.close();
  }
});

test('预览以后档案变了、核对内容又改过、权限被撤销、采购单号重复都拦下', async () => {
  const f = await fixture();
  try {
    let w = await f.draft();
    let preview = previewReply.parse(await (await f.preview(w)).json());
    // 预览以后别人建了同名客户：导入计划变成用这个客户，摘要对不上，什么都不写
    assert.equal(preview.plan.customer.mode, 'new');
    f.store.saveCustomer(customerSchema.parse({ name: preview.plan.customer.name }));
    const stale = await f.execute(w, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest });
    assert.deepEqual([stale.status, failureReply.parse(await stale.json()).code], [409, 'preview-changed'], '预览以后档案变了');
    assert.deepEqual([f.store.orders().length, f.store.products().length, f.store.customers().length], [0, 0, 1]);
    preview = previewReply.parse(await (await f.preview(w)).json());
    assert.equal(preview.plan.customer.mode, 'existing');
    w = f.manager.edit(w.id, {
      expectedRevision: w.revision,
      operations: [{ op: 'set-header', field: 'notes', value: '新的核对内容', reason: '人工修改' }],
    });
    assert.equal((await f.execute(w, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest })).status, 409, '预览后又改过');
    const users = new DatabaseSync(join(f.dir, 'users.sqlite'));
    users.prepare('UPDATE users SET permissions=?').run(JSON.stringify(['business:edit']));
    assert.equal((await f.preview(w)).status, 403, '没有导入权限');
    users.prepare('UPDATE users SET permissions=?').run(JSON.stringify(['business:edit', 'import:execute', 'import:restore']));
    users.close();
    preview = previewReply.parse(await (await f.preview(w)).json());
    assert.equal((await f.execute(w, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest })).status, 200);
    const second = await f.draft('different-byte-source');
    assert.equal((await f.preview(second)).status, 409, '采购单号重复');
    assert.equal(f.store.orders().length, 1);
  } finally {
    await f.close();
  }
});

test('同名客户有两个时导入预览要人工选择，不建订单', async () => {
  const f = await fixture();
  try {
    for (const contact of ['联系人甲', '联系人乙'])
      f.store.saveCustomer({ name: '虚构测试买方', contact, phone: '', address: '', notes: '' });
    const response = await f.preview(await f.draft());
    assert.equal(response.status, 400);
    assert.match(failureReply.parse(await response.json()).message, /歧义/);
    assert.equal(f.store.orders().length, 0);
  } finally {
    await f.close();
  }
});

test('并发提交不重复写入；精确匹配复用档案，客户改名后同采购单仍按内部身份去重', async () => {
  const f = await fixture();
  try {
    const w = await f.draft(),
      preview = previewReply.parse(await (await f.preview(w)).json());
    const replies = await Promise.all([f.execute(w, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest }), f.execute(w, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest })]);
    assert.ok(replies.every((r) => [200, 409].includes(r.status)));
    assert.equal(f.store.orders().length, 1);
    const withNumber = (x: { id: string; revision: number }, value: string) =>
      f.manager.edit(x.id, {
        expectedRevision: x.revision,
        operations: [{ op: 'set-header', field: 'purchaseOrderNumber', value, reason: '虚构单号' }],
      });
    const second = withNumber(await f.draft('second-order'), 'FICTIONAL-PO-002');
    const p = previewReply.parse(await (await f.preview(second)).json());
    assert.equal(p.plan.customer.mode, 'existing');
    assert.equal(p.plan.products[0].mode, 'existing');
    assert.equal((await f.execute(second, { expectedRevision: p.plan.source.revision, previewDigest: p.previewDigest })).status, 200);
    assert.deepEqual([f.store.orders().length, f.store.customers().length, f.store.products().length], [2, 1, 1]);
    const customer = f.store.customers()[0],
      renamed = f.store.saveCustomer({ ...customer, name: '改名后的虚构买方' }, customer.id, customer.version),
      product = f.store.products()[0];
    let third = withNumber(await f.draft('third-order'), 'FICTIONAL-PO-002');
    assert.ok(third.draft, '有识别结果');
    third = f.manager.mapping(third.id, {
      expectedRevision: third.revision,
      mapping: {
        customer: { mode: 'existing', id: renamed.id, version: renamed.version },
        products: { [third.draft.lines[0].id]: { mode: 'existing', id: product.id, version: product.version } },
        roundingPolicy: 'exact-cents',
      },
    });
    assert.equal((await f.preview(third)).status, 409);
  } finally {
    await f.close();
  }
});

test('同名产品查重：料号相同、同名同尺寸材质的拦下；同名不同尺寸要在预览里确认“是另一个产品”才建，人工新建窗口同一套规则', async () => {
  const f = await fixture();
  try {
    const named = () => f.store.products(true).filter((p) => p.name.replace(/\s/g, '') === '原存货名A');
    const asNew = async (suffix: string) => {
      const w = await f.draft(suffix);
      assert.ok(w.draft, '有识别结果');
      return f.manager.mapping(w.id, {
        expectedRevision: w.revision,
        mapping: { customer: { mode: 'pending' }, products: { [w.draft.lines[0].id]: { mode: 'new' } }, roundingPolicy: 'exact-cents' },
      });
    };
    // 已有同名、尺寸不同的产品（归档的也算）
    const other = f.store.saveProduct(
      productSchema.parse({ name: '原存货名 A', length: 400, width: 300, height: 200, dimensionUnit: 'mm', material: '牛卡', flute: 'B' }),
    );
    f.store.markArchived('products', other.id, 'fixture');
    const w = await asNew('same-name');
    assert.ok(w.draft, '有识别结果');
    const lineId = w.draft.lines[0].id;
    const preview = previewReply.parse(await (await f.preview(w)).json());
    assert.equal(preview.plan.confirmations.length, 1);
    assert.match(preview.plan.confirmations[0].existing[0], /^原存货名 A（400 × 300 × 200 mm \/ 牛卡 \/ B，已归档）$/);
    const without = await f.execute(w, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest });
    assert.equal(without.status, 409);
    assert.equal(failureReply.parse(await without.json()).code, 'same-name-product', '没确认不建');
    assert.equal(f.store.orders().length, 0);
    assert.equal((await f.execute(w, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest, distinctProducts: [lineId] })).status, 200);
    assert.equal(named().length, 2, '确认过是另一个产品就新建');

    // 同名、尺寸材质都相同（含已归档）：不能再建，导入预览就拦下
    const blocked = await f.preview(await asNew('same-product'));
    assert.equal(blocked.status, 409);
    assert.match(failureReply.parse(await blocked.json()).message, /尺寸、材质都相同的产品/);

    // 人工新建：同名不同尺寸要带 confirmDistinct（新建窗口里确认），料号相同一律不建
    const create = (body: object) =>
      f.request('/products', { name: '原存货名A', length: 500, width: 400, height: 300, dimensionUnit: 'mm', material: '牛卡', flute: 'B', priceCents: 0, ...body });
    const ask = await create({});
    assert.equal(ask.status, 409);
    const asked = failureReply.parse(await ask.json());
    assert.equal(asked.code, 'same-name-product');
    assert.match(asked.message, /已有同名产品：原存货名 A（400 × 300 × 200 mm/);
    assert.equal((await create({ confirmDistinct: true })).status, 201);
    assert.equal(named().length, 3);
    f.store.saveProduct(productSchema.parse({ name: '虚构料号箱', customerProductCode: 'XG-77' }));
    const code = await f.request('/products', { name: '完全不同的名字', customerProductCode: 'xg 77', priceCents: 0, confirmDistinct: true });
    assert.equal(code.status, 409);
    assert.match(failureReply.parse(await code.json()).message, /客户料号“xg 77”已经用在：虚构料号箱/);
    assert.equal((await create({ length: 300, width: 200, height: 150, confirmDistinct: true })).status, 409, '同名同尺寸材质：确认了也不建');
  } finally {
    await f.close();
  }
});
