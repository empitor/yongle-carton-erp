import { z } from 'zod';
import type { SQLInputValue, DatabaseSync } from 'node:sqlite';
import { centsSchema, requestIdSchema, versionSchema } from '../../../shared/finance/index.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, dateSchema } from '../../../shared/core/index.js';
import type { FinanceEntry } from '../../../shared/finance/index.js';
import { clampPage, count, many, one, rows as tableRows } from '../../core/index.js';
import { financeError } from './core.js';
import { obligationKinds } from './stored-values.js';

/** 名称、说明这类短文字最多几个字 */
const LABEL_MAX = 200;
/** 列表按状态筛时状态文字最多几个字 */
export const STATUS_FILTER_MAX = 30;

export const id = z.coerce.number().int().positive();
export const money = centsSchema.positive();
export const label = z.string().trim().min(1).max(LABEL_MAX);
export const request = z.strictObject({ requestId: requestIdSchema });
export const edit = request.extend({ version: versionSchema });
export const range = z.object({ from: dateSchema, to: dateSchema }).refine((v) => v.from <= v.to);
export const partyKind = z.enum(obligationKinds);
export const partyId = z.string().trim().min(1).max(100);
const listQuery = z.object({
  page: id.default(1),
  pageSize: id.max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sort: z.enum(['newest', 'recent', 'oldest']).default('newest'),
});
/** 一页列表的查询：每行的结构（rows.x.pick().extend()）、SQL 和参数、按哪几列排（逗号分开，方向按 sort 参数） */
type PagedQuery<S extends z.ZodType> = { schema: S; sql: string; values: SQLInputValue[]; order: string };
/** 财务分页列表的一页：这一页的行、实际页码（超出落到最后一页）、页大小、筛出来的总条数 */
export type FinancePage<T> = { rows: T[]; page: number; pageSize: number; filteredRecords: number };
/** 按 page、pageSize、sort 读一页，每行按结构校验 */
export function pageSql<S extends z.ZodType>(db: DatabaseSync, list: PagedQuery<S>, raw: unknown): FinancePage<z.output<S>> {
  const q = listQuery.parse(raw);
  const total = count(db, 'SELECT count(*) FROM (' + list.sql + ')', ...list.values);
  const page = clampPage(q.page, q.pageSize, total);
  const direction = q.sort === 'oldest' ? 'ASC' : 'DESC';
  const ordering = list.order
    .split(',')
    .map((field) => field + ' ' + direction)
    .join(',');
  const found = many(
    db,
    list.schema,
    'SELECT * FROM (' + list.sql + ') ORDER BY ' + ordering + ' LIMIT ? OFFSET ?',
    ...list.values,
    q.pageSize,
    (page - 1) * q.pageSize,
  );
  return { rows: found, page, pageSize: q.pageSize, filteredRecords: total };
}

type Tables = typeof tableRows;
/** 财务里有 id 列的表 */
type FinanceIdTable = {
  [K in keyof Tables]: K extends `fin_${string}` ? ('id' extends keyof z.output<Tables[K]> ? K : never) : never;
}[keyof Tables];
type FinanceIdRows = Pick<Tables, FinanceIdTable>;
const financeIdRows: FinanceIdRows = tableRows;
/** 按编号取财务表的一行，没有就报“财务记录不存在” */
export function row<K extends FinanceIdTable>(db: DatabaseSync, table: K, key: number): z.output<FinanceIdRows[K]>;
export function row(db: DatabaseSync, table: FinanceIdTable, key: number) {
  // 按表名取生成的行结构校验：返回的就是这张表的一行（上面的签名按表名给出类型）
  const found = one(db, financeIdRows[table], 'SELECT * FROM ' + table + ' WHERE id=?', key);
  if (found === undefined) financeError('财务记录不存在。', 404);
  return found;
}
/** 一条分录（摘要空着；要写摘要的 { ...entry(…), description }） */
export function entry(
  accountCode: string,
  debit: number,
  credit: number,
  auxiliary: FinanceEntry['auxiliary'] = null,
  cashFlow: string | null = null,
): FinanceEntry {
  return { accountCode, debit, credit, auxiliary, cashFlow, description: '' };
}
/** 分页接口一页一页读完（每页最多的条数），导出、报表要全部行时用。 */
export function allPages<T>(
  readPage: (paging: { page: number; pageSize: number }) => { rows: T[]; filteredRecords: number; pageSize?: number },
): T[] {
  const result: T[] = [];
  for (let page = 1; ; page++) {
    const data = readPage({ page, pageSize: MAX_PAGE_SIZE });
    result.push(...data.rows);
    if (page * (data.pageSize ?? MAX_PAGE_SIZE) >= data.filteredRecords) return result;
  }
}
