import { z } from 'zod';
import { dateSchema, exactPriceSchema } from './domain.js';
import { stockItemSchema, positiveQuantity, quantityText, quantityUnits } from './operations.js';
import { inspectionFields, arrivalTimeSchema } from './arrival.js';
export const flowKinds = ['arrival', 'task', 'production', 'delivery'] as const;
export type FlowKind = (typeof flowKinds)[number];
export const flowNames: Record<FlowKind, string> = {
  arrival: '采购到货',
  task: '生产任务',
  production: '生产登记',
  delivery: '客户送货',
};
export const flowStates: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  cancelled: '已取消',
  reversed: '已冲销',
};
export function flowStatusLabel(doc: {
  kind: string;
  status: string;
  quantity?: string;
  completed?: string;
}) {
  if (doc.status !== 'confirmed') return flowStates[doc.status] || doc.status;
  if (doc.kind === 'task') {
    const done = quantityUnits(doc.completed || '0'),
      planned = quantityUnits(doc.quantity || '0');
    return planned > 0 && done >= planned ? '已完工' : done > 0 ? '生产中' : '待生产';
  }
  return doc.kind === 'arrival'
    ? '已确认收货'
    : doc.kind === 'delivery'
      ? '已确认发货'
      : '已确认完工';
}
export function matchesFlowStatus(
  doc: { kind: string; status: string; quantity?: string; completed?: string },
  filter: string,
) {
  if (!filter) return true;
  return ['待生产', '生产中', '已完工'].includes(filter)
    ? flowStatusLabel(doc) === filter
    : doc.status === filter;
}
const id = z.number().int().positive();
const optionalId = id.nullable().default(null);
const text = z.string().trim().max(2000).default('');
const base = { date: dateSchema, notes: text, correctionOf: optionalId };
export const arrivalLineSchema = z.object({
  stockId: optionalId,
  purchaseLineId: optionalId,
  item: z
    .object(stockItemSchema.shape)
    .omit({ kind: true, productId: true })
    .extend({ unit: z.string().trim().min(1).max(20).default('张') }),
  quantity: positiveQuantity,
  ...inspectionFields,
  statedQuantity: quantityText.nullable().default(null),
  unitPrice: exactPriceSchema.nullable().default(null),
  priceBasis: z.enum(['area', 'quantity']).nullable().default('area'),
  statedArea: z
    .string()
    .trim()
    .regex(/^(0|[1-9]\d{0,14})(\.\d{1,12})?$/, '面积使用非负十进制数，最多12位小数')
    .nullable()
    .default(null),
  differenceReason: text,
});
export const arrivalSchema = z.object({
  ...base,
  isPlan: z.boolean().default(false),
  plannedDate: dateSchema.nullable().optional(),
  plannedTime: arrivalTimeSchema,
  actualTime: arrivalTimeSchema,
  supplierId: id,
  reference: z.string().trim().max(100).default(''),
  sourceId: z.string().uuid().nullable().default(null),
  lines: z.array(arrivalLineSchema).min(1).max(100),
}).refine((v) => v.isPlan ? !!v.plannedDate : !!v.reference, { message: '计划须填写预计到货日期；实际到货须填写送货单号或内部批次。', path: ['reference'] });
export const taskSchema = z.object({
  ...base,
  plannedDate: dateSchema.nullable().optional(),
  plannedTime: arrivalTimeSchema,
  productId: id,
  quantity: positiveQuantity,
  unit: z.string().trim().min(1).max(20),
  orderIds: z.array(id).max(100).default([]),
});
export const productionSchema = z
  .object({
    ...base,
    taskId: optionalId,
    productId: id,
    finishedStockId: id,
    goodQuantity: quantityText,
    scrapQuantity: quantityText.default('0'),
    operator: z.string().trim().min(1, '请填写实际操作人员').max(100),
    materials: z
      .array(
        z.object({ stockId: id, issued: positiveQuantity, returned: quantityText.default('0') }),
      )
      .min(1)
      .max(100),
  })
  .refine((v) => v.materials.every((m) => quantityUnits(m.returned) <= quantityUnits(m.issued)), {
    message: '退料数量不能超过领料数量',
    path: ['materials'],
  });
export const deliverySchema = z.object({
  ...base,
  plannedDate: dateSchema.nullable().optional(),
  plannedTime: arrivalTimeSchema,
  actualTime: arrivalTimeSchema,
  customerId: id,
  address: text,
  contact: text,
  phone: text,
  allowOverdelivery: z.boolean().default(false),
  overdeliveryReason: text,
  lines: z
    .array(
      z.object({
        orderId: id,
        orderLineId: id,
        stockId: id,
        quantity: positiveQuantity,
        notes: text,
      }),
    )
    .min(1)
    .max(100),
});
export const flowScheduleSchema = z.strictObject({
  plannedDate: dateSchema,
  plannedTime: arrivalTimeSchema.optional(),
  expectedVersion: z.number().int().positive(),
  requestId: z.string().uuid(),
});
export function flowInput(kind: FlowKind, raw: unknown): any {
  return {
    arrival: arrivalSchema,
    task: taskSchema,
    production: productionSchema,
    delivery: deliverySchema,
  }[kind].parse(raw);
}
// 十进制精确面积/金额。尺寸单位未知时返回null，不把未知尺寸当作毫米。
export function multiplyDecimal(values: string[], divisionScale = 0): string {
  let value = 1n,
    scale = divisionScale;
  for (const v of values) {
    const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(v);
    if (!match || Math.abs(Number(match[3] || 0)) > 400) throw new Error('无效十进制数');
    const [, a, b = '', exponent = '0'] = match,
      termScale = b.length - Number(exponent);
    value *= BigInt(a + b) * (termScale < 0 ? 10n ** BigInt(-termScale) : 1n);
    scale += Math.max(0, termScale);
  }
  const s = String(value).padStart(scale + 1, '0');
  return scale ? (s.slice(0, -scale) + '.' + s.slice(-scale)).replace(/\.?0+$/, '') : s;
}
export function sheetArea(item: any, quantity: string): string | null {
  if (
    item.unit !== '张' ||
    !['mm', 'cm'].includes(item.dimensionUnit) ||
    !(item.length > 0) ||
    !(item.width > 0)
  )
    return null;
  return multiplyDecimal(
    [String(item.length), String(item.width), quantity],
    item.dimensionUnit === 'mm' ? 6 : 4,
  );
}
export function purchaseLineAmount(line: any): string | null {
  if (line.unitPrice == null || line.priceBasis === null) return null;
  const basis = line.priceBasis === 'area' ? sheetArea(line, line.quantity) : line.quantity;
  return basis == null ? null : multiplyDecimal([basis, line.unitPrice]);
}
