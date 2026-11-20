import { RAW_UNIT } from '../core/index.js';
import { displayAmount, plainPrice, type SpecFields } from '../core/index.js';
import { formatStockSize } from './operations.js';

/** 可能没写的文字：资料、识别结果、筛选字段里空着的是 null 或没有 */
export type MaybeText = string | null | undefined;

/**
 * 界面上几样东西的统一写法（列表、详情、弹窗、导出预览都用这里，不各自拼）：
 * 尺寸、纸板 / 成品的规格行、单价和计价方式、金额。以分存的金额用 shared/core 的 centsText。
 */

/** 尺寸：长宽高都不知道时返回空字符串，让调用处自己写“—”或“规格待补充”。 */
export function sizeText(v: Pick<SpecFields, 'length' | 'width' | 'height' | 'dimensionUnit'>) {
  return v.length == null && v.width == null && v.height == null ? '' : formatStockSize(v);
}

const clean = (v: unknown) => (v == null ? '' : String(v).trim());

/** 规格行：规格说明 · 尺寸 · 材质 / 楞型（有什么写什么）。纸板、成品、订货单行都用这一个。 */
export function specLine(v: SpecFields) {
  const spec = clean(v.specification),
    // 规格里已经写了这组尺寸（如“900×700”）就不再重复写一遍
    flat = (t: string) => t.replace(/\s+/g, '').replace(/[xX*✕]/g, '×').toLowerCase(),
    dims = [v.length, v.width, v.height].filter((n) => n != null).join('×'),
    size = dims && spec && new RegExp('(^|[^0-9.])' + flat(dims).replace(/[.]/g, '\\.') + '($|[^0-9.])').test(flat(spec)) ? '' : sizeText(v);
  return [spec, size, [clean(v.material), clean(v.flute)].filter(Boolean).join(' / ')].filter(Boolean).join(' · ');
}

/** 还没定价（单价、金额、产品价格空着）：界面、修改历史、助手都这么说（订货单打印另有说法） */
export const UNPRICED_TEXT = '单价待定';

/**
 * 单价和计价方式：“2.1234 元/m²”“0.73 元/张”；没定价写 UNPRICED_TEXT，计价方式不知道时不猜。
 * 数字按全站单价写法（plainPrice：至少两位、最多四位，尾零去掉；2.7600 → 2.76），不是数字的原样写。
 */
export function priceText(unitPrice: string | number | null | undefined, basis?: string | null, unit?: string | null) {
  if (unitPrice == null || unitPrice === '') return UNPRICED_TEXT;
  const text = String(unitPrice).trim(),
    shown = /^-?\d+(\.\d+)?$/.test(text) ? plainPrice(text) : text;
  if (basis !== 'area' && basis !== 'quantity') return shown + ' 元（计价方式待确认）';
  return shown + ' 元/' + (basis === 'area' ? 'm²' : unit || RAW_UNIT);
}

/** 金额：千分位、两位小数起，多余尾零去掉；算不出来写“待定”。 */
export function amountText(value: string | number | null | undefined) {
  if (value == null || value === '') return '待定';
  try {
    return displayAmount(String(value));
  } catch {
    return '待定';
  }
}

/** 税率和含税方式：“13% 含税”；都没写时“未明确”。订单详情、导入预览、订单明细小字都用它。 */
export function taxText(rate?: string | null, mode?: string | null) {
  const r = clean(rate),
    m = clean(mode);
  if (!r && !m) return '未明确';
  return [/^\d+(\.\d+)?$/.test(r) ? r + '%' : r, m].filter(Boolean).join(' ');
}
