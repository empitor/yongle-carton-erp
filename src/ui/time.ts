import { BUSINESS_TIME_ZONE } from '../../shared/core/index';

/*
 * 系统里的时间一律按北京时间显示（工厂在宁波，业务日期也按北京时间算），不跟着浏览器所在的时区走。
 * 时区只在 shared/core 的 BUSINESS_TIME_ZONE（Asia/Shanghai）定一处。
 */

/**
 * 时间显示的几种写法：
 * full 2026/11/14 08:05:03；short 11/14 08:05（列表里省地方）；clock 08:05:03（只看几点）；date 2026-11-14。
 */
export type BeijingTimeFormat = 'full' | 'short' | 'clock' | 'date';

/** 存的时间（ISO 文字或毫秒数）按北京时间写给人看；没有值写“—”，读不出来的原样显示。 */
export function beijingTime(value: unknown, format: BeijingTimeFormat = 'full'): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(typeof value === 'number' || value instanceof Date ? value : String(value));
  if (isNaN(date.valueOf())) return String(value);
  const timeZone = BUSINESS_TIME_ZONE;
  if (format === 'short')
    return date.toLocaleString('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (format === 'clock') return date.toLocaleTimeString('zh-CN', { timeZone });
  if (format === 'date') return date.toLocaleDateString('sv-SE', { timeZone });
  return date.toLocaleString('zh-CN', { timeZone });
}
