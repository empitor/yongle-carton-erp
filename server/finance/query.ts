import { z } from 'zod';
import type { SQLInputValue, DatabaseSync } from 'node:sqlite';
import { centsSchema, requestIdSchema, versionSchema } from '../../shared/finance.js';
import { dateSchema } from '../../shared/domain.js';
import type { FinanceEntry } from '../../shared/finance.js';
import { clampPage } from '../paging.js';
import { financeError } from './core.js';

export const id = z.coerce.number().int().positive();
export const money = centsSchema.positive();
export const label = z.string().trim().min(1).max(200);
export const request = z.strictObject({ requestId: requestIdSchema });
export const edit = request.extend({ version: versionSchema });
export const range = z.object({ from: dateSchema, to: dateSchema }).refine((v) => v.from <= v.to);
export const partyKind = z.enum(['receivable', 'payable']);
export const partyId = z.string().trim().min(1).max(100);
export const listQuery = z.object({
  page: id.default(1),
  pageSize: id.max(200).default(50),
  sort: z.enum(['newest', 'recent', 'oldest']).default('newest'),
});
export function pageSql(
  db: DatabaseSync,
  sql: string,
  values: SQLInputValue[],
  raw: unknown,
  order: string,
) {
  const q = listQuery.parse(raw);
  const total = Number(db.prepare('SELECT count(*) AS n FROM (' + sql + ')').get(...values)?.n);
  const page = clampPage(q.page, q.pageSize, total);
  const direction = q.sort === 'oldest' ? 'ASC' : 'DESC';
  const ordering = order
    .split(',')
    .map((field) => field + ' ' + direction)
    .join(',');
  const rows = db
    .prepare('SELECT * FROM (' + sql + ') ORDER BY ' + ordering + ' LIMIT ? OFFSET ?')
    .all(...values, q.pageSize, (page - 1) * q.pageSize);
  return { rows, page, pageSize: q.pageSize, filteredRecords: total };
}
export function row(db: DatabaseSync, table: string, key: number) {
  const result = db.prepare('SELECT * FROM ' + table + ' WHERE id=?').get(key);
  if (!result) financeError('财务记录不存在。', 404);
  return { ...result };
}
export function entry(
  accountCode: string,
  debit: number,
  credit: number,
  auxiliary: FinanceEntry['auxiliary'] = null,
  cashFlow: string | null = null,
  description = '',
): FinanceEntry {
  return { accountCode, debit, credit, auxiliary, cashFlow, description };
}
export function safeCents(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
    financeError('金额超出可精确保存的范围。');
  return Number(value);
}
export function proportion(amount: number, numerator: number, denominator: number) {
  if (denominator <= 0 || numerator < 0) financeError('无有效分摊基数。');
  return safeCents(
    (2n * BigInt(amount) * BigInt(numerator) + BigInt(denominator)) / (2n * BigInt(denominator)),
  );
}
export function endOfMonth(period: string) {
  const [year, month] = period.split('-').map(Number);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return period + '-' + String(day).padStart(2, '0');
}
export function adjacentPeriod(period: string, offset: number) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7);
}
