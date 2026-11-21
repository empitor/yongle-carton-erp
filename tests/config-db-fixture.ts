// 配置库升级、备份、换回测试共用的准备：临时目录、用原始 SQL 造库文件、一个带两步升级的虚构便签库。只用虚构数据。
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { SNAPSHOT_DIRECTORY, type UpgradeStep } from '../server/core/schema/index.js';
import type { VersionedSqliteSpec } from '../server/core/versioned-sqlite-spec.js';

export const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 临时目录和里面的 notes.sqlite（还没建），用完 done() */
export function configWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-config-db-'));
  return { dir, file: join(dir, 'notes.sqlite'), done: () => rmSync(dir, { recursive: true, force: true }) };
}
/** 用原始 SQL 造（或往里写）一个库文件 */
export function runSql(file: string, sql: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
/** 只读打开一个库文件，读完就关 */
export function readDb<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
export const userVersion = (file: string) => readDb(file, (db) => Number(db.prepare('PRAGMA user_version').get()?.user_version));
/** 一张表的全部行（按 rowid），展开成普通对象才能和字面量比较 */
export const tableRows = (file: string, table: string) =>
  readDb(file, (db) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row })));
/** 库文件旁边放升级前备份的目录 */
export const snapshotDir = (file: string) => join(file, '..', SNAPSHOT_DIRECTORY);
/** 库文件旁边 snapshots/ 里的文件名（没有这个目录就是空的） */
export function snapshotNames(file: string) {
  const dir = snapshotDir(file);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}
/** 升级成功时机制会打一行日志：测试里收起来，需要时可以看打了什么 */
export const quietLog = (t: TestContext) => t.mock.method(console, 'log', () => {});

/** 虚构便签库第 1 版（基线）：只有 notes(id, body) */
export const notesBaseline = 'CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT NOT NULL); PRAGMA user_version=1;';
/** 第 2 步给 notes 加置顶列，正文以“置顶”开头的回填 1；第 3 步建 tags 表（外键指向 notes） */
export const noteSteps: UpgradeStep[] = [
  {
    version: 2,
    name: '虚构：便签加置顶',
    up: (db) =>
      db.exec(`ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
        UPDATE notes SET pinned=1 WHERE body LIKE '置顶%';`),
  },
  {
    version: 3,
    name: '虚构：建标签表',
    up: (db) => db.exec('CREATE TABLE tags(note_id INTEGER NOT NULL REFERENCES notes(id),tag TEXT NOT NULL)'),
  },
];
/** 虚构便签库的规格：基线第 1 版，两步升到第 3 版；create 是第 3 版的完整结构 */
export const notesSpec = (override: Partial<VersionedSqliteSpec> = {}): VersionedSqliteSpec => ({
  label: '虚构便签库',
  baseline: 1,
  steps: noteSteps,
  create(db) {
    db.exec(`CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE tags(note_id INTEGER NOT NULL REFERENCES notes(id),tag TEXT NOT NULL);`);
  },
  ...override,
});
/** “旧程序”眼里的虚构便签库：只认第 1 版 */
export const notesSpecV1 = notesSpec({
  steps: [],
  create: (db) => db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT NOT NULL)'),
});
/** 第 1 版的便签库，里面两条虚构便签：一条以“置顶”开头 */
export function notesV1(file: string) {
  runSql(file, notesBaseline + " INSERT INTO notes(id,body) VALUES(1,'置顶：虚构便签'),(2,'虚构普通便签');");
}
