// 识别列表里的到货原件和到货单（server/import/workspace-store.ts、business-links.ts）：批量认出到货单状态，
// 只重新读取、解除引用已经失效（到货单删了、编号指向别的单据）的工作区。临时目录、内存库、虚构数据。
import { pageActor } from '../support/actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { z } from 'zod';
import { Store } from '../../server/core/index.js';
import { listen } from '../support/http-fixture.js';
import { AiSettingsManager } from '../../server/ai/settings-manager.js';
import { PromptPresetManager } from '../../server/ai/prompt-presets.js';
import { defaultPromptPreset } from '../../server/import/default-prompts/sales-order.js';
import { ImportRepository } from '../../server/import/repository.js';
import { importRouter } from '../../server/import/router.js';
import { ReceiptAi } from '../../server/import/receipt-ai.js';
import { workspaceRecord } from '../support/import-fixtures.js';
import type { Workspace } from '../../server/import/workspace-document.js';
import { importTaskStates } from '../../shared/import/order-draft.js';
import { asDraft, testImports } from '../support/order-import-fixture.js';

const aes = randomBytes(32);

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

const auditor = pageActor({ id: 'audit-misc-fixture', name: '虚构验收员', permissions: ['business:edit'] });

const now = '2026-11-01T00:00:00.000Z';

const sourceIds = Array.from({ length: 6 }, () => randomUUID()),
  missingSourceId = randomUUID();

const workspaceIds = Array.from({ length: 18 }, () => randomUUID());

const hashOf = (i: number) => createHash('sha256').update(workspaceIds[i]).digest('hex');

/** 导入台账：第 1 份工作区自己导入过（SO-虚构-007）；第 2 份的同一原件以前由别的任务导入过（SO-虚构-008，只算历史） */
function seedImports(store: Store) {
  const insert = store.db.prepare(
    'INSERT INTO import_executions(id,source_id,file_hash,fingerprint,order_id,actor_id,created_at,document) VALUES(?,?,?,?,NULL,?,?,?)',
  );
  insert.run('虚构导入-007', workspaceIds[1], hashOf(1), '虚构指纹-007', auditor.id, now, JSON.stringify({ orderId: 7, orderNumber: 'SO-虚构-007' }));
  insert.run('虚构导入-008', randomUUID(), hashOf(2), '虚构指纹-008', auditor.id, now, JSON.stringify({ orderId: 8, orderNumber: 'SO-虚构-008' }));
}

const draft = () => asDraft();

function seedDocuments(store: Store) {
  let numbering = 0;
  const insertDoc = (kind: string, status: string) =>
    Number(
      store.db
        .prepare(
          "INSERT INTO flow_documents(kind,number,date,status,document,actor_id,actor_name,created_at,updated_at,planned_date) VALUES(?,?,?,?,?,?,?,?,?,json_extract(?5,'$.plannedDate'))",
        )
        .run(
          kind,
          'DH-虚构-' + ++numbering,
          '2026-11-01',
          status,
          kind === 'task' ? '{"unit":"只","plannedDate":"2026-11-01"}' : '{"lines":[]}',
          auditor.id,
          auditor.name,
          now,
          now,
        ).lastInsertRowid,
    );
  const draftDoc = insertDoc('arrival', 'draft'),
    confirmedDoc = insertDoc('arrival', 'confirmed'),
    cancelledDoc = insertDoc('arrival', 'cancelled'),
    archivedDoc = insertDoc('arrival', 'confirmed'),
    deletedDoc = insertDoc('arrival', 'draft'),
    taskDoc = insertDoc('task', 'confirmed');
  store.db
    .prepare("INSERT INTO record_lifecycle(entity,record_id,archived_at,actor_id) VALUES('flow_arrival',?,?,?)")
    .run(archivedDoc, now, auditor.id);
  store.db.prepare('DELETE FROM flow_documents WHERE id=?').run(deletedDoc);
  return { draftDoc, confirmedDoc, cancelledDoc, archivedDoc, deletedDoc, taskDoc };
}

