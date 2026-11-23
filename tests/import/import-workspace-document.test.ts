// 工作区库里存的 JSON（server/import/workspace-document.ts）：合法的原样读出、原样写回；缺必有栏目的读到就报错，不默认、不丢
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImportRepository } from '../../server/import/repository.js';
import { StoredDataError } from '../../server/core/index.js';
import { workspaceRecord } from '../support/import-fixtures.js';
import { fixture, recognized, tempDir } from '../support/order-import-fixture.js';

test('带识别结果和改动历史的工作区：读出来保存一次，识别结果和改动历史原样还在', async () => {
  const f = await fixture();
  try {
    const w = await recognized(f);
    const lineId = w.draft?.lines[0].id ?? '';
    f.manager.edit(w.id, {
      expectedRevision: w.revision,
      operations: [{ op: 'set-line', lineId, field: 'quantity', value: '200', reason: '虚构改数量' }],
    });
    const loaded = f.manager.load(w.id),
      draft = structuredClone(loaded.draft),
      history = structuredClone(loaded.history);
    assert.equal(history.length, 1, '改过一次，有一步可撤回');
    f.manager.save(loaded, loaded.revision, 'round-trip');
    const again = f.manager.load(w.id);
    assert.deepEqual(again.draft, draft);
    assert.deepEqual(again.history, history);
  } finally {
    f.close();
  }
});

test('库里的工作区缺必有的栏目（没有文件名、任务是 null）：读单个报 StoredDataError（500），列表里列进读不出来的，不默认、不丢', () => {
  const temp = tempDir('erp-workspace-document-');
  const file = join(temp.dir, 'workspaces.sqlite');
  let repo = new ImportRepository(file);
  try {
    repo.insert(workspaceRecord({ id: 'fictional-no-name', fileHash: 'h1', revision: 0, fileName: '虚构.pdf' }));
    repo.insert(workspaceRecord({ id: 'fictional-null-task', fileHash: 'h2', revision: 0, fileName: '虚构.pdf' }));
    repo.close();
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE workspaces SET document=json_remove(document,'$.fileName') WHERE id=?").run('fictional-no-name');
    raw.prepare("UPDATE workspaces SET document=json_set(document,'$.task',json('null')) WHERE id=?").run('fictional-null-task');
    raw.close();
    repo = new ImportRepository(file);
    const stored = (e: unknown) => e instanceof StoredDataError && e.status === 500;
    const listed = repo.list();
    assert.deepEqual(listed.workspaces, []);
    assert.deepEqual(listed.unreadable.map((w) => w.id).sort(), ['fictional-no-name', 'fictional-null-task']);
    assert.throws(() => repo.get('fictional-no-name'), stored);
    assert.throws(() => repo.get('fictional-null-task'), stored);
  } finally {
    repo.close();
    temp.remove();
  }
});
