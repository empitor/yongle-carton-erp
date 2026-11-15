import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { one } from '../core/index.js';
import { periodOf } from './days.js';

/** 会计期间（YYYY-MM）的月末日期、前后月份，和业务单据的记账日 */
export function endOfMonth(period: string) {
  const [year, month] = period.split('-').map(Number);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return period + '-' + String(day).padStart(2, '0');
}
export function adjacentPeriod(period: string, offset: number) {
  const [y, m] = period.split('-').map(Number);
  return periodOf(new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString());
}

/**
 * 业务单据（送货、到货、退货冲暂估）的记账日：日期所在月份没结账就用它；结了账记到最早没结账月份的 1 号，
 * 已结账的月份不动。结账按顺序、只能反结最近一个，所以最近一个已结账月份的下一个月一定开着。
 */
export function bookingDate(db: DatabaseSync, date: string) {
  const next = nextOpenPeriod(db);
  return next != null && periodOf(date) < next ? next + '-01' : date;
}

const latestClosed = z.object({ period: z.string().nullable() });
/** 最早没结账的月份：最近一个已结账月份的下个月；一个月都没结过返回 null（由调用方按启用月份算） */
export function nextOpenPeriod(db: DatabaseSync) {
  const latest = one(db, latestClosed, "SELECT max(period) AS period FROM fin_periods WHERE status='closed'")?.period;
  return latest == null ? null : adjacentPeriod(latest, 1);
}