function seedSources(store: Store) {
  const sourceDocs = [
    { result: { supplierName: '虚构供应商', lines: [{ name: '纸板' }] } },
    { result: null },
    { result: null, lastError: { state: 'failed', at: now, message: '虚构失败' } },
    { result: { supplierName: '虚构供应商', lines: [] } },
    // 第 5 份原件不在库里：挂着它的工作区按“原件找不到”处理
    null,
    { result: null, lastError: { state: 'cancelled', at: now, message: '虚构取消' } },
  ];
  // 种类只存在 kind 列里，document 里不带
  sourceDocs.forEach((document, i) =>
    document &&
    store.db
      .prepare('INSERT INTO flow_sources(id,kind,file_name,hash,format,bytes,document,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        sourceIds[i],
        'arrival',
        '虚构到货' + i + '.png',
        createHash('sha256').update(sourceIds[i]).digest('hex'),
        'png',
        Buffer.from('虚构'),
        JSON.stringify(document),
        auditor.id,
        now,
      ),
  );
}

function seedWorkspaces(database: string, docs: ReturnType<typeof seedDocuments>) {
  const { draftDoc, confirmedDoc, cancelledDoc, archivedDoc, deletedDoc, taskDoc } = docs;
  // 各种形状的虚构工作区：缺字段、空草稿、到货单各种状态、已删除到货单、非到货单编号、已归档工作区。
  const base = (i: number, extra: Partial<Workspace>) =>
    workspaceRecord({
      id: workspaceIds[i],
      revision: 2,
      fileName: '虚构文件' + i + '.xlsx',
      fileHash: createHash('sha256').update(workspaceIds[i]).digest('hex'),
      size: 1024,
      createdAt: now,
      parsed: { format: 'xlsx' },
      promptVersion: 'audit',
      ...extra,
    });
  const arrival = (i: number, docId: number | null, sourceId: string | null, extra: Partial<Workspace> = {}) =>
    base(i, {
      mode: 'arrival',
      task: { state: 'ready' },
      arrivalDocId: docId,
      arrivalSourceId: sourceId,
      ...extra,
    });
  const rows: Workspace[] = [
    base(0, {}),
    base(1, { draft: draft(), task: { state: 'ready' } }),
    base(2, { draft: draft() }),
    base(3, { mode: 'order' }),
    base(4, { mode: 'order', archived: false }),
    arrival(5, draftDoc, sourceIds[0]),
    arrival(6, confirmedDoc, sourceIds[1]),
    arrival(7, cancelledDoc, sourceIds[2]),
    arrival(8, archivedDoc, sourceIds[3]),
    arrival(9, draftDoc, sourceIds[3]),
    arrival(10, deletedDoc, sourceIds[0]),
    arrival(11, taskDoc, null),
    arrival(12, null, sourceIds[4]),
    arrival(13, null, missingSourceId),
    arrival(14, cancelledDoc, sourceIds[5]),
    base(15, { archived: true, mode: 'arrival', arrivalDocId: deletedDoc }),
    base(16, { task: { state: 'failed', error: '虚构失败' } }),
    base(17, { draft: draft(), history: [{ draft: draft(), changes: [] }] }),

  ];
  const seed = new ImportRepository(database);
  try {
    for (const w of rows) seed.insert(w);
  } finally {
    seed.close();
  }
}

class TestReceiptAi extends ReceiptAi {
  markBusy(id: string) {
    this.busy.set(id, new AbortController());
  }
}

function importsFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-audit-import-misc-')),
    database = join(dir, 'imports', 'workspaces.sqlite'),
    store = new Store(':memory:');
  const docs = seedDocuments(store);
  seedSources(store);
  seedImports(store);
  seedWorkspaces(database, docs);
  const settings = new AiSettingsManager({ protector }),
    receiptPrompts = new PromptPresetManager(':memory:', defaultPromptPreset),
    receiptAi = new TestReceiptAi(store, settings, receiptPrompts),
    // 到货单在不在、锁没锁用业务库自己的判断，只认到货单（server/import/business-links.ts）
    manager = testImports({ directory: join(dir, 'imports'), database, settings, store, receiptAi });
  receiptAi.markBusy(sourceIds[3]);
  return {
    store,
    manager,
    receiptAi,
    stale: [workspaceIds[10], workspaceIds[11]],
    saved() {
      return Object.fromEntries(
        workspaceIds.map((id) => {
          const w = manager.repo.get(id);
          assert.ok(w, id);
          return [
            id,
            {
              revision: w.revision,
              arrivalDocId: w.arrivalDocId ?? null,
              audits: w.audits.map((a) => a.kind),
            },
          ];
        }),
      );
    },
    close() {
      manager.close();
      receiptPrompts.close();
      settings.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type ImportsFixture = ReturnType<typeof importsFixture>;

/** 记录 status() 里重新读取了哪些工作区。 */
function countLoads(f: ImportsFixture) {
  const m = f.manager,
    original = m.load.bind(m),
    loaded: string[] = [];
  m.load = (id: string) => {
    loaded.push(id);
    return original(id);
  };
  return loaded;
}

const importedOrder = z.looseObject({ orderNumber: z.string() });
const listedWorkspaces = z.array(z.looseObject({
  id: z.string(),
  task: z.looseObject({ state: z.enum(importTaskStates) }),
  imported: importedOrder.optional(),
  historyImport: importedOrder.optional(),
  arrivalStatus: z.string().optional(),
  arrivalNumber: z.string().nullable().optional(),
  arrivalDocId: z.number().nullable(),
}));
const listResponse = z.looseObject({ workspaces: listedWorkspaces });

async function getList(f: ImportsFixture) {
  const app = express();
  app.use(
    '/api/ai/imports',
    importRouter(f.manager, () => auditor, f.receiptAi),
  );
  const server = await listen(app);
  try {
    const port = server.port,
      response = await fetch(`http://127.0.0.1:${port}/api/ai/imports`);
    assert.equal(response.status, 200);
    return listResponse.parse(await response.json());
  } finally {
    await server.close();
  }
}

/** 抽查各种形状的工作区在列表里的样子（不带到货状态的接法没有 arrivalStatus、arrivalNumber） */
function spotCheck(workspaces: z.output<typeof listedWorkspaces>, withArrival: boolean) {
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const at = (i: number) => {
    const row = byId.get(workspaceIds[i]);
    assert.ok(row, workspaceIds[i]);
    return row;
  };
  assert.equal(workspaces.length, 17, '已归档工作区不进列表');
  assert.equal(at(0).task.state, 'uploaded');
  const confirmed = at(1).imported;
  const historical = at(2).historyImport;
  assert.ok(confirmed);
  assert.ok(historical);
  assert.equal(confirmed.orderNumber, 'SO-虚构-007');
  assert.equal(historical.orderNumber, 'SO-虚构-008');
  if (!withArrival) return at;
  assert.deepEqual(
    [5, 6, 7, 8, 9, 12, 14].map((i) => at(i).arrivalStatus),
    ['draft', 'confirmed', 'failed', 'confirmed', 'running', 'uploaded', 'cancelled'],
    '待入库、已入库、识别失败、归档的到货单、识别中、唛头原件不当到货原件、识别取消',
  );
  const number = at(5).arrivalNumber;
  assert.ok(typeof number === 'string');
  assert.match(number, /^DH-虚构-/);
  return at;
}

test('识别列表批量认出到货单状态：只重新读取引用已失效的工作区并解除引用、记一笔；再读一次什么都不动', async () => {
  const f = importsFixture();
  try {
    const before = f.saved();
    const loaded = countLoads(f),
      body = await getList(f);
    const at = spotCheck(body.workspaces, true);
    assert.deepEqual([at(10).arrivalDocId, at(11).arrivalDocId], [null, null], '已删除的到货单、指向别的单据的编号都解除');
    assert.deepEqual(loaded.sort(), [...f.stale].sort());
    const saved = f.saved();
    for (const id of workspaceIds) {
      const stale = f.stale.includes(id);
      assert.deepEqual(
        saved[id],
        stale ? { revision: 3, arrivalDocId: null, audits: ['detach-deleted-arrival'] } : before[id],
        id,
      );
    }
    loaded.length = 0;
    const again = await getList(f);
    assert.deepEqual(loaded, []);
    assert.deepEqual(f.saved(), saved);
    assert.deepStrictEqual(again.workspaces, body.workspaces);
  } finally {
    f.close();
  }
});

test('不经路由直接读列表：照样只解除失效的引用', () => {
  const f = importsFixture();
  try {
    const loaded = countLoads(f),
      at = spotCheck(listedWorkspaces.parse(JSON.parse(JSON.stringify(f.manager.status().workspaces))), false);
    assert.deepEqual(loaded.sort(), [...f.stale].sort());
    assert.equal(at(10).arrivalDocId, null);
  } finally {
    f.close();
  }
});
