import { z } from 'zod';
import { MAX_PRICE_YUAN, precisionTotal } from './precision.js';
import { cmLimitIssue, dimensionUnitSchema, dimensionValueSchema, normalizeDimensionUnit, withinCmLimit, type SpecFields } from './product-details.js';
import { canonicalCurrency } from './currency.js';

/** 订单金额怎么到分：按精确金额（不能有不足一分的尾数）、整单四舍五入到分 */
export const roundingPolicies = ['exact-cents', 'half-up-cent'] as const;
/** “金额结算”两种选法的叫法（照订单页编辑窗）：下拉按 roundingPolicies 的顺序列，报错、修改历史都用这一份 */
export const roundingPolicyLabels: Record<(typeof roundingPolicies)[number], string> = {
  'exact-cents': '精确到分，不自动舍入',
  'half-up-cent': '明确采用整单四舍五入到分',
};
export const statuses = ['待确认', '已确认', '生产中', '待发货', '已发货', '已取消'] as const;
/** 由生产任务和送货单推进，普通录入只选择待确认、已确认或已取消。 */
export const derivedOrderStatuses: readonly string[] = ['生产中', '待发货', '已发货'];
/** 页面上看到和筛选用的状态。“部分发货”不存库，由发货进度派生。 */
export const displayOrderStatuses = ['待确认', '已确认', '生产中', '待发货', '部分发货', '已发货', '已取消'] as const;
type OrderStatus = (typeof statuses)[number];
/** 不算有效订单的状态（接单、金额、送货都不算它们）；SQL 里用这份清单，代码里用 effectiveOrder */
export const uncountedOrderStatuses: readonly OrderStatus[] = ['待确认', '已取消'];
/** 订单算不算数：不是待确认、已取消 */
export const effectiveOrder = (order: { status: string }) => !uncountedOrderStatuses.some((s) => s === order.status);
/** 订单还能不能送（还在进行）：有效、还没发完 */
export const deliverableOrder = (order: { status: string }) => effectiveOrder(order) && order.status !== '已发货';
/** 订单是不是已结束：已发货或已取消 */
export const closedOrder = (order: { status: string }) => order.status === '已发货' || order.status === '已取消';
export function orderDisplayStatus(order: { status: string; shippingProgress?: string }) {
  // 一万个先发了五千，剩下的不管在做还是做好了，用户要先看到“发了一半”。
  return order.shippingProgress === '部分发货' && deliverableOrder(order)
    ? '部分发货'
    : order.status;
}
/** 各段文字最多几个字（客户、产品、订单录入共用） */
const TEXT_MAX = {
  contact: 60,
  phone: 50,
  address: 300,
  flute: 50,
  requirements: 500,
  /** 订单明细的产品名称、规格、备注 */
  lineText: 2000,
  unit: 20,
  taxRate: 30,
  taxMode: 60,
  terms: 4000,
};
/** 金额、单价的上限（分）：一百万元 */
const MAX_CENTS = MAX_PRICE_YUAN * 100;
/** 一行明细最多多少只 */
const MAX_LINE_QUANTITY = 1_000_000;
/** 一张订单最多几行明细（识别表也按它限行数） */
export const MAX_ORDER_LINES = 50;
/** 一张订单的金额上限（分）：十亿元 */
const MAX_ORDER_CENTS = 100_000_000_000;
/** YYYY-MM-DD 的长度：从 toISOString() 里截日期用 */
export const ISO_DATE_LENGTH = 10;
/** 日期文字（YYYY-MM-DD）里“月-日”从第几个字开始 */
export const MONTH_DAY_START = 'YYYY-'.length;
const text = (max = 200) => z.string().trim().max(max);
// 可选说明的null表示原件未提供；数字、对象等错误类型仍拒绝。
const blankText = (max: number) => z.preprocess((v) => (v === null ? '' : v), text(max));
const optionalText = (max: number) => blankText(max).optional();
/**
 * 要选的编号（客户、产品、订单、库存品……）：没选（null）、填了 0 或负数都报“请选择××”，
 * 不用 zod 默认的英文（Too small: expected number to be >0）。只换提示，校验和原来一样是正整数。
 * optional：可以不关联的编号（调用方自己加 nullable），填了 0 或负数时提示留空也行。
 */
