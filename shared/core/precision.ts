// 单价按万分之一元计算；不使用浮点乘法计算订单金额。
/** 单价上限：一百万元（和 shared/core/domain.ts 的 exactPriceSchema 同一个数） */
export const MAX_PRICE_YUAN = 1_000_000;
/** 单价的小数位数：单价按万分之一元的整数算 */
export const PRICE_DECIMALS = 4;
/** 一元是多少个万分之一元 */
export const UNITS_PER_YUAN = 10000n;
/** 一分是多少个万分之一元 */
const UNITS_PER_CENT = 100n;
/** 一元是多少分 */
export const CENTS_PER_YUAN = 100n;
/** 单价上限折成万分之一元 */
export const MAX_PRICE_UNITS = BigInt(MAX_PRICE_YUAN) * UNITS_PER_YUAN;
/** 四舍五入的整数除法 (2a + b) / 2b 里的 2：分子分母都乘 2、加上一个 b 再整除，就是加了半个单位 */
const HALVES = 2n;
/**
 * a / b 四舍五入到整数（b 为正）。全站四舍五入的整数除法都用它。
 * 负数按绝对值算再取负（-1.5 → -2，-1.4 → -1）：round(-x) = -round(x)，红字冲销的数和原数加起来正好是零。
 * 大整数除法向零截断，负数直接套 (2a + b) / 2b 会算小一档，所以分开算。
 */
export const roundedQuotient = (a: bigint, b: bigint): bigint => {
  if (b <= 0n) throw new RangeError('除数必须为正');
  return a < 0n ? -roundedQuotient(-a, b) : (HALVES * a + b) / (HALVES * b);
};
export function priceUnits(value: string): bigint {
  if (!/^(0|[1-9]\d{0,6})(\.\d{1,4})?$/.test(value))
    throw new Error('单价必须为非负数，最多四位小数');
  const [a, b = ''] = value.split('.');
  const units = BigInt(a) * UNITS_PER_YUAN + BigInt(b.padEnd(PRICE_DECIMALS, '0'));
  // 正则放到 7 位整数只是为了先认出“是个数”，超过上限的在这里拦
  if (units > MAX_PRICE_UNITS) throw new Error('单价不能超过 ' + MAX_PRICE_YUAN + ' 元');
  return units;
}
export function exactText(units: bigint, scale = PRICE_DECIMALS) {
  const sign = units < 0n ? '-' : '',
    s = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  return sign + s.slice(0, -scale) + '.' + s.slice(-scale);
}
/** 只有分的单价换成精确单价文字（100 → “1.0000”）：整数乘 100 用 BigInt，不经过浮点 */
export const priceFromCents = (cents: number) => exactText(BigInt(cents) * UNITS_PER_CENT);
/** 明细的精确单价文字：有精确价用精确价，没有按分换算 */
export const linePriceExact = (l: { unitPriceCents: number; unitPriceExact?: string }) =>
  l.unitPriceExact ?? priceFromCents(l.unitPriceCents);
/**
 * 导入预览里明细单价给人看的写法（AI 导入页、助手的订单任务卡共用）：有精确单价按全站单价写法（plainPrice），
 * 只有分的按分换成元，都没有写“待定”。
 */
export function linePrice(line: { unitPriceExact?: string | null; unitPriceCents?: number | null }) {
  if (line.unitPriceExact != null) return plainPrice(line.unitPriceExact);
  const cents = line.unitPriceCents;
  if (typeof cents === 'number' && Number.isSafeInteger(cents)) return plainPrice(priceFromCents(cents));
  return '待定';
}
export function precisionTotal(
  lines: { quantity: number; unitPriceCents: number; unitPriceExact?: string }[],
) {
  const units = lines.reduce((s, l) => s + priceUnits(linePriceExact(l)) * BigInt(l.quantity), 0n);
  return {
    units,
    exact: exactText(units),
    cents: Number(roundedQuotient(units, UNITS_PER_CENT)),
    hasFractionalCent: units % UNITS_PER_CENT !== 0n,
  };
}
export function legacyCents(price: string) {
  return Number(roundedQuotient(priceUnits(price), UNITS_PER_CENT));
}
/**
 * 库里的单价只存一份：万分之一元的整数（products.price_e4、order_lines.unit_price_e4）；接口里是元的字符串，固定四位小数。
 * 单价上限一百万元（1e10 个万分之一元），Number 放得下。写入只走这里或“分 × 100”，不用浮点乘。
 */
