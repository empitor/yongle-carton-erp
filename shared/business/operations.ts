import { z } from 'zod';
import { PRICE_DECIMALS, RAW_UNIT, UNITS_PER_YUAN, positiveQuantity, quantityText, quantityUnits, stockKinds, type StockKind } from '../core/index.js';
import { chosenId, dateSchema, exactPriceSchema, customerSchema, fieldLabel } from '../core/index.js';
import { cmLimitIssue, dimensionUnitSchema, priceBases, dimensionValueSchema, specification, withinCmLimit } from '../core/index.js';
import { MONEY_DECIMALS, NOTE_MAX_LENGTH, SQUARE_METRE_SHIFT, UNIT_MAX_LENGTH } from './limits.js';
/** 楞型最多多少字 */
const FLUTE_MAX_LENGTH = 50;
/** 一张采购单最多几行明细 */
const MAX_PURCHASE_LINES = 50;
export const recordEntities = [
  'customers',
  'products',
  'orders',
  'suppliers',
  'purchases',
  'stock_items',
] as const;
export type RecordEntity = (typeof recordEntities)[number];
export const purchaseStatuses = ['待订货', '已订货', '部分到货', '全部到货', '已取消'] as const;
export const purchaseBusinessStatuses = ['待订货', '已订货', '已取消'] as const;
export const arrivalProgresses = ['未到货', '部分到货', '全部到货'] as const;
/** 库存品种类的叫法（下拉、修改历史、选择器小字都用这一份；仓库和页面另叫“原材料库存”“成品库存”） */
export const stockKindNames: Record<StockKind, string> = { raw: '原材料', finished: '成品' };
export function lineMoney(quantity: string, price: string | null) {
  if (price === null) return null;
  const [a, b = ''] = price.split('.');
  const v = BigInt(quantityUnits(quantity)) * (BigInt(a) * UNITS_PER_YUAN + BigInt(b.padEnd(PRICE_DECIMALS, '0')));
  const s = String(v).padStart(MONEY_DECIMALS + 1, '0');
  return s.slice(0, -MONEY_DECIMALS) + '.' + s.slice(-MONEY_DECIMALS);
}
export function sumMoney(values: (string | null)[]) {
  const texts = values.filter((v): v is string => v !== null);
  if (texts.length !== values.length) return null;
  const scale = Math.max(MONEY_DECIMALS, ...texts.map((v) => (v.split('.')[1] || '').length));
  const total = texts.reduce((n, v) => {
    const [a, b = ''] = v.split('.');
    return n + BigInt(a) * 10n ** BigInt(scale) + BigInt(b.padEnd(scale, '0'));
  }, 0n);
  const s = String(total).padStart(scale + 1, '0');
  return s.slice(0, -scale) + '.' + s.slice(-scale);
}
const txt = (max: number) =>
  z.preprocess((v) => (v == null ? '' : v), z.string().trim().max(max)).default('');
// 可以不关联的编号：留空是 null；填了 0 或负数提示“请重新选择××，不关联就留空”
const optionalId = (what: string) =>
  z.preprocess((v) => (v === '' ? null : v), chosenId(what, true).nullable()).default(null);
const optionalSize = z.preprocess(
  (v) => (typeof v === 'string' && !v.trim() ? null : v),
  dimensionValueSchema,
);
const nullableDate = z
  .preprocess(
    (v) => (v === null || (typeof v === 'string' && !v.trim()) ? null : v),
    dateSchema.nullable(),
  )
  .default(null);
