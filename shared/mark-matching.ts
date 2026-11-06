/**
 * 唛头对应产品的匹配规则。原则和订单导入一致：只有料号完全一致且唯一才预选，
 * 其余只列为候选，由人确认。尺寸相同的箱子很多，不能单凭尺寸对应。
 */
export type MarkMatchFields = {
  itemCode?: string | null;
  productName?: string | null;
  cartonLength?: string | number | null;
  cartonWidth?: string | number | null;
  cartonHeight?: string | number | null;
  dimensionUnit?: string | null;
  dimensionBasis?: 'inner' | 'outer' | 'unknown' | null;
};
export type MarkMatchProduct = {
  id: number;
  name: string;
  customerProductCode?: string | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimensionUnit?: string | null;
  archived?: boolean;
};
export type MarkCandidate = {
  id: number;
  name: string;
  /** 只有料号完全一致且唯一时为 true */
  recommended: boolean;
  reasons: string[];
  conflicts: string[];
};

/** 去掉空白、统一大小写和全角符号，只用于比较，不改写保存的内容。 */
export function normalizeCode(value: unknown) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toUpperCase();
}
/** 去掉括号里的套装标记和结尾的修饰，用来发现 999-ES2828(1+1) 与 999-ES2828 这种相近料号。 */
const baseCode = (code: string) => code.replace(/\([^)]*\)/g, '').replace(/[-_/.]+$/, '');

const toMm = (value: unknown, unit: unknown) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === 'mm') return n;
  if (unit === 'cm') return n * 10;
  return null;
};
const sameMm = (a: number, b: number) => Math.abs(a - b) < 0.01;

export function matchMarkToProducts(fields: MarkMatchFields, products: MarkMatchProduct[]) {
  const code = normalizeCode(fields.itemCode),
    name = normalizeCode(fields.productName),
    size = ['cartonLength', 'cartonWidth', 'cartonHeight'].map((k) =>
      toMm((fields as any)[k], fields.dimensionUnit),
    );
  const results: MarkCandidate[] = [];
  for (const p of products) {
    if (p.archived) continue;
    const reasons: string[] = [],
      conflicts: string[] = [];
    const pCode = normalizeCode(p.customerProductCode),
      pName = normalizeCode(p.name);
    let exact = false;
    if (code && (code === pCode || code === pName)) {
      exact = true;
      reasons.push(code === pCode ? '料号完全一致' : '料号和产品名称一致');
    } else if (code && pCode && baseCode(code) === baseCode(pCode)) {
      reasons.push('料号相近，套装标记不同');
    } else if (code && pName && baseCode(code) === baseCode(pName)) {
      reasons.push('料号和产品名称相近');
    }
    if (!exact && name && name === pName) reasons.push('产品名称一致');
    const psize = [p.length, p.width, p.height].map((v) => toMm(v, p.dimensionUnit));
    if (size.every((v) => v !== null) && psize.every((v) => v !== null)) {
      if (size.every((v, i) => sameMm(v!, psize[i]!))) {
        reasons.push(
          fields.dimensionBasis === 'inner'
            ? '内径和产品尺寸一致'
            : fields.dimensionBasis === 'outer'
              ? '外箱尺寸和产品尺寸一致（产品尺寸是否外径需核对）'
              : '尺寸一致（内外径未确认）',
        );
      } else if (reasons.length) {
        conflicts.push('尺寸不同，请核对');
      }
    }
    if (reasons.length)
      results.push({ id: p.id, name: p.name, recommended: exact, reasons, conflicts });
  }
  const exact = results.filter((r) => r.recommended);
  // 多个产品料号都一致就是歧义，一个都不预选。尺寸冲突也不预选。
  for (const r of exact) r.recommended = exact.length === 1 && r.conflicts.length === 0;
  return results.sort(
    (a, b) =>
      Number(b.recommended) - Number(a.recommended) ||
      Number(/料号/.test(b.reasons[0])) - Number(/料号/.test(a.reasons[0])) ||
      a.id - b.id,
  );
}
