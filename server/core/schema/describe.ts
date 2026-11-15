import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { many, one, pragmaInteger } from '../sql.js';
import { seededTables } from './create.js';

type Row = Record<string, unknown>;
export type SchemaDescription = {
  applicationId: number;
  autoVacuum: number;
  /** 版本记录里的版本号，从小到大（不含时间） */
  versions: number[];
  tables: Record<
    string,
    {
      sql: string;
      strict: boolean;
      withoutRowid: boolean;
      /** PRAGMA table_xinfo，按列顺序 */
      columns: Row[];
      /** PRAGMA foreign_key_list */
      foreignKeys: Row[];
      /** PRAGMA index_list 加每个索引的 index_xinfo，按索引名排序；自动索引（主键、UNIQUE）也在里面 */
      indexes: { name: string; unique: boolean; origin: string; partial: boolean; columns: Row[] }[];
    }
  >;
  /** 手工建的索引、触发器、视图：名字对应规范化后的建立语句 */
  indexes: Record<string, string>;
  triggers: Record<string, string>;
  views: Record<string, string>;
  /** 带预置数据的表的全部行（按 rowid） */
  seed: Record<string, Row[]>;
};

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const plain = (value: unknown) =>
  value instanceof Uint8Array ? 'hex:' + Buffer.from(value).toString('hex') : typeof value === 'bigint' ? Number(value) : value;
const plainRow = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, plain(value)]));
const rows = (db: DatabaseSync, sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args).map(plainRow);
const objectRow = z.object({ type: z.string(), name: z.string(), sql: z.string().nullable() });
const tableListRow = z.object({ wr: z.number(), strict: z.number() });
const indexListRow = z.object({ name: z.string(), unique: z.number(), origin: z.string(), partial: z.number() });
const versionRow = z.object({ version: z.number() });

/**
 * 建立语句规范化：去掉空白和标识符上的引号、转小写，单引号字符串里的内容原样保留。
 * 这样排版不同、ALTER 改名后带上引号的写法（"products"）不算差别，默认值和 CHECK 里的文字有差别照样看得出来。
 */
export function normalizeSql(sql: string) {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      let end = i + 1;
      while (end < sql.length && (sql[end] !== "'" || sql[end + 1] === "'")) end += sql[end] === "'" ? 2 : 1;
      out += sql.slice(i, end + 1);
      i = end;
    } else if (!/[\s"`]/.test(ch)) out += ch.toLowerCase();
  }
  return out;
}

/** 把一个库的结构读成可以直接比较的对象：只读，不改任何东西。SQLite 自己的内部表（sqlite_ 开头）不算。 */
export function describeSchema(db: DatabaseSync): SchemaDescription {
  const objects = many(db, objectRow, "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
  const named = (type: string) =>
    Object.fromEntries(
      objects.flatMap((object) => (object.type === type && object.sql ? [[object.name, normalizeSql(object.sql)]] : [])),
    );
  const tables: SchemaDescription['tables'] = {};
  for (const object of objects.filter((item) => item.type === 'table')) {
    const name = object.name;
    const list = one(db, tableListRow, 'SELECT wr,strict FROM pragma_table_list WHERE name=?', name);
    tables[name] = {
      sql: normalizeSql(object.sql ?? ''),
      strict: list?.strict === 1,
      withoutRowid: list?.wr === 1,
      columns: rows(db, 'PRAGMA table_xinfo(' + quote(name) + ')'),
      foreignKeys: rows(db, 'PRAGMA foreign_key_list(' + quote(name) + ')'),
      indexes: many(db, indexListRow, 'PRAGMA index_list(' + quote(name) + ')')
        .map((index) => ({
          name: index.name,
          unique: index.unique === 1,
          origin: index.origin,
          partial: index.partial === 1,
          columns: rows(db, 'PRAGMA index_xinfo(' + quote(index.name) + ')'),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
  }
  const versionColumn =
    tables.schema_migrations?.columns.some((column) => column.name === 'version') ?? false;
  return {
    applicationId: pragmaInteger(db, 'application_id'),
    autoVacuum: pragmaInteger(db, 'auto_vacuum'),
    versions: versionColumn
      ? many(db, versionRow, 'SELECT version FROM schema_migrations ORDER BY version').map((row) => row.version)
      : [],
    tables,
    indexes: named('index'),
    triggers: named('trigger'),
    views: named('view'),
    seed: Object.fromEntries(
      seededTables
        .filter((table) => tables[table] && !tables[table].withoutRowid)
        .map((table) => [table, rows(db, 'SELECT * FROM ' + quote(table) + ' ORDER BY rowid')]),
    ),
  };
}

/**
 * 结构指纹：只算表、列、约束、索引、触发器、视图，不算数据、版本记录和文件设置。
 * 恢复备份时拿它和当前程序新建的结构比，认出被数据库工具改过结构的库。
 */
export function schemaFingerprint(description: SchemaDescription) {
  const { tables, indexes, triggers, views } = description;
  const sorted = (value: Record<string, unknown>) =>
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]);
  return createHash('sha256')
    .update(JSON.stringify([sorted(tables), sorted(indexes), sorted(triggers), sorted(views)]))
    .digest('hex');
}