export const chosenId = (what: string, optional = false) => {
  const message = optional ? '请重新选择' + what + '，不关联就留空' : '请选择' + what;
  return z.number({ error: message }).int(message).positive(message);
};
// 单位：分。提示都写中文（zod 默认的是英文）；上限 1 亿分 = 一百万元
const money = z
  .number({ error: '请填写有效金额' })
  .int('金额（分）必须是整数')
  .min(0, '金额不能小于 0')
  .max(MAX_CENTS, '金额不能超过 ' + MAX_PRICE_YUAN + ' 元');
// 正则放到 7 位整数，先认出“是个数”；上限一百万元由下一步拦（和 shared/core/precision.ts 的 priceUnits 同一个上限）
export const exactPriceSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,6})(\.\d{1,4})?$/, '单价最多四位小数')
  // 写成“不大于”：格式不对的（NaN）只报上一条，不再多报一条超上限
  .refine((v) => !(Number(v) > MAX_PRICE_YUAN), '单价不能超过 ' + MAX_PRICE_YUAN + ' 元');
// 精确单价可以不给（只给分时按分存）；AI正式导入仍单独要求原始单价存在。
const optionalExactPrice = z.preprocess(
  (v) =>
    v === null || (typeof v === 'string' && !v.trim())
      ? undefined
      : typeof v === 'string'
        ? v.trim()
        : v,
  exactPriceSchema.optional(),
);
export const dateSchema = z
  .string({ error: '请填写明确日期，不能用空值自动推断' })
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '请填写明确有效的YYYY-MM-DD日期')
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return !isNaN(d.valueOf()) && d.toISOString().slice(0, ISO_DATE_LENGTH) === v;
  }, '请输入有效日期');
const optionalDate = z.preprocess(
  (v) => (v === null || (typeof v === 'string' && !v.trim()) ? undefined : v),
  dateSchema.optional(),
);
export const customerSchema = z.object({
  name: text(100).min(1, '请填写客户名称'),
  contact: blankText(TEXT_MAX.contact).default(''),
  phone: blankText(TEXT_MAX.phone).default(''),
  address: blankText(TEXT_MAX.address).default(''),
  notes: blankText(1000).default(''),
});
export const productSchema = z
  .object({
    name: text(100).min(1, '请填写产品名称'),
    length: dimensionValueSchema,
    width: dimensionValueSchema,
    height: dimensionValueSchema,
    dimensionUnit: dimensionUnitSchema.nullable().optional(),
    dimensionUnitRaw: optionalText(100),
    material: blankText(100).default(''),
    flute: blankText(TEXT_MAX.flute).default(''),
    requirements: blankText(TEXT_MAX.requirements).default(''),
    priceCents: money.default(0),
    priceExact: optionalExactPrice,
    customerProductCode: optionalText(100),
    /** 附属于哪个产品（比如小箱套在大箱里）。只是显示上归在一起，订单、价格、库存都各算各的；null 是取消附属 */
    parentProductId: chosenId('附属于哪个产品', true).nullable().optional(),
  })
  .refine(withinCmLimit, cmLimitIssue);
