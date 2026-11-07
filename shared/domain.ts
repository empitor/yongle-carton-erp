import { z } from 'zod';
import { precisionTotal } from './precision.js';
import { dimensionValueSchema, formatDimensions } from './product-details.js';
import { canonicalCurrency } from './currency.js';

export const statuses = ['草稿', '已确认', '生产中', '待发货', '已发货', '已取消'] as const;
/** 由生产任务和送货单推进，普通录入只选择草稿、已确认或已取消。 */
export const derivedOrderStatuses: readonly string[] = ['生产中', '待发货', '已发货'];
/** 页面上看到和筛选用的状态。“部分发货”不存库，由发货进度派生。 */
export const displayOrderStatuses = ['草稿', '已确认', '生产中', '待发货', '部分发货', '已发货', '已取消'] as const;
export function orderDisplayStatus(order: { status: string; shippingProgress?: string }) {
  // 一万个先发了五千，剩下的不管在做还是做好了，用户要先看到“发了一半”。
  return order.shippingProgress === '部分发货' && !['草稿', '已取消', '已发货'].includes(order.status)
    ? '部分发货'
    : order.status;
}
const text = (max = 200) => z.string().trim().max(max);
// 可选说明的null表示原件未提供；数字、对象等错误类型仍拒绝。
const blankText = (max: number) => z.preprocess((v) => (v === null ? '' : v), text(max));
const optionalText = (max: number) => blankText(max).optional();
const money = z.number().int().min(0).max(100_000_000); // 单位：分
export const exactPriceSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,6})(\.\d{1,4})?$/, '单价最多四位小数')
  .refine((v) => Number(v) <= 1_000_000);
// 兼容旧版仅有整数分单价的记录；AI正式导入仍单独要求原始单价存在。
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
    return !isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v;
  }, '请输入有效日期');
const optionalDate = z.preprocess(
  (v) => (v === null || (typeof v === 'string' && !v.trim()) ? undefined : v),
  dateSchema.optional(),
);
export const customerSchema = z.object({
  name: text(100).min(1, '请填写客户名称'),
  contact: blankText(60).default(''),
  phone: blankText(50).default(''),
  address: blankText(300).default(''),
  notes: blankText(1000).default(''),
});
export const productSchema = z
  .object({
    name: text(100).min(1, '请填写产品名称'),
    length: dimensionValueSchema,
    width: dimensionValueSchema,
    height: dimensionValueSchema,
    dimensionUnit: z.enum(['mm', 'cm']).nullable().optional(),
    dimensionUnitRaw: optionalText(100),
    material: blankText(100).default(''),
    flute: blankText(50).default(''),
    requirements: blankText(500).default(''),
    priceCents: money.default(0),
    priceExact: optionalExactPrice,
    customerProductCode: optionalText(100),
  })
  .refine(
    (p) =>
      p.dimensionUnit !== 'cm' ||
      [p.length, p.width, p.height].every((v) => v === null || v <= 1000),
    { message: '厘米尺寸不能超过1000cm（等于10000mm）', path: ['dimensionUnit'] },
  );
export const costSchema = z.object({
  material: money,
  processing: money,
  waste: money,
  other: money,
  basis: text(1000).min(1, '请说明估算依据'),
});
export const lineSchema = z.object({
  id: z.number().int().positive().optional(),
  productId: z.number().int().positive(),
  productName: text(2000).min(1).optional(),
  specification: blankText(2000).default(''),
  notes: optionalText(2000),
  quantity: z
    .number({ error: '请填写有效数量' })
    .int('数量必须为整数')
    .min(1, '数量必须大于零')
    .max(1_000_000, '数量不能超过1000000'),
  unitPriceCents: money,
  unitPriceExact: optionalExactPrice,
  customerProductCode: optionalText(100),
  unit: optionalText(20),
  taxRate: optionalText(30),
  taxMode: optionalText(60),
  deliveryDate: optionalDate,
});
function checkedTotal(lines: Parameters<typeof precisionTotal>[0]) {
  try {
    return precisionTotal(lines);
  } catch {
    return null;
  }
}
export const orderSchema = z
  .object({
    customerId: z.number().int().positive(),
    orderDate: dateSchema,
    deliveryDate: dateSchema,
    status: z.enum(statuses),
    notes: blankText(1000).default(''),
    lines: z.array(lineSchema).min(1).max(50),
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
    taxRate: optionalText(30),
    taxMode: optionalText(60),
    terms: optionalText(4000),
    roundingPolicy: z.enum(['exact-cents', 'half-up-cent']).optional(),
  })
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
  .refine((v) => (checkedTotal(v.lines)?.cents ?? Infinity) <= 100_000_000_000, {
    message: '订单金额超出本版本支持范围',
    path: ['lines'],
  })
  .refine(
    (v) =>
      v.roundingPolicy === 'half-up-cent' || checkedTotal(v.lines)?.hasFractionalCent === false,
    {
      message: '精确金额包含不足一分的尾数，请明确确认整单四舍五入到分的结算规则',
      path: ['roundingPolicy'],
    },
  );

