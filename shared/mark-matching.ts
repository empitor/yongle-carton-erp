/**
 * 唛头对应产品的匹配规则。识别出来的料号、名称、尺寸都是依据，按这个顺序取最强的一档：
 * 料号一致 > 名称一致 > 尺寸一致。这一档只有一个产品、又没有冲突，就自动对应；
 * 同一档有多个（比如两款尺寸相同的箱子）就列为候选，由人选。挂错了可以在产品里移除。
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
  /** 这个产品以前挂过的唛头料号 */
  markCodes?: (string | null | undefined)[];
};
export type MarkCandidate = {
  id: number;
  name: string;
  /** 最强的一档只有它一个、又没有冲突时为 true，可以自动对应 */
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
const plainSize = (values: unknown[]) => {
  const out = values.map((v) => (v === null || v === undefined || v === '' ? NaN : Number(v)));
  return out.every((n) => Number.isFinite(n) && n > 0) ? out : null;
};

export function matchMarkToProducts(fields: MarkMatchFields, products: MarkMatchProduct[]) {
  const code = normalizeCode(fields.itemCode),
    name = normalizeCode(fields.productName),
    size = ['cartonLength', 'cartonWidth', 'cartonHeight'].map((k) =>
      toMm((fields as any)[k], fields.dimensionUnit),
    );
  const plain = plainSize([fields.cartonLength, fields.cartonWidth, fields.cartonHeight]);
  const results: (MarkCandidate & { level: number })[] = [];
  for (const p of products) {
    if (p.archived) continue;
    const reasons: string[] = [],
      conflicts: string[] = [];
    const pCode = normalizeCode(p.customerProductCode),
      pName = normalizeCode(p.name);
    let level = 0;
    if (code && (code === pCode || code === pName)) {
      level = 3;
      reasons.push(code === pCode ? '料号完全一致' : '料号和产品名称一致');
    } else if (code && p.markCodes?.some((c) => normalizeCode(c) === code)) {
      level = 3;
      reasons.push('和这个产品以前的唛头料号一致');
    } else if (code && pCode && baseCode(code) && baseCode(code) === baseCode(pCode)) {
      reasons.push('料号相近，套装标记不同');
    } else if (code && pName && baseCode(code) && baseCode(code) === baseCode(pName)) {
      reasons.push('料号和产品名称相近');
    }
    const relatedCode =
      !!code && !!pCode && (code === pCode || (!!baseCode(code) && baseCode(code) === baseCode(pCode)));
    if (code && pCode && !relatedCode)
      conflicts.push(level === 3 ? '以前的唛头用过这个料号，但和档案料号不同' : '料号不同');
    if (level < 3 && name && name === pName) {
      level = 2;
      reasons.push('产品名称一致');
    }
    const psize = [p.length, p.width, p.height].map((v) => toMm(v, p.dimensionUnit));
    if (size.every((v) => v !== null) && psize.every((v) => v !== null)) {
      if (size.every((v, i) => sameMm(v!, psize[i]!))) {
        level ||= 1;
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
    } else if (plain) {
      // 真实订单常有一边没写单位。数字完全一样也算依据，但不做换算。
      const other = plainSize([p.length, p.width, p.height]);
      if (other && !(fields.dimensionUnit && p.dimensionUnit) && other.every((n, i) => n === plain[i])) {
        level ||= 1;
        reasons.push('尺寸数字一致（有一边没写单位）');
      }
    }
    if (reasons.length)
      results.push({ id: p.id, name: p.name, recommended: false, reasons, conflicts, level });
  }
  // 最强的一档有多个就是歧义，一个都不自动选。有冲突也不自动选。
  const top = Math.max(0, ...results.map((r) => r.level)),
    best = results.filter((r) => r.level === top);
  for (const r of best) r.recommended = top > 0 && best.length === 1 && r.conflicts.length === 0;
  return results
    .sort(
      (a, b) =>
        Number(b.recommended) - Number(a.recommended) || b.level - a.level || a.id - b.id,
    )
    .map(({ level: _level, ...candidate }) => candidate as MarkCandidate);
}
