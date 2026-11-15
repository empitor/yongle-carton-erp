import { normalizeDimensionUnit, normalizedDimensions } from '../core/index.js';

/** 原材料比对时看的几项（库存品档案、采购明细、到货明细里的字段） */
type RawStockIdentity = {
  name?: string | null;
  specification?: string | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimensionUnit?: unknown;
  material?: string | null;
  flute?: string | null;
};

/** 文字比较前统一写法：全角半角统一（NFKC）、去首尾空白、中间连续空白并成一个、字母不分大小写；null、undefined 和空串一样 */
const plain = (v: unknown) =>
  String(v ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

/** 规格那几项（不含名称）规范化以后的样子，rawSpecKey、rawStockKey 共用 */
function specParts(item: RawStockIdentity) {
  const dimensions = normalizedDimensions(item),
    sized = dimensions.some((n) => n !== null);
  return [
    plain(item.specification),
    plain(item.material),
    plain(item.flute),
    sized && normalizeDimensionUnit(item.dimensionUnit) ? 'mm' : null,
    dimensions,
  ];
}

/*
 * “是不是同一种原材料”全项目只有这一套判断（规范化规则见 plain、specParts）：
 * - 文字（名称、规格说明、材质、楞型）：全角半角统一、去首尾空白、中间空白并成一个、不分大小写，空值和空串一样；
 * - 尺寸：写了尺寸单位的换成毫米再比（120 cm 和 1200 mm 一样，1200 和 1200.0 一样）；没写单位的不换算，
 *   和写了单位的算不同；长宽高都没填时尺寸单位不算数；
 * - 备注、数量单位不算（原材料只有“张”）。
 */

/**
 * 规格是不是一样（不比名称）：选了库存品的到货行、关联了库存品的采购明细、到货行和采购明细之间，
 * 都用它判断“是不是同一种纸板”（server/flow/service.ts、server/operations/service.ts）。
 */
function rawSpecKey(item: RawStockIdentity): string {
  return JSON.stringify(specParts(item));
}
export function sameRawSpec(a: RawStockIdentity, b: RawStockIdentity): boolean {
  return rawSpecKey(a) === rawSpecKey(b);
}

/**
 * 原材料查重键（规格加上名称）：同名、同规格的原材料只能有一个（归档的也算）。名称不同就是不同的货
 * （同材质、不同质量的纸板可以靠名称区分）。服务端保存前按它查重（server/operations/service.ts 的 saveItem），
 * 到货没选库存品时按它找已有的（rawStockFor），算出来的值同时存进 stock_items.raw_key，库上的唯一索引兜底。
 */
export function rawStockKey(item: RawStockIdentity): string {
  return JSON.stringify([plain(item.name), ...specParts(item)]);
}