export type CustomerInput = z.infer<typeof customerSchema>;
export type ProductInput = z.infer<typeof productSchema>;
export type OrderInput = z.infer<typeof orderSchema>;
export type Cost = z.infer<typeof costSchema>;
export type Customer = CustomerInput & { id: number; version: number; createdAt: string };
export type Product = ProductInput & { id: number; version: number; createdAt: string };
export type Order = Omit<OrderInput, 'lines'> & {
  id: number;
  number: string;
  customerName: string;
  version: number;
  totalCents: number;
  totalAmountExact?: string;
  costCents: number | null;
  createdAt: string;
  updatedAt: string;
  importSource?: { fileName: string; at: string; actorName: string; sourceId: string };
  deliveryQuantitiesKnown?: boolean;
  shippingProgress?: import('./fulfillment.js').ShippingProgress;
  shippingSummary?: { progress: string; completedLines: number; totalLines: number; unknownLines: number };
  materialProgress?: 'none' | 'pending' | 'partial' | 'done';
  lines: (z.infer<typeof lineSchema> & {
    productName: string;
    shippedQuantity?: number | null;
    remainingQuantity?: number | null;
    shippingStatus?: import('./fulfillment.js').ShippingProgress;
  })[];
};
export type Dashboard = {
  overview: import('./overview.js').BusinessOverview;
  count: number;
  amountCents: number;
  shippedCents: number;
  estimatedCostCents: number;
  estimatedProfitCents: number;
  costedCount: number;
  uncostedCount: number;
  overdueCount: number;
  byStatus: { status: string; count: number }[];
  recentOrders: Order[];
};
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
/** 规格比较只看内容：空格、分隔符、大小写、× 和 x 的写法都不算差别。 */
const specificationDimensions =
  /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)(?:\s*[x×*]\s*(\d+(?:\.\d+)?))?\s*(mm|cm|m|毫米|厘米|米)?/i;
const specificationScale: Record<string, number> = { mm: 1, 毫米: 1, cm: 10, 厘米: 10, m: 1000, 米: 1000 };
/**
 * 订单上的规格是客户写的（71*41*44），成品档案的规格是系统生成的（71×41×44 / 双瓦楞 / 加工要求）。
 * 尺寸相同就比附加内容，一边没写不算不同；一边没写单位时只比数字，不换算。
 */
export function sameSpecification(a: string, b: string) {
  const plain = (text: string) =>
    text.replace(/[\s/／,，;；、]+/g, '').replaceAll('×', 'x').replaceAll('*', 'x').toLowerCase();
  const da = specificationDimensions.exec(a),
    db = specificationDimensions.exec(b);
  if (!da || !db) return plain(a) === plain(b);
  const scale = (m: RegExpExecArray) => (m[4] && da[4] && db[4] ? specificationScale[m[4].toLowerCase()] : 1);
  const numbers = (m: RegExpExecArray) =>
    [m[1], m[2], m[3]].filter(Boolean).map((n) => Math.round(Number(n) * scale(m) * 1000));
  if (numbers(da).join() !== numbers(db).join()) return false;
  const rest = (text: string, m: RegExpExecArray) => plain(text.replace(m[0], ''));
  const ra = rest(a, da),
    rb = rest(b, db);
  return !ra || !rb || ra.includes(rb) || rb.includes(ra);
}
export const specification = (p: ProductInput) =>
  [formatDimensions(p), p.material, p.flute, p.requirements].filter(Boolean).join(' / ');
