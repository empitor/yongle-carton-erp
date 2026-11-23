// 订单识别工作区：并发和过期修订、多文件隔离、删除和取消、客户产品关联、同一原件同时正式导入、后台识别
import { sales } from '../server/sales/index.js';
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localAdministratorActor, Store, AppError, count } from '../server/core/index.js';
import { docxFixture, imageFixture } from './import-fixtures.js';
import { ImportExecutionService } from '../server/import/import-execution.js';
import { customerSchema, productSchema } from '../shared/core/domain.js';
import { filledForm, fixture, holdModel, importWorkspace, recognized, tempDir, testImports } from './order-import-fixture.js';
import { httpError } from './fake-deepseek.js';

const editor = pageActor({ id: 'tester', name: '虚构业务员', permissions: ['business:edit'] });

test('AI请求期间另一页面保存草稿时，旧AI结果不得覆盖新修订', async () => {
  const f = await fixture();
  try {
    const w = await recognized(f);
    assert.ok(w.draft, '有识别结果');
    const lineId = w.draft.lines[1].id;
    const model = holdModel(f.settings);
    const pending = f.manager.analyze(w.id, { expectedRevision: w.revision, force: true });
    await model.started;
    const manual = f.manager.edit(w.id, {
      expectedRevision: w.revision,
      operations: [
        { op: 'set-line', lineId, field: 'quantity', value: '2500', reason: '另一页面的新修改' },
      ],
    });
    model.release();
    await assert.rejects(pending, (e: unknown) => e instanceof AppError && e.code === 'stale');
    assert.equal(f.manager.get(w.id).draft?.lines[1].fields.quantity.value, '2500');
    assert.equal(f.manager.get(w.id).revision, manual.revision);
  } finally {
    f.close();
  }
});

test('多文件隔离：归档A后B不变，重开后A仍在归档里，能恢复', async () => {
  const f = await fixture();
  try {
    const a = await recognized(f);
    let b = (
      await f.manager.upload(
        Buffer.concat([imageFixture(), Buffer.from('another-file')]),
        '另一个订单.png',
      )
    ).workspace;
    b = await f.manager.analyze(b.id, { expectedRevision: b.revision });
    const before = JSON.stringify(f.manager.get(b.id));
    f.manager.changeArchive({ action: 'archive', items: [{ id: a.id, version: a.revision }] }, editor);
    assert.equal(f.manager.get(a.id).draft?.lines.length, 2, '归档的原件和识别结果都在');
    assert.equal(JSON.stringify(f.manager.get(b.id)), before);
    assert.equal(f.manager.status().workspaces.length, 1);
    // 识别导入页、数据管理页、助手看到的都是同一份列表
    assert.deepEqual(f.manager.workspaceLists().active.map((r) => r.id), [b.id]);
    assert.deepEqual(f.manager.workspaceLists().archived.map((r) => r.id), [a.id]);
    const reopened = testImports({ directory: f.directory, settings: f.settings });
    assert.equal(reopened.status().workspaces.length, 1);
    assert.deepEqual(reopened.status().archives.map((r) => r.id), [a.id]);
    reopened.close();
    assert.throws(() => f.manager.changeArchive({ action: 'archive', items: [{ id: b.id, version: b.revision }] }, null), '没有权限不能归档');
    // 和单据、档案的归档同样的写法和说法：版本不对说请刷新，重复点算成功
    const archived = f.manager.get(a.id);
    const stale = f.manager.changeArchive({ action: 'restore', items: [{ id: a.id, version: archived.revision - 1 }] }, editor);
    assert.deepEqual(stale.results, [{ id: a.id, success: false, message: '记录已修改，请刷新。' }]);
    const again = f.manager.changeArchive({ action: 'archive', items: [{ id: a.id, version: archived.revision }] }, editor);
    assert.deepEqual(again.results, [{ id: a.id, success: true, message: '已经归档' }]);
    const restored = f.manager.changeArchive({ action: 'restore', items: [{ id: a.id, version: archived.revision }] }, editor);
    assert.equal(restored.results[0].success, true);
    assert.equal(f.manager.get(a.id).draft?.lines.length, 2);
    assert.equal(f.manager.status().workspaces.length, 2);
    // 永久删除也是 { id, version } 进、{ id, success, message } 出，只给本机管理员
    const admin = localAdministratorActor(pageActor({ id: 'tester-admin', name: '虚构维护', role: 'super_admin', permissions: ['business:edit'] }));
    const gone = await f.manager.deleteMany({ items: [{ id: b.id, version: f.manager.get(b.id).revision }] }, admin);
    assert.deepEqual(gone.results, [{ id: b.id, success: true, message: '已从数据库和文件系统删除' }]);
    assert.equal(f.manager.status().workspaces.length, 1);
  } finally {
    f.close();
  }
});

