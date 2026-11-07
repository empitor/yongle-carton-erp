import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/db.js';
import { createFullBackup, restoreFullBackup, validateBusinessDatabase, supportedDatabaseVersions } from '../server/backup.js';
import { customerSchema } from '../shared/domain.js';

function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else result[relative(root, path)] = readFileSync(path).toString('base64');
    }
  };
  walk(root); return result;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'erp-restore-recovery-'));
  const source = join(root, 'source'), target = join(root, 'target');
  const store = new Store(join(source, 'erp.sqlite'));
  store.saveCustomer(customerSchema.parse({ name: '虚构备份客户' }));
  store.close();
  mkdirSync(join(source, 'attachments'));
  writeFileSync(join(source, 'attachments', '虚构.bin'), new Uint8Array([0, 1, 2, 3]));
  const backup = await createFullBackup({ dataDir: source, backupRoot: join(root, 'copies') });
  mkdirSync(join(target, 'old'), { recursive: true });
  writeFileSync(join(target, 'old', '原文件.txt'), '虚构旧内容');
  writeFileSync(join(target, 'erp.sqlite'), '虚构旧数据库字节');
  writeFileSync(join(target, 'erp.sqlite.running'), '虚构运行标记');
  return { root, target, backup, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('恢复中第二次改名失败时，退回所有原文件和运行标记，抛出原错误', async (t) => {
  const f = await fixture();
  const original = fs.renameSync;
  try {
    const before = files(f.target), failure = new Error('虚构第二次改名失败');
    let calls = 0;
    t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      if (++calls === 2) throw failure;
      return original(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => restoreFullBackup(f.backup.dir, f.target), (error) => error === failure);
    assert.equal(calls, 2, '第一项已经切过去后才注入失败');
    assert.deepEqual(files(f.target), before);
    const copy = readdirSync(f.root).find((name) => name.startsWith('target.before-restore-'))!;
    assert.deepEqual(files(join(f.root, copy)), before);
    assert.equal(readdirSync(f.root).some((name) => name.startsWith('target.restore-')), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test('切换清空失败也自动退回；回退再次失败时错误保留原副本位置', async (t) => {
  const f = await fixture(), originalRemove = fs.rmSync, originalCopy = fs.cpSync;
  try {
    const before = files(f.target), failure = new Error('虚构清空失败');
    let removes = 0;
    t.mock.method(fs, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
      if (String(args[0]).startsWith(f.target + sep) && ++removes === 2) throw failure;
      return originalRemove(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => restoreFullBackup(f.backup.dir, f.target), (error) => error === failure);
    assert.deepEqual(files(f.target), before);
    t.mock.restoreAll(); syncBuiltinESMExports();
    t.mock.method(fs, 'renameSync', () => { throw new Error('虚构切换失败'); });
    t.mock.method(fs, 'cpSync', (...args: Parameters<typeof fs.cpSync>) => {
      if (String(args[0]).includes('.before-restore-')) throw new Error('虚构回退失败');
      return originalCopy(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => restoreFullBackup(f.backup.dir, f.target), (error: Error) => {
      assert.match(error.message, /虚构切换失败.*自动回退失败.*before-restore-/);
      const path = error.message.split('原数据副本保留在：')[1];
      assert.deepEqual(files(path), before); return true;
    });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test('迁移缺号即使清单哈希正确也拒绝恢复，不改目标目录', async () => {
  const f = await fixture();
  try {
    const path = join(f.backup.dir, 'erp.sqlite'), db = new DatabaseSync(path);
    db.exec('DELETE FROM schema_migrations WHERE version=5'); db.close();
    const manifestPath = join(f.backup.dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.files.find((file: any) => file.path === 'erp.sqlite').sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const before = files(f.target);
    assert.throws(() => validateBusinessDatabase(path, supportedDatabaseVersions), /迁移版本不连续/);
    assert.throws(() => restoreFullBackup(f.backup.dir, f.target), /迁移版本不连续/);
    assert.deepEqual(files(f.target), before);
    assert.equal(readdirSync(f.root).some((name) => name.startsWith('target.before-restore-')), false);
  } finally { f.close(); }
});

test('正常恢复仍可恢复已有目录和新目录，原副本保留', async () => {
  const f = await fixture();
  try {
    const before = files(f.target);
    const restored = restoreFullBackup(f.backup.dir, f.target);
    assert.deepEqual(files(restored.previous), before);
    assert.equal(existsSync(join(f.target, 'old')), false);
    assert.equal(readFileSync(join(f.target, 'erp.sqlite.running'), 'utf8'), '虚构运行标记');
    const fresh = join(f.root, 'fresh');
    restoreFullBackup(f.backup.dir, fresh);
    assert.deepEqual(readFileSync(join(fresh, 'erp.sqlite')), readFileSync(join(f.backup.dir, 'erp.sqlite')));
  } finally { f.close(); }
});
