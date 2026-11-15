import { z } from 'zod';

// 数量统一存成千分整数（1 只 = 1000），不用浮点。全系统都用，放在基础层。
const quantityPattern = /^(0|[1-9]\d{0,8})(\.\d{1,3})?$/;
/** 数量最多几位小数；一只（一张）是多少个千分之一：数量和千分整数互换、看是不是整张都按它 */
export const QUANTITY_DECIMALS = 3;
export const UNITS_PER_QUANTITY = 1000;
/**
 * 数量文字。没填（没给、null、空串或只有空格）统一报“请填写数量”；别的非法值照旧：
 * 写法不对报“数量使用非负数字，最多3位小数”，数字、对象等别的类型用默认提示。
 */
export const quantityText = z
  .string({ error: (issue) => (issue.input == null ? '请填写数量' : undefined) })
  .trim()
  // 空了就只报这一句，后面的格式、大于零不再跟着报
  .refine((v) => v !== '', { message: '请填写数量', abort: true })
  .regex(quantityPattern, '数量使用非负数字，最多3位小数');
// 写法不对的上一步已经报过：这里只看写法对的，不去调 quantityUnits（它遇到非法值会直接抛错，不是校验错误）
export const positiveQuantity = quantityText.refine(
  (v) => !quantityPattern.test(v) || quantityUnits(v) > 0,
  '数量必须大于零',
);
export function quantityUnits(v: string) {
  if (!quantityPattern.test(v.trim()))
    throw new Error('数量格式无效，最多3位小数');
  const [a, b = ''] = v.trim().split('.');
  return Number(BigInt(a) * BigInt(UNITS_PER_QUANTITY) + BigInt(b.padEnd(QUANTITY_DECIMALS, '0')));
}
/**
 * 数量换成千分整数，读不出来时给 fallback（默认 0）：列表、汇总、下一步提示不因为一个格式不对的数报错。
 * 数字（订单明细存的数）按 ×1000 四舍五入；文字（单据里的数量）走 quantityUnits，没填（null、空串、只有空格）当 0。
 * 要拦下格式不对的数量时直接用 quantityUnits，它会报错。
 */
export function safeUnits(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * UNITS_PER_QUANTITY) : fallback;
  try {
    return quantityUnits(String(v ?? '0').trim() || '0');
  } catch {
    return fallback;
  }
}
/** 库存数量（千分整数）能存的上限，和流水表 delta_units 的 CHECK 一致；结余超过它不许记 */
export const MAX_STOCK_UNITS = 999999999999;
/** 千分整数写成数量文字（1500 → “1.5”）；合计可能超出 Number 的，传 bigint */
export function quantityString(n: number | bigint) {
  const s = String(n).padStart(QUANTITY_DECIMALS + 1, '0');
  return (s.slice(0, -QUANTITY_DECIMALS) + '.' + s.slice(-QUANTITY_DECIMALS)).replace(/\.?0+$/, '') || '0';
}
