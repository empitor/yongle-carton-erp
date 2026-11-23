// 识别导入和永久删除：正式导入的订单永久删除后来源、审计还在；同一原件可以再识别、再导入，编号不复用；
// 导入台账的唯一约束；识别工作区库里同一原件能建多个识别任务。虚构数据。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, count, one, parseStoredJson, rows } from '../server/core/index.js';
import { storedReceipt } from '../server/import/import-receipt.js';
import { testImports } from './order-import-fixture.js';
import { findImport } from '../server/import/import-records.js';
import { ImportExecutionService } from '../server/import/import-execution.js';
import { ImportRepository } from '../server/import/repository.js';
import { customerSchema, productSchema, orderSchema } from '../shared/core/domain.js';
import { docxFixture, workspaceRecord } from './import-fixtures.js';
import { fakeAiSettings } from './fake-deepseek.js';
import { startHttp, testAdmin } from './http-fixture.js';

const previewSchema = z.looseObject({ plan: z.looseObject({ source: z.looseObject({ revision: z.number() }) }), previewDigest: z.string() });
const executionSchema = z.looseObject({ orderId: z.number(), executionId: z.string() });
const errorBody = z.looseObject({ message: z.string() });
const deletionPreview = z.looseObject({ digest: z.string() });

/** 管理员已进超级管理员模式；识别每次返回不同的客户和产品名，免得同名档案要人选映射 */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-import-delete-')),
    file = join(dir, 'erp.sqlite'),
    store = new Store(file);
  let serial = 0;
  const { settings } = fakeAiSettings({
    chat: () => {
      serial += 1;
      return {
        header: { buyerName: 'AI客户（虚构）' + serial, orderDate: '2026-10-25', deliveryDate: '2026-11-01' },
        lines: [{ productName: 'AI纸箱（虚构）' + serial, unit: '只', quantity: '1000', unitPrice: '1.3900' }],
      };
    },
  });
  const manager = testImports({
    directory: join(dir, 'imports'),
    archiveDirectory: join(dir, 'archive'),
    settings,
    store,
  });
  const h = await startHttp(store, {
    aiSettings: settings,
    imports: manager,
    execution: new ImportExecutionService(store, manager),
  });
  await h.enterSuperMode();
  const request = (path: string, body: unknown) =>
    h.send(path, body, h.cookie, { headers: { 'X-ERP-AI-Token': settings.csrfToken } });
  /** 识别一份原件，返回工作区 */
  const recognize = async (name = '虚构AI订单.docx') => {
    const up = await manager.upload(Buffer.from(docxFixture()), name);
    return { up, w: await manager.analyze(up.workspace.id, { expectedRevision: up.workspace.revision }) };
  };
  /** 正式导入：预览不过就把预览的回答交回来 */
  const importIt = async (id: string) => {
    const preview = await request('/ai/imports/' + id + '/preview', { expectedRevision: manager.get(id).revision });
    const raw: unknown = await preview.json();
    if (preview.status !== 200) return { status: preview.status, message: errorBody.parse(raw).message };
    const body = previewSchema.parse(raw);
    const executed = await request('/ai/imports/' + id + '/execute', { expectedRevision: body.plan.source.revision, previewDigest: body.previewDigest, acknowledged: true });
    return { status: executed.status, receipt: executionSchema.parse(await executed.json()) };
  };
  /** 页面上的删除：先看影响清单，再带着范围摘要和本人密码提交 */
  const removeOrder = async (order: { id: number; version: number }) => {
    const selection = { module: 'orders', items: [{ id: order.id, version: order.version }] };
    const p = deletionPreview.parse(await (await request('/deletions/preview', selection)).json());
    const r = await request('/deletions/execute', {
      ...selection,
      requestId: randomUUID(),
      deletionDigest: p.digest,
      password: testAdmin.password,
    });
    assert.equal(r.status, 200);
  };
  return {
    file,
    store,
    manager,
    request,
    recognize,
    importIt,
    removeOrder,
    async close() {
      await h.close();
      manager.close();
      settings.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('永久删除正式导入的订单：来源文件、审计和导入凭据都留着，工作区显示已永久删除、不能再从它入库', async () => {
  const f = await fixture();
  try {
    const { w } = await f.recognize();
    const imported = await f.importIt(w.id);
    assert.ok(imported.receipt);
    const order = sales(f.store).order(imported.receipt.orderId);
    assert.ok(order);
    await f.removeOrder(order);
    const execution = one(f.store.db, rows.import_executions.pick({ order_id: true, document: true }),
      'SELECT order_id,document FROM import_executions WHERE id=?', imported.receipt.executionId);
    assert.ok(execution);
    assert.equal(execution.order_id, null);
    assert.ok(existsSync(parseStoredJson(storedReceipt, execution.document, 'import_executions.document').sourcePath));
    const workspaceImport = f.manager.get(w.id).imported;
    assert.ok(workspaceImport);
    assert.equal(workspaceImport.permanentlyDeleted, true);
    assert.equal((await f.importIt(w.id)).status, 409);
    const copy = new Store(f.file);
    try {
      const entry = findImport(copy, w.id);
      assert.ok(entry);
      assert.equal(entry.permanentlyDeleted, true);
    } finally {
      copy.close();
    }
    const audits = count(f.store.db, 'SELECT COUNT(*) FROM business_audit WHERE record_id=? AND entity=?', order.id, 'orders');
    assert.equal(audits, 2);
  } finally {
    await f.close();
  }
});

test('同一原件：原订单有效或在归档里时入库被拦并说明；永久删除后能再识别、再导入，编号不复用', async () => {
  const f = await fixture();
  try {
    const first = await f.recognize('同一订单照片.docx');
    const initial = await f.importIt(first.w.id);
    assert.ok(initial.receipt);
    const order1 = sales(f.store).order(initial.receipt.orderId);
    assert.ok(order1);
    const second = await f.recognize('同一订单照片.docx');
    assert.notEqual(second.up.workspace.id, first.up.workspace.id);
    assert.equal(second.up.duplicate, false);
    const previous = second.up.workspace.historyImport;
    assert.ok(previous);
    assert.equal(previous.orderNumber, order1.number);
    const effective = await f.importIt(second.w.id);
    assert.equal(effective.status, 409);
    assert.ok(typeof effective.message === 'string');
    assert.match(effective.message, new RegExp(order1.number));
    await f.request('/orders/batch', { action: 'archive', acknowledged: true, items: [{ id: order1.id, version: order1.version }] });
    const archived = await f.importIt(second.w.id);
    assert.equal(archived.status, 409);
    assert.ok(typeof archived.message === 'string');
    assert.match(archived.message, /归档|有效订单/);
    const row = sales(f.store).order(order1.id, true);
    assert.ok(row);
    await f.request('/orders/batch', { action: 'restore', acknowledged: true, items: [{ id: row.id, version: row.version }] });
    const restored = sales(f.store).order(order1.id);
    assert.ok(restored);
    await f.removeOrder(restored);
    const third = await f.recognize('同一订单照片.docx');
    const history = third.up.workspace.historyImport;
    assert.ok(history);
    assert.equal(history.permanentlyDeleted, true);
    const subsequent = await f.importIt(third.w.id);
    assert.ok(subsequent.receipt);
    const order2 = sales(f.store).order(subsequent.receipt.orderId);
    assert.ok(order2);
    assert.notEqual(order2.id, order1.id);
    assert.notEqual(order2.number, order1.number);
    const ledger = f.store.db.prepare('SELECT order_id FROM import_executions WHERE file_hash=?').all(first.up.workspace.fileHash);
    assert.deepEqual(ledger.map((r) => r.order_id).sort(), [null, order2.id].sort());
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    await f.close();
  }
});

test('导入台账：同一原件只能挂一张有效订单，订单已永久删除的那条（order_id 为空）不挡', () => {
  const store = new Store(':memory:');
  try {
    const customer = sales(store).createCustomer(customerSchema.parse({ name: '台账客户（虚构）' })),
      product = sales(store).createProduct(productSchema.parse({ name: '台账纸箱（虚构）' }));
    const order = () =>
      sales(store).saveOrder(
        orderSchema.parse({
          customerId: customer.id,
          orderDate: '2026-10-25',
          deliveryDate: '2026-11-01',
          status: '待确认',
          lines: [{ productId: product.id, productName: product.name, specification: '', quantity: 10, unit: '只', unitPriceCents: 100 }],
        }),
      );
    const first = order(),
      second = order();
    const insert = store.db.prepare(
      'INSERT INTO import_executions(id,source_id,file_hash,fingerprint,order_id,actor_id,created_at,document) VALUES(?,?,?,?,?,?,?,?)',
    );
    insert.run('first-exec', 'first-source', 'same-hash', 'same-fingerprint', first.id, 'actor', '2026-10-25T00:00:00Z', '{}');
    insert.run('purged-exec', 'purged-source', 'same-hash', 'same-fingerprint', null, 'actor', '2026-10-26T00:00:00Z', '{}');
    assert.throws(
      () => insert.run('second-exec', 'second-source', 'same-hash', 'other-fingerprint', second.id, 'actor', '2026-10-27T00:00:00Z', '{}'),
      /UNIQUE/,
    );
  } finally {
    store.close();
  }
});

test('识别工作区库：同一原件能建多个识别任务，重开照常用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-workspace-repo-'));
  try {
    const file = join(dir, 'workspaces.sqlite');
    let repo = new ImportRepository(file);
    for (const id of ['first-workspace', 'second-workspace']) repo.insert(workspaceRecord({ id, fileHash: 'same-hash', revision: 0, fileName: '虚构原件' }));
    assert.equal(repo.byHashAll('same-hash').length, 2);
    repo.close();
    repo = new ImportRepository(file);
    assert.equal(repo.get('first-workspace')?.fileName, '虚构原件');
    repo.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
