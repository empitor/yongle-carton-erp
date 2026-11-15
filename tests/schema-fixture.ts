// 业务库结构测试共用的准备：临时目录、当前程序建的库、0.9.0 以前旧库的样子、虚构的升级步骤。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/core/db.js';
import { buildTables, type UpgradeStep } from '../server/core/schema/index.js';
import { customerSchema } from '../shared/core/domain.js';

export const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
/** 读一个 PRAGMA 的值（结果第一列） */
export const one = (db: DatabaseSync, pragma: string) => {
  const row = db.prepare('PRAGMA ' + pragma).get();
  if (!row) throw new Error('PRAGMA ' + pragma + ' 没有结果');
  return Object.values(row)[0];
};
export const versions = (db: DatabaseSync) =>
  db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row.version));
// node:sqlite 返回的行没有原型，展开成普通对象才能和字面量比较
export const rowsOf = (db: DatabaseSync, table: string) =>
  db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all().map((row) => ({ ...row }));
export const quiet = { appVersion: 'test-9.9.9', log: () => {} };

export function workspace(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, path: join(dir, 'erp.sqlite'), close: () => rmSync(dir, { recursive: true, force: true }) };
}
/** 当前程序建的库，里面有一个虚构客户 */
export function currentDatabase(path: string) {
  const store = new Store(path);
  store.saveCustomer(customerSchema.parse({ name: '虚构升级客户' }));
  store.close();
}
/** 0.9.0 以前的旧库的样子：没有 application_id，版本记录只有两列、第 1～19 版 */
export function legacyDatabase(path: string, upTo = 19) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO customers(id,name) VALUES(1,'虚构旧客户');`);
  const record = db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,datetime('now'))");
  for (let version = 1; version <= upTo; version++) record.run(version);
  db.close();
}

/**
 * 虚构的升级步骤，只动自己建的表，外加给一张真表加一列：
 * 21 建父子两张表（子表外键指向父表）并写数据；22 给 customers 加列；23 重建父表（要关掉外键检查才能做）。
 */
export const fictionalSteps: UpgradeStep[] = [
  {
    version: 21,
    name: '虚构：建父子表',
    up: (db) =>
      db.exec(`CREATE TABLE fictional_parents(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE fictional_children(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES fictional_parents(id), note TEXT NOT NULL);
        INSERT INTO fictional_parents(id,name) VALUES(1,'虚构父行');
        INSERT INTO fictional_children(id,parent_id,note) VALUES(1,1,'虚构子行');`),
  },
  {
    version: 22,
    name: '虚构：客户加一列',
    up: (db) => db.exec("ALTER TABLE customers ADD COLUMN fictional_note TEXT NOT NULL DEFAULT '没填'"),
  },
  {
    version: 23,
    name: '虚构：重建父表',
    up: (db) =>
      db.exec(`CREATE TABLE fictional_parents_new(id INTEGER PRIMARY KEY, name TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1);
        INSERT INTO fictional_parents_new(id,name) SELECT id,name FROM fictional_parents;
        DROP TABLE fictional_parents;
        ALTER TABLE fictional_parents_new RENAME TO fictional_parents;`),
  },
];
/**
 * 和 fictionalSteps 配套的建表：当前程序的表，加上三步走完以后的样子（直接建出来和从第 20 版升上来的结构一样）。
 * 传了虚构步骤、又要建新库或核对表结构的，连同它一起传（openBusinessDatabase 的 build）。
 */
export const fictionalBuild = (db: DatabaseSync) => {
  buildTables(db);
  db.exec(`CREATE TABLE fictional_parents(id INTEGER PRIMARY KEY, name TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE fictional_children(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES fictional_parents(id), note TEXT NOT NULL);
    ALTER TABLE customers ADD COLUMN fictional_note TEXT NOT NULL DEFAULT '没填';`);
};
export const failing = (version: number, message: string): UpgradeStep => ({
  version,
  name: '虚构：会失败的一步',
  up: () => {
    throw new Error(message);
  },
});

type Value = string | number | null | Uint8Array;
const shown = (sql: string, args: Value[]) => sql + ' ' + JSON.stringify(args.map((a) => (a instanceof Uint8Array ? 'blob' : a)));
/** 这条写入要被约束拦下（默认是 CHECK；STRICT 的类型不符传 /cannot store/） */
export const rejects = (db: DatabaseSync, sql: string, args: Value[] = [], pattern = /CHECK constraint failed/) =>
  assert.throws(() => db.prepare(sql).run(...args), pattern, shown(sql, args));
export const accepts = (db: DatabaseSync, sql: string, args: Value[] = []) =>
  assert.doesNotThrow(() => db.prepare(sql).run(...args), shown(sql, args));
export const sha = (ch: string) => ch.repeat(64);

/** sqlite_sequence 里每张表用过的最大编号 */
export const counters = (db: DatabaseSync) =>
  new Map(
    db
      .prepare('SELECT name, MAX(seq) AS seq FROM sqlite_sequence GROUP BY name')
      .all()
      .map((row) => [String(row.name), Number(row.seq)] as const),
  );