test('归档正在识别的文件时取消请求；供应商迟到返回也不能写回', async () => {
  const f = await fixture();
  try {
    const w = f.w;
    const model = holdModel(f.settings);
    const pending = f.manager.analyze(w.id, { expectedRevision: w.revision });
    await model.started;
    f.manager.changeArchive({ action: 'archive', items: [{ id: w.id, version: w.revision }] }, editor);
    model.release();
    await assert.rejects(pending);
    assert.equal(f.manager.status().workspaces.length, 0);
    f.manager.changeArchive({ action: 'restore', items: [{ id: w.id, version: f.manager.get(w.id).revision }] }, editor);
    assert.equal(f.manager.get(w.id).draft, null);
  } finally {
    f.close();
  }
});

test('取消当前识别保留原件，可重试，其他文件不受影响', async () => {
  const f = await fixture();
  try {
    const w = f.w;
    const model = holdModel(f.settings);
    const task = f.manager.analyze(w.id, { expectedRevision: w.revision });
    await model.started;
    const cancelled = f.manager.cancel(w.id, { expectedRevision: w.revision });
    model.release();
    await assert.rejects(task);
    assert.equal(f.manager.get(w.id).draft, null);
    assert.equal(f.manager.get(w.id).task?.state, 'cancelled');
    model.restore();
    const retried = await f.manager.analyze(w.id, { expectedRevision: cancelled.revision });
    assert.equal(retried.draft?.lines.length, 2);
  } finally {
    f.close();
  }
});

