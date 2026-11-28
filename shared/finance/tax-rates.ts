import { z } from 'zod';
import { readTaxRate } from '../core/index.js';

/*
 * 财务怎么认税率，只这一处，服务端（补扫、往来条款、补税率校验）和财务页面（补税率窗口、来源单据详情）都引它：
 * - 人填的和往来单位默认的税率（往来条款、补税率）：百分数文字，最多三位整数、六位小数、不超过 100，末尾可以带 %；
 *   输入框都带 % 单位，0.5 就是 0.5%。
 * - 单据抄来的税率（送货、到货明细上的）：照订单的认法 readTaxRate（没带 % 的 0.13 有歧义、最多两位小数），
 *   而且只认半角写法（算金额只算半角），升级前抄进快照的全角、中间带空格的算没写清。
 */

/** 比例写成百分数文字：最多三位整数、六位小数（“13”“0.5”“36.5”），算的时候放大成整数 */
const PERCENT_DECIMALS = 6;
export const PERCENT_SCALE = 10n ** BigInt(PERCENT_DECIMALS);
/** 100% 放大以后的整数 */
export const HUNDRED_PERCENT = BigInt(100) * PERCENT_SCALE;
export function percent(v: string) {
  const [a, b = ''] = v.split('.');
  return BigInt(a + b.padEnd(PERCENT_DECIMALS, '0'));
}
export const percentage = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,6})?$/)
  .refine((v) => /^\d{1,3}(\.\d{1,6})?$/.test(v) && percent(v) <= HUNDRED_PERCENT);

/**
 * 人填的税率文字（往来单位的默认税率、补税率）：去掉末尾的 % 以后照 percentage 认。
 * 返回不收的原因：写法不对是 format，写法对、超过 100% 是 range；收下是 null。
 */
export function taxRateProblem(text: string): 'format' | 'range' | null {
  const checked = percentage.safeParse(text.replace(/%$/, ''));
  if (checked.success) return null;
  // percentage 写法不对时带 invalid_format（上限那条也跟着不过），只差上限的只有上限那一条
  return checked.error.issues.some((issue) => issue.code === 'invalid_format') ? 'format' : 'range';
}
/** 往来单位的默认税率（往来条款的 taxRate；补扫、补税率窗口认往来默认税率也用它） */
export const partyTaxRate = z
  .string()
  .trim()
  .refine((v) => taxRateProblem(v) === null);

/** 单据抄来的税率：半角的百分数，最多三位整数、两位小数，末尾可以带 % */
const DOCUMENT_RATE = /^\d{1,3}(\.\d{1,2})?%?$/;
/** 单据抄来的税率财务认得出时的万分比；认不出（含全角、中间带空格的老写法）是 null。首尾空白不算 */
export function documentTaxRate(text: string): number | null {
  const rate = text.trim();
  return DOCUMENT_RATE.test(rate) ? readTaxRate(rate) : null;
}
/**
 * 一行的税率财务认不认（补扫判断写清了没有；补税率窗口据此决定预不预填），按从哪来分开认：
 * 往来单位默认的（source 是 party）照往来条款 partyTaxRate，别的（单据抄来的）照 documentTaxRate。
 */
export function financeTaxRateReady(rate: string, source: string | null | undefined) {
  return source === 'party' ? partyTaxRate.safeParse(rate).success : documentTaxRate(rate) !== null;
}
