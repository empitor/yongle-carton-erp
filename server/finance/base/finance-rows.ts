/**
 * 报表往来这边几处共用的读库行结构：还欠着的往来（openItems）、按分期拆开的到期（dueItems），
 * 只取一个合计数的查询，和“库里一定有的行”读不到时的报错。SQL 片段在 obligation-sql.ts，这里是它们查出来的一行。
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { AppError, one, rows } from '../../core/index.js';

/** openItems 一行：往来整行，加起算日（来源单据的日期，见 obligationBaseDate）和还没核销的余额 */
export const openItemRow = rows.fin_obligations.extend({ base_date: z.string(), balance: z.number() });

const obligation = rows.fin_obligations.shape;
/** dueItems 一行：一笔往来（有分期的按期拆开）还欠多少、哪天到期；installment_id 没分期是 0 */
export const dueItemRow = z.object({
  id: obligation.id,
  kind: obligation.kind,
  party_id: obligation.party_id,
  party_name: obligation.party_name,
  date: obligation.date,
  installment_id: z.number(),
  due_date: z.string().nullable(),
  balance: z.number(),
});

const sum = z.object({ n: z.number() });
/**
 * 只取一个数的合计（SELECT coalesce(sum(…),0) AS n …，可以是负数）。聚合查询总有一行；
 * 没有行说明 SQL 写错了，报错。非负整数的计数用 core 的 count。
 */
export function sumOf(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return expectRow(one(db, sum, sql, ...params), '合计').n;
}

/** 库里一定有的行（建库预置的、同一个事务里刚写进去的）：读不到说明库坏了，报 500，不往下走 */
export function expectRow<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new AppError(what + '在库里读不到，请联系维护人员。', 500);
  return value;
}
