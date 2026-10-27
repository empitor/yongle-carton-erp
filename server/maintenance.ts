import { DatabaseSync, backup } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultDbPath } from './db.js';
import { acquireLock } from './lock.js';

function validate(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result = db.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0].integrity_check !== 'ok')
      throw new Error('数据库完整性校验失败');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据关联校验失败');
    if (
      ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(
        Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version),
      )
    )
      throw new Error('不支持此数据库版本');
    for (const table of ['customers', 'products', 'orders', 'order_lines'])
      db.prepare(`SELECT COUNT(*) FROM ${table}`).get();
  } finally {
    db.close();
  }
}
const stamp = () =>
  new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') +
  '-' +
  randomUUID().slice(0, 6);
const action = process.argv[2];
let unlock: (() => void) | undefined;
try {
  if (action === 'backup') {
    if (!existsSync(defaultDbPath)) throw new Error('数据库尚未创建，请先启动服务或导入示例。');
    const file = resolve('backups', `erp-${stamp()}.sqlite`);
    mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(defaultDbPath, { readOnly: true });
    try {
      await backup(db, file);
    } finally {
      db.close();
    }
    validate(file);
    console.log('一致性备份已生成：' + file + '\n请另存一份到其他磁盘。');
  } else if (action === 'restore') {
    if (!process.argv[3]) throw new Error('用法：npm run restore -- "备份文件绝对路径"');
    const source = resolve(process.argv[3]);
    if (source === defaultDbPath) throw new Error('备份路径不能与当前数据库相同');
    validate(source);
    unlock = acquireLock(defaultDbPath);
    const staged = defaultDbPath + '.restore-' + stamp();
    copyFileSync(source, staged);
    validate(staged);
    let previous: string | undefined;
    if (existsSync(defaultDbPath)) {
      const db = new DatabaseSync(defaultDbPath);
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
      previous = defaultDbPath + '.before-restore-' + stamp();
      renameSync(defaultDbPath, previous);
    }
    try {
      renameSync(staged, defaultDbPath);
    } catch (error) {
      if (previous) renameSync(previous, defaultDbPath);
      throw error;
    }
    for (const suffix of ['-wal', '-shm'])
      if (existsSync(defaultDbPath + suffix)) unlinkSync(defaultDbPath + suffix);
    console.log('已恢复并通过完整性检查。' + (previous ? '\n恢复前文件保留在：' + previous : ''));
  } else throw new Error('仅支持 backup / restore');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  unlock?.();
}
