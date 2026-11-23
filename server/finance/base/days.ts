/**
 * 日期文字（YYYY-MM-DD）的推算：加减天数、相差几天、取月份和几号。按 UTC 的公历日算，不受时区影响。
 * 到期日、账期、现结优惠、压款利息、票据到期都用这几个。
 */
import { DAY_MS, ISO_DATE_LENGTH } from '../../../shared/core/index.js';

/** YYYY-MM 有几个字 */
const PERIOD_LENGTH = 7;
/** 几号是日期最后两位 */
const DAY_DIGITS = 2;
/** 一年按 365 天算（利息年化、现结优惠折算年利率、“最多往后看一年”） */
export const DAYS_PER_YEAR = 365;
export const MONTHS_PER_YEAR = 12;
/** 一个月最多 31 天（月结的付款日、截止日最大填 31，月份不够大的取月末） */
export const MAX_DAY_OF_MONTH = 31;

/** 时间点按 UTC 的那一天 */
export const utcDay = (time: Date) => time.toISOString().slice(0, ISO_DATE_LENGTH);

export function shiftDays(date: string, offset: number) {
  const time = new Date(date + 'T00:00:00Z');
  time.setUTCDate(time.getUTCDate() + offset);
  return utcDay(time);
}

/** 从 a 到 b 相差几天（b 早于 a 是负数） */
export function dayDistance(a: string, b: string) {
  return (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS;
}

/** 日期所在的月份（会计期间 YYYY-MM） */
export const periodOf = (date: string) => date.slice(0, PERIOD_LENGTH);

/** 日期或期间所在的年份（YYYY） */
export const yearOf = (date: string) => date.slice(0, 'YYYY'.length);

/** 日期是几号 */
export const dayOf = (date: string) => Number(date.slice(-DAY_DIGITS));