test('客户产品关联仅存草稿，数量修改撤销核对但保留关联，拒绝跨文件明细ID', async () => {
  const f = await fixture();
  try {
    let w = await recognized(f);
    assert.ok(w.draft, '有识别结果');
    const mapping = {
      customer: { mode: 'new' },
      products: Object.fromEntries(w.draft.lines.map((l) => [l.id, { mode: 'new' }])),
      roundingPolicy: 'exact-cents',
    };
    w = f.manager.mapping(w.id, { expectedRevision: w.revision, mapping });
    assert.equal(w.mapping?.customer.mode, 'new');
    const changed = f.manager.edit(w.id, {
      expectedRevision: w.revision,
      operations: [
        {
          op: 'set-line',
          lineId: w.draft?.lines[0].id,
          field: 'quantity',
          value: '1200',
          reason: '人工修改',
        },
      ],
    });
    assert.deepEqual(changed.mapping, mapping);
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

test('档案候选不等于自动关联；标准草稿使用正式字段名，不能编造内部ID', async () => {
  const f = await fixture(),
    store = new Store(':memory:');
  try {
    let w = await recognized(f);
    const customer = sales(store).createCustomer({
      name: '宁波虚构客户有限公司',
      contact: '',
      phone: '',
      address: '',
      notes: '',
    });
    const { matchDraft } = await import('../server/import/matching.js'),
      { standardOrderDraft } = await import('../server/import/standard-order.js');
    const before = JSON.stringify(sales(store).customers()),
      matches = matchDraft(store, w);
    assert.ok(matches.customerCandidates.some((c) => c.id === customer.id));
    assert.equal(w.mapping, undefined);
    const candidate = standardOrderDraft(store, w);
    assert.ok(candidate, '有标准订单草稿');
    assert.equal(candidate.fields.customerId, null);
    assert.equal(candidate.fields.externalPurchaseOrder, 'TEST-01');
    assert.equal(candidate.fields.lines[0].unitPriceExact, '1.39');
    assert.deepEqual([candidate.fields.taxRate, candidate.fields.taxText], [13, '13']);
    assert.equal(candidate.validatedInput, null);
    assert.equal(candidate.writesEnabled, false);
    assert.equal(JSON.stringify(sales(store).customers()), before);
  } finally {
    store.close();
    f.close();
  }
});

test('永久删除搬到一半时程序关了，重启后库里还有的原件搬回原处', async () => {
  const f = await fixture();
  try {
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(f.directory, '_deleting'), { recursive: true });
    await fs.rename(join(f.directory, f.w.id), join(f.directory, '_deleting', f.w.id));
    const reopened = testImports({ directory: f.directory, settings: f.settings });
    const original = await reopened.file(f.w.id);
    assert.ok(original.bytes.length);
    reopened.close();
  } finally {
    f.close();
  }
});

test('同一原件两份工作区同时正式导入：只成一张订单、台账一行', async () => {
  const header = {
    buyerName: '复现用虚构客户',
    supplierName: '宁波甬勒包装制品有限公司',
    orderDate: '2026-10-25',
    deliveryDate: '2026-11-01',
    currency: 'CNY',
  };
  const line = {
    productName: '复现用虚构纸箱',
    specification: '300×200×150mm',
    length: '300',
    width: '200',
    height: '150',
    dimensionUnit: 'mm',
    material: '牛卡',
    flute: 'B',
    requirements: '粘箱',
    quantity: '100',
    unit: '只',
    unitPrice: '1',
  };
  const archive = tempDir('erp-reimport-'),
    store = new Store(':memory:'),
    f = importWorkspace(() => ({ header, lines: [line], warnings: [] }), { store, archiveDirectory: archive.dir }),
    actor = pageActor({ id: 'tester', name: '虚构业务员', permissions: ['business:edit', 'import:execute'] });
  sales(store).createCustomer(customerSchema.parse({ name: header.buyerName }));
  const { productName: _name, specification: _spec, quantity: _q, unit: _u, unitPrice: _p, ...size } = line;
  sales(store).createProduct(productSchema.parse({ name: line.productName, ...size, length: 300, width: 200, height: 150 }));
  const manager = f.manager,
    service = new ImportExecutionService(store, manager);
  try {
    const draft = async (quantity: string) => {
      let w = (await manager.upload(docxFixture(), '同一虚构原件.docx')).workspace;
      w = await manager.analyze(w.id, { expectedRevision: w.revision, stream: false });
      if (quantity !== line.quantity)
        w = manager.edit(w.id, {
          expectedRevision: w.revision,
          operations: [{ op: 'set-line', lineId: w.draft?.lines[0].id, field: 'quantity', value: quantity, reason: '虚构人工核对修改' }],
        });
      return manager.get(w.id);
    };
    const a = await draft('100'),
      b = await draft('200');
    assert.equal(a.fileHash, b.fileHash);
    const pa = await service.preview(a.id, { expectedRevision: a.revision }, actor),
      pb = await service.preview(b.id, { expectedRevision: b.revision }, actor);
    const results = await Promise.allSettled([
      service.execute(a.id, { expectedRevision: pa.plan.source.revision, previewDigest: pa.previewDigest, acknowledged: true }, actor),
      service.execute(b.id, { expectedRevision: pb.plan.source.revision, previewDigest: pb.previewDigest, acknowledged: true }, actor),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(sales(store).orders().length, 1);
    assert.equal(count(store.db, 'SELECT COUNT(*) n FROM import_executions'), 1);
  } finally {
    f.close();
    store.close();
    archive.remove();
  }
});

test('后台识别：马上返回、各份原件结果各自独立，重复入队不重复调模型，失败的能再识别', async () => {
  const perFile = new Map<string, number>();
  const f = importWorkspace((body) => {
    const found = /原文件《(订单\d\.png)》/.exec(JSON.stringify(body.messages));
    assert.ok(found, '识别请求里有原文件名');
    const file = found[1];
    perFile.set(file, (perFile.get(file) || 0) + 1);
    if (file === '订单1.png' && perFile.get(file) === 1) return httpError(504);
    const form = filledForm();
    return { ...form, lines: [{ ...form.lines[0], productName: file }] };
  });
  const settled = async (ids: string[]) => {
    while (ids.some((id) => f.manager.isBusy(id))) await new Promise((r) => setImmediate(r));
  };
  try {
    const jobs = [];
    for (let i = 0; i < 3; i++) {
      const w = (await f.manager.upload(Buffer.concat([imageFixture(), Buffer.from('独立文件' + i)]), '订单' + i + '.png')).workspace;
      jobs.push(w);
      assert.equal(f.manager.enqueue(w.id, { expectedRevision: w.revision, stream: false }).draft, null, '马上返回，还没有结果');
      f.manager.enqueue(w.id, { expectedRevision: w.revision, stream: false });
    }
    await settled(jobs.map((w) => w.id));
    assert.equal(f.fake.chatCalls().length, 3, '重复入队不重复调');
    const failed = f.manager.get(jobs[1].id);
    assert.equal(failed.task?.state, 'failed');
    assert.equal(failed.draft, null);
    f.manager.enqueue(failed.id, { expectedRevision: failed.revision, stream: false });
    await settled([failed.id]);
    assert.equal(f.fake.chatCalls().length, 4);
    for (const [i, w] of jobs.entries()) {
      const result = f.manager.get(w.id);
      assert.equal(result.task?.state, 'ready');
      assert.equal(result.fileHash, w.fileHash);
      assert.equal(result.draft?.lines[0].fields.productName.value, '订单' + i + '.png');
    }
  } finally {
    f.close();
  }
});