export const priceToE4 = (value: string) => Number(priceUnits(value));
export const priceFromE4 = (e4: number) => exactText(BigInt(e4));
/** 两个精确单价是不是同一个价：写法不同、数值相同（1.5 和 1.5000）算相同；格式不对的不算相同，留给校验去拦。 */
export function samePrice(a: unknown, b: unknown) {
  try {
    return typeof a === 'string' && typeof b === 'string' && priceUnits(a.trim()) === priceUnits(b.trim());
  } catch {
    return false;
  }
}
/**
 * 改价时补丁的意思（产品参考价、订单明细单价同一条规则；数据管理直接编辑、助手改记录共用）。
 * 改之前先由这里判断，再交给保存（server/sales/record-fields.ts 的 chosenExact）；两处的规则是一套：
 * - 'clear'：精确价点名清空（null、空串；整条记录带回来时把这个键删掉也算，见 exactDropped），“分”没动：
 *   清空价格。产品存成没定价（NULL，不是 0 元）；订单明细单价必填，调用方拒收并提示填写单价。
 * - 'cents'：按“分”存，带回来的旧精确价作废（不然精确价优先，会把新改的分盖掉）。包括：
 *   分点名了、精确价没点名；分改了、精确价还是原来的价（写法不同、数值相同算没动）；精确价清空、分也改了。
 *   分改成 0 的产品就是没定价。
 * - 'keep'：照提交的存：精确价改了（分没动按精确价；两头都改了还对不上由 chosenExact 拒收），或都没动。
 * before 是改之前的记录（新建、新加的明细是 undefined，只会得到 'cents' 或 'keep'）。
 * exactDropped：调用方确认补丁是整条记录带回来的、只少了精确价这个键（数据管理的单条编辑）；
 * 只带改的字段的补丁（助手、批量修改）没点名精确价就是没动它，不能当清空。
 */
export type PriceEdit = 'clear' | 'cents' | 'keep';
export function priceEdit(
  patch: Record<string, unknown>,
  before: Record<string, unknown> | null | undefined,
  keys: { exact: string; cents: string },
  exactDropped = false,
): PriceEdit {
  const exactNamed = Object.hasOwn(patch, keys.exact),
    centsNamed = Object.hasOwn(patch, keys.cents),
    centsChanged = centsNamed && patch[keys.cents] !== before?.[keys.cents],
    blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && !v.trim());
  if (before?.[keys.exact] != null && (exactNamed ? blank(patch[keys.exact]) : exactDropped))
    return centsChanged ? 'cents' : 'clear';
  if (centsNamed && (!exactNamed || (centsChanged && samePrice(patch[keys.exact], before?.[keys.exact]))))
    return 'cents';
  return 'keep';
}
/**
 * 改产品的补丁要盖到候选记录上的价格字段（见 priceEdit）：清空价格是“分”给 0、不带精确价（存成没定价），
 * 按分存是去掉旧精确价。
 */
export function productPricePatch(
  patch: Record<string, unknown>,
  before: { priceCents?: number; priceExact?: string } | null | undefined,
  exactDropped = false,
): { priceExact?: undefined; priceCents?: number } {
  const edit = priceEdit(patch, before, { exact: 'priceExact', cents: 'priceCents' }, exactDropped);
  return edit === 'clear'
    ? { priceExact: undefined, priceCents: 0 }
    : edit === 'cents'
      ? { priceExact: undefined }
      : {};
}
/**
 * 给人看、放进输入框的单价，全站一个写法：至少两位小数、最多照原样（库里最多四位），第三、四位的尾零去掉，
 * 数值不变（2.7600 → 2.76，2.5000 → 2.50，10.7 → 10.70，2.0000 → 2.00，3.5425 不变）。
 * 列表、详情、编辑框、修改历史、印出来的单据都是这个样子；只算字符串，不经过浮点。
 * minDecimals 只给不是单价的地方用（预估成本按金额填，costYuan 传 0：“100”“2.5”）。
 */
export function plainPrice(value: string, minDecimals = 2) {
  const [integer, fraction = ''] = value.split('.');
  const shown = fraction.replace(/0+$/, '').padEnd(minDecimals, '0');
  return shown ? integer + '.' + shown : integer;
}

/**
 * 订单预估成本（分）放进编辑框的元：100 → “1”、250 → “2.5”，整数乘 100 用 BigInt。
 * 没有值写空串；不是整数的原样写出来，留给保存校验去拦。订单编辑窗和数据管理都用它。
 */
export function costYuan(cents: unknown) {
  if (cents == null || cents === '') return '';
  const n = Number(cents);
  return Number.isSafeInteger(n) ? plainPrice(priceFromCents(n), 0) : String(cents);
}
/**
 * 订单预估成本填的元 → 分（legacyCents，BigInt，不用浮点乘）：非负、最多两位小数、不超过一百万元（MAX_PRICE_YUAN，
 * 和服务端金额上限同一个数）。空着、不是数、小数超过两位、超上限都抛出中文原因；空着算不算“没填”由调用方定。
 */
export function costCents(value: string) {
  const text = value.trim();
  // 整数位不限长，先认出“是个数”，再分别看小数位和上限
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2] || '').length > 2) throw new Error('请填写金额（元），最多两位小数');
  if (BigInt(match[1]) * CENTS_PER_YUAN + BigInt((match[2] || '').padEnd(2, '0')) > BigInt(MAX_PRICE_YUAN) * CENTS_PER_YUAN)
    throw new Error('金额太大，不能超过 ' + MAX_PRICE_YUAN + ' 元');
  return legacyCents(text);
}
