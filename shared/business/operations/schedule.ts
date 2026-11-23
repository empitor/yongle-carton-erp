import { z } from 'zod';
import { ISO_DATE_LENGTH } from '../../core/index.js';

/** 日期文字能写到的最后一年（YYYY 四位） */
const LAST_YEAR = 9999;
/** 排先后时没写日期的当成它（比任何日期都大），排在最后 */
export const NO_DUE_DATE = String(LAST_YEAR);
/** 一天里的时间（HH:mm）：到货、送货的实际时间，生产任务、送货单的计划时间，订货单登记到货的时间；可以不写 */
export const arrivalTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间使用HH:mm格式')
  .nullable()
  .optional();
// 纯日期运算使用UTC，不受浏览器/服务器本地时区和夏令时影响。
export function shiftDate(date: string, days: number) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  if (d.getUTCFullYear() > LAST_YEAR) return LAST_YEAR + '-12-31';
  if (d.getUTCFullYear() < 0) return '0000-01-01';
  return d.toISOString().slice(0, ISO_DATE_LENGTH);
}
/** 单据的计划日：没写计划日的按单据日期 */
export const planDate = (r: { plannedDate?: string | null; date: string }): string => r.plannedDate || r.date;
