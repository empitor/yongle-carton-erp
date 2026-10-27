// 审查复现：仅临时库和虚构传输，不触碰正式业务/配置，不调用外部API。
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from '../server/db.js';
import { ImportManager } from '../server/import/manager.js';
import { ImportExecutionService, findImport } from '../server/business/import-execution.js';
import { customerSchema, productSchema } from '../shared/domain.js';
import { headerFields, lineFields, blankField } from '../shared/order-draft.js';
import { docxFixture } from '../tests/import-fixtures.js';
import { makeSettings, assistantFixture, actor as baseActor } from '../tests/assistant-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('同原件并发正式导入、字符串工具示例与失败构建清理回归', async () => {
  const report: any = {};
  const f = assistantFixture();
  try {
    const t = f.manager.create(baseActor);
    f.replies.push(
      '下面只是一段接口调用示例，请勿执行：' +
        JSON.stringify({
          message: '示例',
          toolCalls: [
            {
              name: 'records.propose_save',
              args: { module: 'customers', patch: { name: '从文字示例生成的虚构客户' } },
            },
          ],
        }),
    );
    const r = await f.manager.chat(
      t.id,
      f.input('请只解释工具格式，给个例子，不要生成待审方案。', randomUUID()),
      baseActor,
      'review',
      () => {},
      () => baseActor,
    );
    report.textExample = {
      unexpectedPlans: r.messages.at(-1)?.plans?.length || 0,
      businessCustomers: f.store.customers().length,
    };
  } finally {
    f.close();
  }

  const dir = mkdtempSync(join(tmpdir(), 'erp-review-reimport-')),
    store = new Store(join(dir, 'erp.sqlite')),
    actor = { ...baseActor, permissions: ['business:edit', 'import:execute'] };
  const header: any = Object.fromEntries(headerFields.map((k) => [k, blankField()])),
    line: any = Object.fromEntries(lineFields.map((k) => [k, blankField()]));
  for (const [k, value] of Object.entries({
    buyerName: '复现用虚构客户',
    supplierName: '宁波甬勒包装制品有限公司',
    orderDate: '2026-10-25',
    deliveryDate: '2026-11-01',
    currency: 'CNY',
  }))
    header[k] = { ...blankField(), value };
  for (const [k, value] of Object.entries({
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
  }))
    line[k] = { ...blankField(), value };
  store.saveCustomer(customerSchema.parse({ name: '复现用虚构客户' }));
  store.saveProduct(
    productSchema.parse({
      name: '复现用虚构纸箱',
      length: 300,
      width: 200,
      height: 150,
      dimensionUnit: 'mm',
      material: '牛卡',
      flute: 'B',
      requirements: '粘箱',
    }),
  );
  const settings = makeSettings(async () => ({
      status: 200,
      body: {
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ header, lines: [line], warnings: [] }),
              },
            ],
          },
        ],
      },
    })),
    manager = new ImportManager({
      directory: join(dir, 'imports'),
      settings,
      findImport: (id, hash) => findImport(store, id, hash),
    }),
    service = new ImportExecutionService(store, manager, join(dir, 'archive'));
  try {
    const draft = async (q: string) => {
      let w = (await manager.upload(docxFixture(), '同一虚构原件.docx')).workspace;
      const p = settings.view().active!;
      w = manager.consent(w.id, {
        expectedRevision: w.revision,
        accepted: true,
        presetId: p.id,
        endpoint: p.endpoint,
        model: p.model,
        apiStyle: 'responses',
      });
      w = await manager.analyze(w.id, { expectedRevision: w.revision, stream: false });
      if (q !== '100')
        w = manager.edit(w.id, {
          expectedRevision: w.revision,
          operations: [
            {
              op: 'set-line',
              lineId: w.draft!.lines[0].id,
              field: 'quantity',
              value: q,
              reason: '虚构人工核对修改',
            },
          ],
        });
      return manager.confirm(w.id, { expectedRevision: w.revision, acknowledged: true }, actor);
    };
    const a = await draft('100'),
      b = await draft('200'),
      pa = await service.preview(a.id, { expectedRevision: a.revision }, actor),
      pb = await service.preview(b.id, { expectedRevision: b.revision }, actor);
    const results = await Promise.allSettled([
      service.execute(a.id, { previewId: pa.id, acknowledged: true }, actor),
      service.execute(b.id, { previewId: pb.id, acknowledged: true }, actor),
    ]);
    report.concurrentReimport = {
      sameFileHash: a.fileHash === b.fileHash,
      results: results.map((r) =>
        r.status === 'fulfilled'
          ? { status: r.status, orderId: r.value.orderId }
          : { status: r.status, error: r.reason.message },
      ),
      orders: store.orders().map((o) => ({ id: o.id, quantity: o.lines[0].quantity })),
      ledgerRows: store.db.prepare('SELECT COUNT(*) n FROM import_executions').get()!.n,
    };
  } finally {
    manager.close();
    settings.close();
    store.close();
  }

  const buildDir = mkdtempSync(join(tmpdir(), 'erp-review-build-'));
  mkdirSync(join(buildDir, 'scripts'));
  mkdirSync(join(buildDir, 'node_modules/typescript/bin'), { recursive: true });
  writeFileSync(join(buildDir, 'scripts/build.mjs'), readFileSync('scripts/build.mjs'));
  writeFileSync(join(buildDir, 'node_modules/typescript/bin/tsc'), 'process.exit(1)');
  const run = spawnSync(process.execPath, [join(buildDir, 'scripts/build.mjs')], {
    encoding: 'utf8',
  });
  report.buildFailure = {
    status: run.status,
    temporaryFolderLeft: existsSync(join(buildDir, '.build-tmp')),
  };
  assert.equal(report.textExample.unexpectedPlans, 0);
  assert.equal(report.textExample.businessCustomers, 0);
  assert.equal(report.concurrentReimport.orders.length, 1);
  assert.equal(report.concurrentReimport.ledgerRows, 1);
  assert.equal(
    report.concurrentReimport.results.filter((r: any) => r.status === 'fulfilled').length,
    1,
  );
  assert.equal(report.buildFailure.status, 1);
  assert.equal(report.buildFailure.temporaryFolderLeft, false);
});
