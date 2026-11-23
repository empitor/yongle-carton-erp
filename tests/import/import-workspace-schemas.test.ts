// 识别工作区的两份结构：库里存的（server/import/workspace-document.ts）和发给页面的视图（shared/import/workspace-view.ts）。
// 各种状态的工作区读出来原样不丢、视图按页面的结构认过也原样不丢；对不上结构的读到就报错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { StoredDataError } from '../../server/core/index.js';
import type { Workspace } from '../../server/import/workspace-document.js';
import { emptyImportMapping, importWorkspaceViewSchema } from '../../shared/import/index.js';
import { workspaceRecord } from '../support/import-fixtures.js';
import { asDraft, importWorkspace } from '../support/order-import-fixture.js';

/** 工作区编号要是 UUID */
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const draft = asDraft();
const change = { path: 'lines.0.quantity', label: '数量', before: '1000', after: '1200', reason: '虚构', by: 'person' as const };
const importedRef = { orderId: 7, orderNumber: 'XS-虚构-001', executionId: 'exec-1', archived: false, sourceId: 'src-1' };

/** 刚上传、排队、识别中、识别完、识别失败、已导入、已归档、到货识别各一份 */
const states: Workspace[] = [
  workspaceRecord({ id: uid(1), fileHash: 'h1', revision: 0, fileName: '虚构上传.pdf' }),
  workspaceRecord({
    id: uid(2),
    fileHash: 'h2',
    revision: 1,
    task: { state: 'queued', startedAt: '2026-01-01T00:00:01.000Z', position: 2, limit: 3, attempt: 1 },
  }),
  workspaceRecord({
    id: uid(3),
    fileHash: 'h3',
    revision: 1,
    task: { state: 'running', progress: { stage: 'thinking', receivedChars: 10, reasoningChars: 5, elapsedMs: 900 } },
  }),
  workspaceRecord({
    id: uid(4),
    fileHash: 'h4',
    revision: 3,
    draft,
    changes: [change],
    canUndo: true,
    mapping: emptyImportMapping(draft),
    mappingInvalidated: { customer: '虚构客户换了', products: { [draft.lines[0].id]: '虚构产品换了' } },
    task: { state: 'ready' },
    promptPreset: { id: 'p1', name: '虚构预设', revision: 2, hash: 'abc' },
    history: [{ draft, changes: [change] }],
    audits: [{ at: '2026-01-01T00:00:02.000Z', kind: 'edit', revision: 2, changes: [change] }],
  }),
  workspaceRecord({
    id: uid(5),
    fileHash: 'h5',
    revision: 2,
    task: { state: 'failed', error: '虚构失败', failureId: 'f-1', diagnosticStorageError: '虚构写不进' },
  }),
  workspaceRecord({ id: uid(6), fileHash: 'h6', revision: 4, draft, task: { state: 'ready' }, imported: importedRef }),
  workspaceRecord({ id: uid(7), fileHash: 'h7', revision: 2, archived: true, historyImport: { ...importedRef, historical: true } }),
  workspaceRecord({ id: uid(8), fileHash: 'h8', revision: 1, mode: 'arrival', arrivalSourceId: 'arr-src-1' }),
];

test('各种状态的工作区：库里读出来和写进去的一样，发给页面的视图按页面结构认过也一样', () => {
  const f = importWorkspace();
  try {
    for (const w of states) f.manager.repo.insert(w);
    for (const w of states) {
      assert.deepEqual(f.manager.load(w.id), w, `${w.id} 读出来原样`);
      const view = f.manager.get(w.id);
      assert.deepEqual(importWorkspaceViewSchema.parse(view), view, `${w.id} 视图原样`);
    }
  } finally {
    f.close();
  }
});

test('库里的工作区对不上结构（版本号是负数、类型不认识、少了识别规则版本）：读到就报 StoredDataError', () => {
  const f = importWorkspace();
  const file = join(f.directory, 'workspaces.sqlite');
  try {
    const broken = [uid(11), uid(12), uid(13)];
    for (const id of broken) f.manager.repo.insert(workspaceRecord({ id, fileHash: id, revision: 0 }));
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE workspaces SET document=json_set(document,'$.revision',-1) WHERE id=?").run(broken[0]);
    raw.prepare("UPDATE workspaces SET document=json_set(document,'$.mode','invoice') WHERE id=?").run(broken[1]);
    raw.prepare("UPDATE workspaces SET document=json_remove(document,'$.promptVersion') WHERE id=?").run(broken[2]);
    raw.close();
    for (const id of broken) assert.throws(() => f.manager.load(id), StoredDataError, id);
  } finally {
    f.close();
  }
});

test('页面视图的结构：版本号不是非负整数、类型不认识的回答不收', () => {
  const view = importWorkspaceViewSchema.parse(states[0]);
  assert.equal(importWorkspaceViewSchema.safeParse({ ...view, revision: 1.5 }).success, false);
  assert.equal(importWorkspaceViewSchema.safeParse({ ...view, revision: -1 }).success, false);
  assert.equal(importWorkspaceViewSchema.safeParse({ ...view, mode: 'invoice' }).success, false);
});