export const costSchema = z.object({
  material: money,
  processing: money,
  waste: money,
  other: money,
  basis: text(1000).min(1, '请说明估算依据'),
});
export const lineSchema = z.object({
  id: z.number().int().positive().optional(),
  productId: chosenId('产品'),
  productName: text(TEXT_MAX.lineText).min(1, '请填写产品名称').optional(),
  specification: blankText(TEXT_MAX.lineText).default(''),
  notes: optionalText(TEXT_MAX.lineText),
  quantity: z
    .number({ error: '请填写有效数量' })
    .int('数量必须为整数')
    .min(1, '数量必须大于零')
    .max(MAX_LINE_QUANTITY, '数量不能超过' + MAX_LINE_QUANTITY),
  // 明细单价必填：留空（null、没给）报“请填写单价”，不按 0 元存
  unitPriceCents: z
    .number({ error: '请填写单价' })
    .int('单价（分）必须是整数')
    .min(0, '单价不能小于 0')
    .max(MAX_CENTS, '单价不能超过 ' + MAX_PRICE_YUAN + ' 元'),
  unitPriceExact: optionalExactPrice,
  customerProductCode: optionalText(100),
  // 产品数量单位只有“只”（“个”、没写都按“只”）；新建或改成别的单位由订单保存拦，见 shared/core/units.ts
  unit: optionalText(TEXT_MAX.unit),
  taxRate: optionalText(TEXT_MAX.taxRate),
  taxMode: optionalText(TEXT_MAX.taxMode),
  deliveryDate: optionalDate,
});
function checkedTotal(lines: Parameters<typeof precisionTotal>[0]) {
  try {
    return precisionTotal(lines);
  } catch {
    return null;
  }
}
/** 订单录入的字段；跨字段的核对在 orderSchema 上 */
const orderFields = z.object({
    customerId: chosenId('客户'),
    orderDate: dateSchema,
    deliveryDate: dateSchema,
    status: z.enum(statuses, { error: '请选择订单状态' }),
    notes: blankText(1000).default(''),
    lines: z.array(lineSchema).min(1, '至少要有一行明细').max(MAX_ORDER_LINES, `一张订单最多 ${MAX_ORDER_LINES} 行明细`),
    costs: costSchema.nullable().default(null),
    externalPurchaseOrder: optionalText(100),
    supplierName: optionalText(100),
    currency: z
      .preprocess(
        canonicalCurrency,
        z.literal('CNY', {
          error: '当前正式订单仅支持人民币（CNY），请核对原币种，不能自动转换外币',
        }),
      )
      .default('CNY')
      .optional(),
    taxRate: optionalText(TEXT_MAX.taxRate),
    taxMode: optionalText(TEXT_MAX.taxMode),
    terms: optionalText(TEXT_MAX.terms),
    roundingPolicy: z.enum(roundingPolicies, { error: '请选择金额结算' }).optional(),
  });
export const orderSchema = orderFields
  .refine((v) => v.deliveryDate >= v.orderDate, {
    message: '交货日期不能早于订单日期',
    path: ['deliveryDate'],
  })
  .superRefine((v, ctx) => {
    v.lines.forEach((l, i) => {
      if (l.deliveryDate && l.deliveryDate < v.orderDate)
        ctx.addIssue({
          code: 'custom',
          path: ['lines', i, 'deliveryDate'],
          message: '明细交期不能早于订单日期',
        });
    });
  })
  // 算不出合计（某行单价格式不对、超上限）时那一行已经报过了，这两道不再跟着多报
  .refine((v) => (checkedTotal(v.lines)?.cents ?? 0) <= MAX_ORDER_CENTS, {
    message: '订单金额超出本版本支持范围',
    path: ['lines'],
  })
  .refine(
    (v) =>
      v.roundingPolicy === 'half-up-cent' || checkedTotal(v.lines)?.hasFractionalCent !== true,
    {
      message: '精确金额包含不足一分的尾数，请在金额结算里选“' + roundingPolicyLabels['half-up-cent'] + '”',
      path: ['roundingPolicy'],
    },
  );

export type CustomerInput = z.infer<typeof customerSchema>;
export type ProductInput = z.infer<typeof productSchema>;
export type OrderInput = z.infer<typeof orderSchema>;
export type Cost = z.infer<typeof costSchema>;
export type Customer = CustomerInput & { id: number; version: number; createdAt: string; updatedAt: string };
export type Product = ProductInput & { id: number; version: number; createdAt: string; updatedAt: string };
export const totalCost = (cost: Cost | null) =>
  cost === null ? null : cost.material + cost.processing + cost.waste + cost.other;
export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
export const today = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
/** 规格比较只看内容：空格、斜杠、逗号、分号、顿号、大小写、× 和 x 的写法都不算差别。 */
const specificationDimensions =
  /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)(?:\s*[x×*]\s*(\d+(?:\.\d+)?))?\s*(mm|cm|m|毫米|厘米|米)?/i;
const specificationScale: Record<string, number> = { mm: 1, 毫米: 1, cm: 10, 厘米: 10, m: 1000, 米: 1000 };
/** × 和 * 都写成 x，转小写（去掉哪些分隔符由调用处定） */
const sameNotation = (text: string) => text.replaceAll('×', 'x').replaceAll('*', 'x').toLowerCase();
/**
 * 比较两段规格时只去掉空格、斜杠、逗号、分号、顿号；横线、下划线、破折号要留着：它们可能是编号的一部分，
 * 去掉会把不同规格算成同一个（“1-12”和“11-2”、“A-11”和“A1-1”）。
 */
