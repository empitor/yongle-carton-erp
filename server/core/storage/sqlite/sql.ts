import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { StoredDataError } from '../../http/errors.js';

/*
 * 读库的几个小函数：查出来的行用 zod 结构校验后再交出去，类型跟着结构走，不在用处断言。
 * 行结构由建表生成（schema/rows.ts 的 rows）；别名、联表、聚合在调用处用 rows.x.pick({…}).extend({…}) 组。
 * SQL 的别名写错、LEFT JOIN 出来的空值没写成可空、库里的值不合结构，跑到这一句就抛 StoredDataError（回 500、记日志），
 * 不会带着错的类型往下走，也不会被当成“用户填错了”。
 */

/** SQL 写进日志时最多留多少字 */
const SQL_IN_LOG = 300;

/**
 * 校验从库里读出来的值（一行、或 JSON 列解析出来的内容）：不合结构抛 StoredDataError。
 * where 说明读的是什么（SQL，或“flow_documents.document 第 12 行”这类），写进日志和出错记录。
 */
function parseStored<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const rules = result.error.issues.map((issue) => (issue.path.length ? issue.path.join('.') : '（整体）') + '：' + issue.message);
  const error = new StoredDataError('库里的数据和结构对不上：' + where.slice(0, SQL_IN_LOG) + '；' + rules.join('；'));
  console.error('[库里的数据] ' + error.detail);
  throw error;
}

/**
 * 库里存成 JSON 文字的列（单据内容、成本估算、权限……）：解析再按结构校验。
 * 不是合法 JSON 也抛 StoredDataError（不让 JSON.parse 的 SyntaxError 被出错处理当成“提交的 JSON 格式错误”回 400）。
 */
export function parseStoredJson<S extends z.ZodType>(schema: S, text: string, where: string): z.output<S> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    const error = new StoredDataError('库里的 JSON 解析不了：' + where + '；' + (e instanceof Error ? e.message : String(e)));
    console.error('[库里的数据] ' + error.detail);
    throw error;
  }
  return parseStored(schema, value, where);
}

/** 查一行：查不到返回 undefined，查到了按结构校验 */
export function one<S extends z.ZodType>(
  db: DatabaseSync,
  schema: S,
  sql: string,
  ...params: SQLInputValue[]
): z.output<S> | undefined {
  const row = db.prepare(sql).get(...params);
  return row === undefined ? undefined : parseStored(schema, row, sql);
}

/** 查多行：每行按结构校验 */
export function many<S extends z.ZodType>(db: DatabaseSync, schema: S, sql: string, ...params: SQLInputValue[]): z.output<S>[] {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => parseStored(schema, row, sql));
}

/** 有没有这样的行（SELECT 1 FROM … WHERE …） */
export function exists(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).get(...params) !== undefined;
}

const integer = z.number().int();
/** 读一个值是整数的 PRAGMA（user_version、application_id、auto_vacuum、freelist_count、schema_version……） */
export function pragmaInteger(db: DatabaseSync, name: string) {
  const row = db.prepare('PRAGMA ' + name).get();
  if (row === undefined) throw new Error('PRAGMA ' + name + ' 没有返回值');
  return parseStored(integer, Object.values(row)[0], 'PRAGMA ' + name);
}

/** 完整性检查（PRAGMA quick_check、integrity_check）：只回一行“ok”才算没坏，有问题时每个问题一行 */
const checkRow = z.record(z.string(), z.string());
export function integrityPassed(db: DatabaseSync, check: 'quick_check' | 'integrity_check') {
  const result = many(db, checkRow, 'PRAGMA ' + check);
  return result.length === 1 && result[0][check] === 'ok';
}

const counted = z.number().int().nonnegative();
/** 数一数（SELECT count(*) FROM …）：取第一列。查询没返回行说明 SQL 写错了（count 总有一行），报错 */
export function count(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  const row = db.prepare(sql).get(...params);
  if (row === undefined) throw new Error('count 的查询没有返回行：' + sql);
  return parseStored(counted, Object.values(row)[0], sql);
}
