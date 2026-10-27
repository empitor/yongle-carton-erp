import { z } from 'zod';
import { dateSchema, exactPriceSchema, customerSchema } from './domain.js';
import { dimensionValueSchema } from './product-details.js';
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
export const stockKinds = ['raw', 'finished'] as const;
export const quantityText = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d{0,8})(\.\d{1,3})?$/, '数量使用非负数字，最多3位小数');
export const positiveQuantity = quantityText.refine((v) => quantityUnits(v) > 0, '数量必须大于零');
export function quantityUnits(v: string) {
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,3})?$/.test(v.trim()))
    throw new Error('数量格式无效，最多3位小数');
  const [a, b = ''] = v.trim().split('.');
  return Number(BigInt(a) * 1000n + BigInt(b.padEnd(3, '0')));
}
export function quantityString(n: number) {
  const s = String(n).padStart(4, '0');
  return (s.slice(0, -3) + '.' + s.slice(-3)).replace(/\.?0+$/, '') || '0';
}
export function lineMoney(quantity: string, price: string | null) {
  if (price === null) return null;
  const [a, b = ''] = price.split('.');
  const v = BigInt(quantityUnits(quantity)) * (BigInt(a) * 10000n + BigInt(b.padEnd(4, '0')));
  const s = String(v).padStart(8, '0');
  return s.slice(0, -7) + '.' + s.slice(-7);
}
export function sumMoney(values: (string | null)[]) {
  if (values.some((v) => v === null)) return null;
  const scale = Math.max(7, ...values.map((v) => (v!.split('.')[1] || '').length));
  const total = values.reduce((n, v) => {
    const [a, b = ''] = v!.split('.');
    return n + BigInt(a) * 10n ** BigInt(scale) + BigInt(b.padEnd(scale, '0'));
  }, 0n);
  const s = String(total).padStart(scale + 1, '0');
  return s.slice(0, -scale) + '.' + s.slice(-scale);
}
const txt = (max: number) =>
  z.preprocess((v) => (v == null ? '' : v), z.string().trim().max(max)).default('');
const optionalId = z
  .preprocess((v) => (v === '' ? null : v), z.number().int().positive().nullable())
  .default(null);
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
export const supplierSchema = customerSchema;
export const stockItemSchema = z
  .object({
    name: z.string().trim().min(1, '请填写库存品名称').max(100),
    kind: z.enum(stockKinds),
    unit: z.string().trim().min(1, '请选择数量单位').max(20),
    specification: txt(2000),
    length: optionalSize,
    width: optionalSize,
    height: optionalSize,
    dimensionUnit: z.enum(['mm', 'cm']).nullable().default(null),
    material: txt(100),
    flute: txt(50),
    notes: txt(1000),
    productId: optionalId,
  })
  .refine(
    (v) =>
      v.dimensionUnit !== 'cm' ||
      [v.length, v.width, v.height].every((n) => n === null || n <= 1000),
    { message: '厘米尺寸不能超过1000cm', path: ['dimensionUnit'] },
  );
export const purchaseLineSchema = z
  .object(stockItemSchema.shape)
  .omit({ kind: true, productId: true })
  .extend({
    id: z.number().int().positive().optional(),
    stockItemId: optionalId,
    quantity: positiveQuantity,
    priceBasis: z.enum(['area', 'quantity']).default('quantity'),
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
  .refine(
    (v) =>
      v.dimensionUnit !== 'cm' ||
      [v.length, v.width, v.height].every((n) => n === null || n <= 1000),
    { message: '厘米尺寸不能超过1000cm', path: ['dimensionUnit'] },
  );
export const purchaseSchema = z
  .object({
    supplierId: z.number().int().positive(),
    customerOrderId: optionalId,
    orderDate: dateSchema,
    expectedDate: nullableDate,
    status: z.enum(['待订货', '已订货', '已取消']),
    notes: txt(1000),
    lines: z.array(purchaseLineSchema).min(1).max(50),
  })
  .refine((v) => !v.expectedDate || v.expectedDate >= v.orderDate, {
    message: '预计到货日期不能早于采购日期',
    path: ['expectedDate'],
  });
export const receiptSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  requestId: z.string().uuid(),
  reference: z.string().trim().min(1, '请填写送货单号或到货批次号').max(100),
  date: dateSchema,
  notes: txt(1000),
  items: z
    .array(z.strictObject({ lineId: z.number().int().positive(), quantity: positiveQuantity }))
    .min(1)
    .max(50),
  acknowledged: z.literal(true),
});
export const movementSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  requestId: z.string().uuid(),
  action: z.enum(['in', 'out', 'adjust']),
  quantity: quantityText,
  date: dateSchema,
  notes: z.string().trim().min(1, '请填写出入库用途或盘点原因').max(1000),
  customerOrderId: optionalId,
  acknowledged: z.literal(true),
});
export type StockItemInput = z.infer<typeof stockItemSchema>;
export type PurchaseInput = z.infer<typeof purchaseSchema>;
export function formatStockSize(v: {
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimensionUnit?: string | null;
}) {
  return (
    [v.length ?? '—', v.width ?? '—', ...(v.height == null ? [] : [v.height])].join(' × ') +
    (v.dimensionUnit ? ' ' + v.dimensionUnit : '（单位待确认）')
  );
}