const plainSpecification = (text: string) => sameNotation(text.replace(/[\s/／,，;；、]+/g, ''));
/**
 * 订单明细里真正要比对的规格：规格只是重复了产品名称（没写材质、楞型等）时不算规格，送货不拿它和库存比对。
 * 写了别的内容的照常比对，不同规格的货不混着发。这里只认“是不是照抄了品名”，横线、下划线、破折号也不算差别。
 */
export function lineSpecification(line: { specification?: string | null; productName?: string | null }) {
  const plain = (text: unknown) => sameNotation(String(text ?? '').replace(/[\s/／,，;；、\-_—]+/g, ''));
  const spec = String(line.specification ?? '').trim();
  return spec && plain(spec) !== plain(line.productName) ? spec : '';
}
/**
 * 订单上的规格是客户写的（71*41*44），成品库存品的规格是系统生成的（71×41×44 / 双瓦楞 / 加工要求）。
 * 尺寸相同就比附加内容，一边没写不算不同；一边没写单位时只比数字，不换算。
 */
export function sameSpecification(a: string, b: string) {
  const da = specificationDimensions.exec(a),
    db = specificationDimensions.exec(b);
  if (!da || !db) return plainSpecification(a) === plainSpecification(b);
  const scale = (m: RegExpExecArray) => (m[4] && da[4] && db[4] ? specificationScale[m[4].toLowerCase()] : 1);
  const numbers = (m: RegExpExecArray) =>
    [m[1], m[2], m[3]].filter(Boolean).map((n) => Math.round(Number(n) * scale(m) * 1000));
  if (numbers(da).join() !== numbers(db).join()) return false;
  const rest = (text: string, m: RegExpExecArray) => plainSpecification(text.replace(m[0], ''));
  const ra = rest(a, da),
    rb = rest(b, db);
  return !ra || !rb || ra.includes(rb) || rb.includes(ra);
}
/**
 * 两段规格哪里不一样，用同一种写法说出来给人核对（line 是订单明细写的，current 是产品现在的规格）：
 * 尺寸不一样只说尺寸（“订单明细写的是 260 × 110 × 240，产品现在是 270 × 110 × 240 mm”）；
 * 尺寸一样只说尺寸以外不一样的那段；两边没都写尺寸时整段对照。
 */
export function specificationDifference(line: string, current: string) {
  const dl = specificationDimensions.exec(line),
    dc = specificationDimensions.exec(current);
  const size = (m: RegExpExecArray) =>
    [m[1], m[2], m[3]].filter(Boolean).map(Number).join(' × ') + (m[4] ? ' ' + m[4].toLowerCase() : '');
  const rest = (text: string, m: RegExpExecArray) =>
    text.replace(m[0], '').replace(/^[\s/／,，;；、]+|[\s/／,，;；、]+$/g, '') || '—';
  if (dl && dc)
    return sameSpecification(dl[0], dc[0])
      ? '订单明细写的是“' + rest(line, dl) + '”，产品现在是“' + rest(current, dc) + '”'
      : '订单明细写的是 ' + size(dl) + '，产品现在是 ' + size(dc);
  return '订单明细写的是“' + line + '”，产品现在是“' + (current || '—') + '”';
}
/**
 * 产品的规格文字：尺寸、材质、楞型、加工要求，有什么写什么，用“ / ”隔开；一样都没有时是空串（界面显示“—”）。
 * 尺寸：长宽高一项都没填就不写这一段；填了的照实写（末尾没填的不写，中间没填的写“—”保住“长 × 宽 × 高”的位置），
 * 写了尺寸单位的带上单位，没写的只写数字，不往规格里塞占位符和“尺寸单位待确认”（要补的资料由 productNotices、产品详情提醒）。
 * 订单明细的默认规格、成品库存的规格说明都用它；sameSpecification 拿它和订单明细写的比。
 */
export const specification = (p: SpecFields & { requirements?: string | null }) => {
  const dimensions = [p.length, p.width, p.height];
  while (dimensions.length && dimensions[dimensions.length - 1] == null) dimensions.pop();
  const unit = normalizeDimensionUnit(p.dimensionUnit),
    size = dimensions.length ? dimensions.map((n) => (n == null ? '—' : String(n))).join(' × ') + (unit ? ' ' + unit : '') : '';
  return [size, p.material, p.flute, p.requirements]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join(' / ');
};
