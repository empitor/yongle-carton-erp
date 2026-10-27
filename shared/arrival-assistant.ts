import { z } from 'zod';
import { dateSchema, exactPriceSchema } from './domain.js';
import { dimensionValueSchema } from './product-details.js';
import { convertArrivalUnit, matchingArrivalStock } from './arrival-draft.js';
const text = (max = 2000) => z.string().max(max);
const id = z.number().int().positive();
export const arrivalReviewSchema = z.object({
  supplierId: id.nullable(),
  date: z.union([z.literal(''), dateSchema]),
  reference: text(100),
  sourceId: z.string().uuid(),
  notes: text(),
  lines: z
    .array(
      z.object({
        stockId: id.nullable(),
        purchaseLineId: id.nullable(),
        item: z.object({
          name: text(100),
          specification: text(),
          material: text(100),
          flute: text(50),
          length: dimensionValueSchema,
          width: dimensionValueSchema,
          height: dimensionValueSchema,
          dimensionUnit: z.enum(['mm', 'cm']).nullable(),
          unit: z.literal('张'),
          notes: text(1000),
        }),
        quantity: text(100),
        statedQuantity: text(100).nullable(),
        unitPrice: text(100).nullable(),
        priceBasis: z.enum(['area', 'quantity']).nullable(),
        statedArea: text(100).nullable(),
        differenceReason: text(),
      }),
    )
    .min(1)
    .max(100),
});
export const arrivalHeaderFields = ['date', 'reference', 'notes'] as const;
export const arrivalLineFields = [
  'name',
  'specification',
  'material',
  'flute',
  'length',
  'width',
  'height',
  'dimensionUnit',
  'notes',
  'quantity',
  'unitPrice',
  'priceBasis',
  'statedArea',
  'statedQuantity',
  'differenceReason',
] as const;
const reason = z.string().min(1).max(500);
export const arrivalOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('set-header'),
    field: z.enum(arrivalHeaderFields),
    value: z.string().nullable(),
    reason,
  }),
  z.strictObject({
    op: z.literal('set-line'),
    line: z.number().int().min(1).max(100),
    field: z.enum(arrivalLineFields),
    value: z.string().nullable(),
    reason,
  }),
  z.strictObject({ op: z.literal('match-supplier'), id, reason }),
  z.strictObject({
    op: z.literal('match-stock'),
    line: z.number().int().min(1).max(100),
    id: id.nullable(),
    reason,
  }),
  z.strictObject({
    op: z.literal('match-purchase'),
    line: z.number().int().min(1).max(100),
    id: id.nullable(),
    reason,
  }),
]);
export const arrivalChatReplySchema = z.strictObject({
  reply: z.string().max(16000),
  operations: z.array(arrivalOperationSchema).max(60).default([]),
  questions: z.array(z.string().max(1000)).max(20).default([]),
  lookups: z
    .array(
      z.strictObject({
        kind: z.enum(['suppliers', 'materials', 'purchases']),
        query: z.string().trim().min(1).max(100),
        line: z.number().int().positive().max(100).optional(),
      }),
    )
    .max(3)
    .default([]),
});
export type ArrivalOperation = z.infer<typeof arrivalOperationSchema>;
export type ArrivalChange = { field: string; before: unknown; after: unknown; reason: string };
export const arrivalFieldNames: Record<string, string> = {
  supplierId: '供应商',
  date: '到货日期',
  reference: '送货单号',
  notes: '备注',
  name: '纸板名称',
  specification: '规格型号',
  material: '材质',
  flute: '楞型',
  length: '长',
  width: '宽',
  height: '高',
  dimensionUnit: '尺寸单位',
  quantity: '实收张数',
  unitPrice: '单价',
  priceBasis: '计价方式',
  statedArea: '原单面积',
  statedQuantity: '原单张数',
  differenceReason: '差异说明',
  stockId: '原材料档案',
  purchaseLineId: '采购明细',
};
/** 只改核对草稿；完整到货校验和库存影响仍留给原FlowService。 */
export function applyArrivalOperations(
  raw: unknown,
  operations: ArrivalOperation[],
  catalog: { suppliers: any[]; items: any[]; purchases: any[] },
  evidence: Record<string, Set<number>>,
) {
  const draft = arrivalReviewSchema.parse(raw),
    changes: ArrivalChange[] = [];
  const set = (obj: any, key: string, value: unknown, label: string, why: string) => {
    if (JSON.stringify(obj[key]) === JSON.stringify(value)) return;
    changes.push({ field: label, before: obj[key], after: value, reason: why });
    obj[key] = value;
  };
  const ordered = [
    ...operations.filter((o) => o.op === 'set-line' && o.field === 'dimensionUnit'),
    ...operations.filter((o) => !(o.op === 'set-line' && o.field === 'dimensionUnit')),
  ];
  for (const op of ordered) {
    if (op.op === 'set-header') {
      if (op.field === 'date' && op.value) dateSchema.parse(op.value);
      set(draft, op.field, op.value || '', arrivalFieldNames[op.field], op.reason);
      continue;
    }
    if (op.op === 'match-supplier') {
      if (!catalog.suppliers.some((s) => s.id === op.id) || !evidence.suppliers?.has(op.id))
        throw Error('供应商未唯一匹配，请先查询并选择明确档案。');
      if (draft.supplierId !== op.id) {
        set(draft, 'supplierId', op.id, '供应商', op.reason);
        for (const [i, l] of draft.lines.entries())
          set(
            l,
            'purchaseLineId',
            null,
            `第${i + 1}行 · 采购明细`,
            '供应商变化，原采购关联待重新选择',
          );
      }
      continue;
    }
    const l = draft.lines[op.line - 1];
    if (!l) throw Error('到货明细行号不存在。');
    const prefix = `第${op.line}行 · `;
    if (op.op === 'match-stock') {
      const match = op.id === null ? null : catalog.items.find((s) => s.id === op.id);
      if (
        op.id !== null &&
        (!match || !evidence.materials?.has(op.id) || !matchingArrivalStock(l.item, match))
      )
        throw Error('原材料未唯一匹配或规格、尺寸、材质、楞型、单位不一致。');
      set(l, 'stockId', op.id, prefix + '原材料档案', op.reason);
      continue;
    }
    if (op.op === 'match-purchase') {
      const p = catalog.purchases.find(
        (p) =>
          p.supplierId === draft.supplierId &&
          p.baseStatus === '已订货' &&
          !p.archived &&
          p.lines.some((x: any) => x.id === op.id),
      );
      const line = p?.lines.find((x: any) => x.id === op.id);
      if (
        op.id !== null &&
        (!line ||
          !evidence.purchases?.has(op.id) ||
          !matchingArrivalStock(l.item, { ...line, kind: 'raw' }))
      )
        throw Error('采购明细未唯一匹配或不属于当前供应商及纸板规格。');
      set(l, 'purchaseLineId', op.id, prefix + '采购明细', op.reason);
      if (line?.stockItemId)
        set(l, 'stockId', line.stockItemId, prefix + '原材料档案', '使用采购明细已关联的库存档案');
      continue;
    }
    const inItem = [
        'name',
        'specification',
        'material',
        'flute',
        'length',
        'width',
        'height',
        'dimensionUnit',
        'notes',
      ].includes(op.field),
      obj: any = inItem ? l.item : l;
    let value: unknown = op.value?.trim() || null;
    if (op.field === 'quantity')
      z.string()
        .regex(/^[1-9]\d{0,8}$/, '纸板实收必须使用正整数张')
        .parse(value);
    if (op.field === 'unitPrice') exactPriceSchema.nullable().parse(value);
    if (op.field === 'statedArea')
      z.string()
        .regex(/^(0|[1-9]\d{0,14})(\.\d{1,12})?$/, '面积最多12位小数')
        .nullable()
        .parse(value);
    if (op.field === 'statedQuantity')
      z.string()
        .regex(/^(0|[1-9]\d{0,8})(\.\d{1,3})?$/, '原单张数使用明确数字')
        .nullable()
        .parse(value);
    if (op.field === 'dimensionUnit') {
      if (value !== null && !['mm', 'cm'].includes(String(value)))
        throw Error('尺寸单位只支持mm或cm，未知单位请留空。');
      const converted = convertArrivalUnit(l.item, value as 'mm' | 'cm' | null);
      for (const key of ['length', 'width', 'height', 'dimensionUnit'])
        set(l.item, key, (converted as any)[key], prefix + arrivalFieldNames[key], op.reason);
    } else {
      if (['length', 'width', 'height'].includes(op.field))
        value = value === null ? null : Number(value);
      else if (
        [
          'name',
          'specification',
          'material',
          'flute',
          'notes',
          'quantity',
          'differenceReason',
        ].includes(op.field)
      )
        value = value ?? '';
      set(obj, op.field, value, prefix + arrivalFieldNames[op.field], op.reason);
      if (
        op.field === 'quantity' &&
        l.statedQuantity !== null &&
        l.quantity !== l.statedQuantity &&
        !l.differenceReason
      )
        set(
          l,
          'differenceReason',
          '用户通过到货助手修改实收张数，原单张数保留供核对。',
          prefix + '差异说明',
          '保留原文数量，不混同实际收货',
        );
    }
  }
  for (const [i, l] of draft.lines.entries()) {
    if (
      l.stockId &&
      !catalog.items.some((s) => s.id === l.stockId && matchingArrivalStock(l.item, s))
    )
      set(l, 'stockId', null, `第${i + 1}行 · 原材料档案`, '纸板资料变化，原库存匹配已失效');
    if (
      l.purchaseLineId &&
      !catalog.purchases.some(
        (p) =>
          p.supplierId === draft.supplierId &&
          p.baseStatus === '已订货' &&
          !p.archived &&
          p.lines.some(
            (x: any) =>
              x.id === l.purchaseLineId && matchingArrivalStock(l.item, { ...x, kind: 'raw' }),
          ),
      )
    )
      set(
        l,
        'purchaseLineId',
        null,
        `第${i + 1}行 · 采购明细`,
        '纸板或供应商变化，原采购匹配已失效',
      );
  }
  const unique = new Map<string, ArrivalChange>();
  for (const c of changes) {
    const prior = unique.get(c.field);
    unique.set(c.field, prior ? { ...c, before: prior.before } : c);
  }
  return {
    draft: arrivalReviewSchema.parse(draft),
    changes: [...unique.values()].filter(
      (c) => JSON.stringify(c.before) !== JSON.stringify(c.after),
    ),
  };
}
