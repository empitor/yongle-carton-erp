import { z } from 'zod';

/** 百分数最多两位小数；库里以整数万分比保存。 */
const BP_PER_PERCENT = 100;
const FULLWIDTH_ASCII_OFFSET = 0xfee0;
export const MAX_TAX_PERCENT = 100;
export const TAX_PERCENT_STEP = 1 / BP_PER_PERCENT;
const rateMessage = '请填写 0 到 100 之间、最多两位小数的税率';

export const taxRateSchema = z.number({ error: rateMessage }).min(0, rateMessage).max(MAX_TAX_PERCENT, rateMessage)
  .refine((rate) => percentFromTaxRateBp(taxRateToBp(rate)) === rate, rateMessage);

export const taxRateToBp = (percent: number) => Math.round(percent * BP_PER_PERCENT);
export const percentFromTaxRateBp = (bp: number) => bp / BP_PER_PERCENT;

/** 只认明确的百分数。没写百分号的小数 0 < n < 1 有歧义，保留原文交给人核对。 */
export function readTaxRate(text: string | null | undefined): number | null {
  const normalized = text
    ?.replace(/[０-９％．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULLWIDTH_ASCII_OFFSET))
    .replace(/\s/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?(%)?$/.exec(normalized ?? '');
  if (!match) return null;
  const whole = Number(match[1]), fraction = Number((match[2] ?? '').padEnd(2, '0'));
  if (whole === 0 && fraction > 0 && !match[3]) return null;
  const bp = whole * BP_PER_PERCENT + fraction;
  return bp <= MAX_TAX_PERCENT * BP_PER_PERCENT ? bp : null;
}

/** 提取 taxText 里的税率原话（跳过第 24 步升级记下的“口径：…”行）。 */
const rateText = (text: string | null | undefined) =>
  text?.split('\n').find((line) => !line.startsWith('口径：'))?.trim() ?? '';

/** 显式清空已有规范税率时，清掉原话里可识别的旧税率，保留未识别的税率原话或“口径：…”记录。 */
export function clearRecognizedTaxText(text: string | null | undefined): string | null {
  if (!text?.trim()) return null;
  const kept = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && (line.startsWith('口径：') || readTaxRate(line) === null));
  return kept.length ? kept.join('\n') : null;
}

/** 单据仍留税率文字：0 < 税率 < 1 保留 % 以区别于歧义小数，其余规范率不带 %；空规范率只抄认不出的税率原话（不抄“口径：”行）。 */
export function orderTaxSnapshot(tax: { taxRate?: number | null; taxText?: string | null }) {
  if (tax.taxRate != null) return tax.taxRate > 0 && tax.taxRate < 1 ? `${tax.taxRate}%` : String(tax.taxRate);
  const raw = rateText(tax.taxText);
  return raw && readTaxRate(raw) === null ? raw : undefined;
}

export const shownTaxRate = (rate: number | null | undefined) => rate == null ? '' : rate + '%';

/** 当前税率未填且原话里含认不出的税率文字（纯“口径：…”或可识别旧税率不算未识别税率）。 */
export function hasUnrecognizedTaxRate(text: string | null | undefined, rate?: number | string | null) {
  if (rate != null && rate !== '') return false;
  const raw = rateText(text);
  return Boolean(raw && readTaxRate(raw) === null);
}

export function orderTaxOriginal(text: string | null | undefined, rate?: number | string | null) {
  if (!text?.trim()) return '';
  return hasUnrecognizedTaxRate(text, rate)
    ? `税率没认出来，原件写的是“${rateText(text)}”，请选择或填写税率。`
    : `原件写法：${text}`;
}
