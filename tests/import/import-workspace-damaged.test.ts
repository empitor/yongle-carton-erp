// 工作区库里有一份对不上结构（server/import/workspace-document.ts）：只坏那一份，系统照常起、别的照常列，坏的那份能删、能清掉
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImportRepository } from '../../server/import/repository.js';
import { StoredDataError, localAdministratorActor } from '../../server/core/index.js';
import { pageActor } from '../support/actor-fixture.js';
import { workspaceRecord } from '../support/import-fixtures.js';
import { importWorkspace, tempDir } from '../support/order-import-fixture.js';

const admin = () => localAdministratorActor({ ...pageActor({ id: 'fictional-admin', name: '虚构管理员', permissions: ['business:edit'] }), role: 'super_admin' });
/** 绕过程序直接改库：删掉一份工作区的某一栏 */
function damage(file: string, id: string, path: string) {
  const raw = new DatabaseSync(file);
  try {
    raw.prepare('UPDATE workspaces SET document=json_remove(document,?) WHERE id=?').run(path, id);
  } finally {
    raw.close();
  }
}

test('库里有一份失败状态的工作区对不上结构：打开工作区库照常，别的照常读，坏的那份读的时候才报、说明里带它的编号', () => {
  const temp = tempDir('erp-workspace-damaged-');
  const file = join(temp.dir, 'workspaces.sqlite');
  let repo = new ImportRepository(file);
  try {
    repo.insert(workspaceRecord({ id: 'fictional-broken', fileHash: 'h1', revision: 0, fileName: '坏.pdf', task: { state: 'failed', error: '虚构失败' } }));
    repo.insert(workspaceRecord({ id: 'fictional-good', fileHash: 'h2', revision: 0, fileName: '好.pdf' }));
    repo.insert(workspaceRecord({ id: 'fictional-no-name', fileHash: 'h3', revision: 0, fileName: '缺名.pdf', task: { state: 'running' } }));
    repo.close();
    damage(file, 'fictional-broken', '$.promptVersion');
    // 重启补错误档案要读的那几栏也坏了一份：跳过它（已记日志），不挡住打开
    damage(file, 'fictional-no-name', '$.fileName');
    repo = new ImportRepository(file);
    assert.equal(repo.get('fictional-good')?.fileName, '好.pdf');
    assert.throws(
      () => repo.get('fictional-broken'),
      (e: unknown) => e instanceof StoredDataError && e.detail.includes('fictional-broken'),
    );
  } finally {
    repo.close();
    temp.remove();
  }
});

test('对不上结构的工作区：列表里单独标出来（编号、版本），别的照常列；永久删除和初始化清空都删得掉', async () => {
  const f = importWorkspace();
  try {
    const good = await f.upload(),
      broken = await f.upload(Buffer.from('%PDF-虚构坏文件'), '坏.pdf');
    damage(join(f.directory, 'workspaces.sqlite'), broken.id, '$.fileName');
    const lists = f.manager.workspaceLists();
    assert.deepEqual(lists.active.map((w) => w.id), [good.id]);
    assert.deepEqual(
      lists.unreadable.map((w) => [w.id, w.revision]),
      [[broken.id, broken.revision]],
    );
    const result = await f.manager.deleteMany({ items: [{ id: broken.id, version: broken.revision }] }, admin());
    assert.deepEqual(result.results.map((r) => r.success), [true]);
    assert.deepEqual(f.manager.workspaceLists().unreadable, []);
    const again = await f.upload(Buffer.from('%PDF-虚构坏文件二'), '坏二.pdf');
    damage(join(f.directory, 'workspaces.sqlite'), again.id, '$.task');
    const cleared = f.manager.deleteAllWorkspaces(admin());
    assert.deepEqual(cleared.failed, []);
    assert.equal(cleared.count, 2);
  } finally {
    f.close();
  }
});

test('写进工作区库前结构对不上是程序自己的错：按服务端错误报（不是“提交的内容不对”），记日志，不写进去', () => {
  const temp = tempDir('erp-workspace-write-');
  const repo = new ImportRepository(join(temp.dir, 'workspaces.sqlite'));
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    assert.throws(
      () => repo.insert(workspaceRecord({ id: 'fictional-bad-write', fileHash: 'h', revision: -1, fileName: '虚构.pdf' })),
      (e: unknown) => e instanceof Error && e.name === 'Error',
    );
    assert.equal(logged.length, 1);
    assert.equal(repo.has('fictional-bad-write'), false);
  } finally {
    console.error = original;
    repo.close();
    temp.remove();
  }
});