// 和客户档案同一套字段和规则，只是名称没填时说“供应商名称”
export const supplierSchema = customerSchema.extend({
  name: z.string().trim().max(100).min(1, '请填写供应商名称'),
});
export const stockItemSchema = z
  .object({
    name: z.string().trim().min(1, '请填写库存品名称').max(100),
    kind: z.enum(stockKinds, { error: '请选择库存品种类（原材料或成品）' }),
    // 成品只有“只”（“个”也按“只”），原材料只有“张”；不填按种类定，见 shared/core/units.ts
    unit: z.string().trim().max(UNIT_MAX_LENGTH).default(''),
    specification: txt(NOTE_MAX_LENGTH),
    length: optionalSize,
    width: optionalSize,
    height: optionalSize,
    dimensionUnit: dimensionUnitSchema.nullable().default(null),
    material: txt(100),
    flute: txt(FLUTE_MAX_LENGTH),
    notes: txt(1000),
    productId: optionalId('产品'),
  })
  .refine(withinCmLimit, cmLimitIssue);
/** 单据的说明文字（备注、地址、联系人这类）：去掉首尾空白，最多 2000 字；说明编辑（server/flow/document-info.ts）也用它 */
export const noteText = z.string().trim().max(NOTE_MAX_LENGTH);
/**
 * 到货明细里的纸板（到货单一行的 item）：到货没选库存品时按它对上已有的原材料，没有就按它新建（server/operations/stock-items.ts）。
 * 到货的纸板只有“张”：空、没写的 flowInput 归成“张”，别的单位由单据保存服务拦
 */
export const arrivalItemSchema = z
  .object(stockItemSchema.shape)
  .omit({ kind: true, productId: true })
  .extend({ unit: z.string().trim().max(UNIT_MAX_LENGTH).default(RAW_UNIT) });
export type ArrivalItem = z.output<typeof arrivalItemSchema>;
/** 到货明细的计价方式：没选是 null（到货单录入时默认按平方米，见 physical-flow.ts 的 arrivalLineSchema） */
export const arrivalPriceBasisSchema = z.enum(priceBases, { error: '计价方式只能选按平方米或按张' }).nullable();
/**
 * 采购明细必须写的尺寸栏（用户定的）：没关联库存品的行要写长和宽（页面“尺寸”那组；高收在“更多”里、尺寸单位不确定可不选，都不要求），
 * 材质、楞型选填；关联了库存品的行尺寸跟着库存品走，不要求。服务端保存（server/operations/purchase-save.ts）
 * 和页面的必填标记（src/operations/PurchaseLineCard.tsx）都按这一份。
 */
export function requiredPurchaseSize(line: { stockItemId?: number | null }) {
  return line.stockItemId ? [] : (['length', 'width'] as const);
}
export const purchaseLineSchema = z
  .object(stockItemSchema.shape)
  .omit({ kind: true, productId: true })
  .extend({
    id: z.number().int().positive().optional(),
    stockItemId: optionalId('库存品'),
    /** 这一行是给哪张客户订单订的料；不填就跟单头的关联订单走。一张采购单可以给几张订单订料。 */
    customerOrderId: optionalId(fieldLabel('customerOrderId')),
    quantity: positiveQuantity,
    // 计价方式不默认（用户定的）：没说就不让建，按张、按平方米算出来的钱差得多，留给人选
    // 提示前面会带上栏目名（“明细第1项的计价方式：请选择按平方米还是按张”），这里不再写“计价方式”
    priceBasis: z.enum(priceBases, { error: '请选择按平方米还是按张' }),
    unitPrice: z
      .preprocess(
        (v) =>
          v == null || (typeof v === 'string' && !v.trim())
            ? null
            : typeof v === 'string'
              ? v.trim()
              : v,
        exactPriceSchema.nullable(),
      )
      .default(null),
  })
  .refine(withinCmLimit, cmLimitIssue);
/**
 * 采购明细存进 document 列的内容：名称、单位、规格说明、尺寸、材质、楞型、备注、计价方式、单价；
 * 库存品、数量、关联订单存在列里。多出的键算对不上。采购库存写读、财务按表读都按这一份。
 */
export const purchaseLineDocumentSchema = z
  .strictObject(purchaseLineSchema.shape)
  .omit({ id: true, stockItemId: true, customerOrderId: true, quantity: true });
