import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../server/db.js';
import { acquireLock } from '../server/lock.js';
test('备份和恢复演练：数据可恢复，旧库保留，运行中恢复及损坏备份被拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carton-erp-restore-')),
    dbPath = join(dir, 'data', 'erp.sqlite');
  const maintenance = resolve('server/maintenance.ts');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), maintenance, ...args], {
      cwd: dir,
      env: { ...process.env, DB_PATH: dbPath },
      encoding: 'utf8',
    });
  try {
    let store = new Store(dbPath);
    store.saveCustomer({ name: '备份前虚构客户', contact: '', phone: '', address: '', notes: '' });
    store.close();
    const backup = run('backup');
    assert.equal(backup.status, 0, backup.stderr + backup.stdout);
    const file = join(dir, 'backups', readdirSync(join(dir, 'backups'))[0]);
    store = new Store(dbPath);
    store.saveCustomer({ name: '备份后虚构客户', contact: '', phone: '', address: '', notes: '' });
    store.close();
    const unlock = acquireLock(dbPath);
    try {
      assert.equal(run('restore', file).status, 1);
    } finally {
      unlock();
    }
    const restored = run('restore', file);
    assert.equal(restored.status, 0, restored.stderr + restored.stdout);
    store = new Store(dbPath);
    assert.equal(store.customers().length, 1);
    assert.equal(store.customers()[0].name, '备份前虚构客户');
    store.close();
    assert.ok(readdirSync(join(dir, 'data')).some((x) => x.includes('before-restore')));
    const broken = join(dir, 'broken.sqlite');
    writeFileSync(broken, 'broken data');
    assert.equal(run('restore', broken).status, 1);
    store = new Store(dbPath);
    assert.equal(store.customers().length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('示例数据仅允许导入空库，重复执行不会覆盖记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carton-erp-seed-')),
    dbPath = join(dir, 'erp.sqlite');
  const run = () =>
    spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), resolve('server/seed.ts')],
      { cwd: dir, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' },
    );
  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.equal(run().status, 1);
    const store = new Store(dbPath);
    assert.equal(store.customers().length, 3);
    assert.equal(store.orders().length, 6);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
