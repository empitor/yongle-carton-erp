/**
 * 数量单位：产品和成品只有“只”（“个”就是“只”，没写也是“只”），原材料（纸板）只有“张”。
 * 写入时统一存成这两个，库里不会有别的写法。
 * 别的单位（箱、套、公斤……）一律拒收，也不换算，提示人先换算成只或张再填。
 */
export const FINISHED_UNIT = '只';
export const RAW_UNIT = '张';

const finishedAliases = new Set(['', FINISHED_UNIT, '个', 'pcs', 'pc']);

/** 产品、成品的单位：“个”、空单位、pcs 都是“只”；别的原样返回（由校验拦下）。 */
export function finishedUnit(unit: unknown): string {
  const s = String(unit ?? '').trim();
  return finishedAliases.has(s.toLowerCase()) ? FINISHED_UNIT : s;
}

/** 原材料的单位：空单位是“张”；别的原样返回（由校验拦下）。 */
export function rawUnit(unit: unknown): string {
  const s = String(unit ?? '').trim();
  return s === '' ? RAW_UNIT : s;
}

export function stockUnit(kind: 'raw' | 'finished' | string, unit: unknown): string {
  return kind === 'raw' ? rawUnit(unit) : finishedUnit(unit);
}

export const finishedUnitMessage = '产品和成品的数量单位只有“只”（“个”也按“只”）；别的单位请先换算成只再填。';
export const rawUnitMessage = '原材料的数量单位只有“张”；别的单位请先换算成张再填。';