export const purchaseSchema = z
  .object({
    supplierId: chosenId('供应商'),
    customerOrderId: optionalId(fieldLabel('customerOrderId')),
    orderDate: dateSchema,
    expectedDate: nullableDate,
    status: z.enum(purchaseBusinessStatuses, { error: '请选择采购单状态' }),
    notes: txt(1000),
    lines: z.array(purchaseLineSchema).min(1, '至少要有一行明细').max(MAX_PURCHASE_LINES, '一张采购单最多 ' + MAX_PURCHASE_LINES + ' 行明细'),
  })
  .refine((v) => !v.expectedDate || v.expectedDate >= v.orderDate, {
    message: '预计到货日期不能早于采购日期',
    path: ['expectedDate'],
  });
export const movementSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  requestId: z.uuid(),
  action: z.enum(['in', 'out', 'adjust']),
  quantity: quantityText,
  date: dateSchema,
  notes: z.string().trim().min(1, '请填写出入库用途或盘点原因').max(1000),
  customerOrderId: optionalId(fieldLabel('customerOrderId')),
  acknowledged: z.literal(true),
});
export function formatStockSize(v: {
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimensionUnit?: string | null;
}) {
  // 就是 specification() 里尺寸那一段，写法完全一样：单位规范成 mm / cm，没写单位的只写数字、不写“尺寸单位待确认”；
  // 末尾没填的不写，中间没填的写“—”；长宽高一项都没填时是空串，调用处显示“—”或不显示
  return specification({ length: v.length, width: v.width, height: v.height, dimensionUnit: v.dimensionUnit });
}
/** 十进制数里科学记数法的指数最多多大（再大就当无效数，不去算天文数字） */
const MAX_DECIMAL_EXPONENT = 400;
/** 一个十进制数写成整数系数和小数位数：12.5 是 125 和 1 位 */
function decimalTerm(v: string) {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(v);
  if (!match || Math.abs(Number(match[3] || 0)) > MAX_DECIMAL_EXPONENT) throw new Error('无效十进制数');
  const [, a, b = '', exponent = '0'] = match,
    termScale = b.length - Number(exponent),
    digits = BigInt(a + b);
  return {
    coefficient: termScale < 0 ? digits * 10n ** BigInt(-termScale) : digits,
    scale: Math.max(0, termScale),
  };
}
// 十进制精确面积/金额。尺寸单位未知时返回null，不把未知尺寸当作毫米。
function multiplyDecimal(values: [string, ...string[]], divisionScale = 0): string {
  const terms = values.map(decimalTerm);
  const value = terms.map((t) => t.coefficient).reduce((product, c) => product * c),
    scale = terms.reduce((n, t) => n + t.scale, divisionScale);
  const s = String(value).padStart(scale + 1, '0');
  return scale ? (s.slice(0, -scale) + '.' + s.slice(-scale)).replace(/\.?0+$/, '') : s;
}
/** 算纸板面积要用的库存品资料：单位、长、宽和尺寸单位 */
export type SheetItem = {
  unit?: string | null;
  length?: number | null;
  width?: number | null;
  dimensionUnit?: string | null;
};
export function sheetArea(item: SheetItem, quantity: string): string | null {
  const unit = item.dimensionUnit;
  if (item.unit !== RAW_UNIT || (unit !== 'mm' && unit !== 'cm') || !((item.length ?? 0) > 0) || !((item.width ?? 0) > 0))
    return null;
  return multiplyDecimal([String(item.length), String(item.width), quantity], SQUARE_METRE_SHIFT[unit]);
}
/** 采购、到货一行的金额：数量、单价和计价方式（按面积时还要纸板资料）；没写单价或计价方式算不出 */
type PricedLine = SheetItem & { quantity: string; unitPrice?: string | null; priceBasis?: string | null };
export function purchaseLineAmount(line: PricedLine): string | null {
  if (line.unitPrice == null || !line.priceBasis) return null;
  const basis = line.priceBasis === 'area' ? sheetArea(line, line.quantity) : line.quantity;
  return basis == null ? null : multiplyDecimal([basis, line.unitPrice]);
}
