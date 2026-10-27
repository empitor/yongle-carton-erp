import { z } from 'zod';
import { dateSchema, lineSchema, productSchema } from './domain.js';
import type { ImportMapping } from './import-mapping.js';
import type { PromptPresetUsage } from './prompt-presets.js';
import { parseDimension, normalizeDimensionUnit, productNotices } from './product-details.js';
import { inspectCurrency } from './currency.js';

export const sourceReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('excel'),
    fileId: z.string(),
    sheet: z.string(),
    row: z.number().int().positive(),
    columns: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('document'),
    fileId: z.string(),
    paragraph: z.number().int().positive(),
    page: z.number().int().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal('pdf'),
    fileId: z.string(),
    page: z.number().int().positive(),
    region: z.array(z.number()).length(4).optional(),
  }),
  z.strictObject({
    kind: z.literal('image'),
    fileId: z.string(),
    page: z.number().int().positive().optional(),
    region: z.array(z.number()).length(4),
    unit: z.literal('normalized'),
  }),
]);
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type SourceBlock = {
  id: string;
  text: string;
  ref: SourceReference;
  method: 'xml' | 'xls-binary' | 'doc-binary' | 'pdf-text' | 'windows-ocr' | 'vision-required';
};
export type ParsedFile = {
  format: 'xls' | 'xlsx' | 'docx' | 'doc' | 'pdf' | 'png' | 'jpg';
  blocks: SourceBlock[];
  previews: { page: number; name: string }[];
  warnings: string[];
  imagePages: number[];
};
export const headerFields = [
  'buyerName',
  'supplierName',
  'purchaseOrderNumber',
  'orderDate',
  'deliveryDate',
  'currency',
  'taxRate',
  'taxMode',
  'notes',
  'terms',
  'statedTotalQuantity',
  'statedTotalAmount',
] as const;
export const lineFields = [
  'productName',
  'productCode',
  'specification',
  'length',
  'width',
  'height',
  'dimensionUnit',
  'material',
  'flute',
  'requirements',
  'quantity',
  'unit',
  'unitPrice',
  'statedAmount',
  'taxRate',
  'taxMode',
  'deliveryDate',
  'notes',
] as const;
export type HeaderField = (typeof headerFields)[number];
export type LineField = (typeof lineFields)[number];
export const fieldLabels: Record<HeaderField | LineField, string> = {
  buyerName: '采购方／客户',
  supplierName: '供应方',
  purchaseOrderNumber: '客户采购订单号',
  orderDate: '订单日期',
  deliveryDate: '交货日期',
  currency: '币种',
  taxRate: '税率（%）',
  taxMode: '含税／未税',
  notes: '备注',
  terms: '合同条件',
  statedTotalQuantity: '原文数量合计',
  statedTotalAmount: '原文金额合计',
  productName: '产品名称',
  productCode: '客户物料编码',
  specification: '规格型号',
  length: '长',
  width: '宽',
  height: '高',
  dimensionUnit: '尺寸单位',
  material: '材质／配纸',
  flute: '楞型',
  requirements: '加工要求',
  quantity: '数量',
  unit: '数量单位',
  unitPrice: '单价（原币）',
  statedAmount: '原文行金额',
};
const fieldSchema = z.strictObject({
  value: z.string().max(2000).nullable(),
  sources: z.array(z.string().min(1).max(80)).max(30).default([]),
  quote: z.string().max(1000).default(''),
  certainty: z.enum(['recognized', 'needs-review', 'user-modified']),
  note: z.string().max(600),
});
const missingField = () => ({
  value: null,
  sources: [],
  quote: '',
  certainty: 'needs-review' as const,
  note: '原件未提供或尚未识别',
});
// 缺失字段仅补“未知”包装，不生成业务事实；错误类型和越界值仍按Schema拒绝。
const draftInputFieldSchema = z
  .preprocess((v) => (v === null ? missingField() : v), fieldSchema)
  .default(missingField);
const headerShape = Object.fromEntries(
  headerFields.map((k) => [k, draftInputFieldSchema]),
) as Record<HeaderField, typeof draftInputFieldSchema>;
const lineShape = Object.fromEntries(lineFields.map((k) => [k, draftInputFieldSchema])) as Record<
  LineField,
  typeof draftInputFieldSchema
>;
export const analysisSchema = z.strictObject({
  header: z.strictObject(headerShape),
  lines: z.array(z.strictObject(lineShape)).min(1).max(50),
  warnings: z.array(z.string().max(1000)).max(60).default([]),
});
export type DraftField = z.infer<typeof fieldSchema>;
export type OrderDraft = {
  header: Record<HeaderField, DraftField>;
  lines: { id: string; fields: Record<LineField, DraftField> }[];
  warnings: string[];
};
export const patchOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('set-header'),
    field: z.enum(headerFields),
    value: z.string().max(2000).nullable(),
    reason: z.string().max(600),
  }),
  z.strictObject({
    op: z.literal('set-line'),
    lineId: z.string().uuid(),
    field: z.enum(lineFields),
    value: z.string().max(2000).nullable(),
    reason: z.string().max(600),
  }),
]);
export const chatReplySchema = z.strictObject({
  reply: z.string().min(1).max(5000),
  operations: z.array(patchOperationSchema).max(100),
  questions: z.array(z.string().max(1000)).max(20),
});
export type DraftOperation = z.infer<typeof patchOperationSchema>;
export type DraftIssue = { path: string; message: string; severity: 'error' | 'review' };
export type DraftEvaluation = {
  issues: DraftIssue[];
  lineAmounts: Record<string, string | null>;
  totalQuantity: string | null;
  totalAmount: string | null;
};
export type DraftChange = {
  path: string;
  label: string;
  before: string | null;
  after: string | null;
  reason: string;
};
export type ImportedOrderRef = {
  orderId: number;
  orderNumber: string;
  executionId: string;
  archived: boolean;
  permanentlyDeleted?: boolean;
  historical?: boolean;
  sourceId?: string;
};
export type ImportWorkspaceView = {
  id: string;
  revision: number;
  fileName: string;
  fileHash: string;
  size: number;
  createdAt: string;
  parsed: ParsedFile;
  draft: OrderDraft | null;
  /** 每个导入文件独立的识别模式；默认订单识别。 */
  mode?: 'order' | 'arrival';
  /** 已关联的供应商到货草稿（正式入库仍走 FlowService）。 */
  arrivalDocId?: number | null;
  arrivalSourceId?: string | null;
  evaluation: DraftEvaluation | null;
  confirmedRevision: number | null;
  confirmedBy?: { id: string; name: string } | null;
  messages: { role: 'user' | 'assistant'; text: string; at: string }[];
  changes: DraftChange[];
  canUndo: boolean;
  consent: {
    id: string;
    endpoint: string;
    model: string;
    expiresAt: string;
    scope: string;
    policyVersion?: number;
    apiStyle?: 'chat-completions' | 'responses';
  } | null;
  mapping?: ImportMapping;
  task?: {
    state: 'uploaded' | 'queued' | 'backoff' | 'running' | 'ready' | 'failed' | 'cancelled';
    error?: string;
    failureId?: string;
    diagnosticStorageError?: string;
    progress?: import('./ai-runtime').AiProgress;
    position?: number;
    limit?: number;
  };
  promptVersion?: string;
  promptPreset?: PromptPresetUsage;
  inputMode?: 'raw-file' | 'deepseek-compatible';
  imported?: ImportedOrderRef;
  historyImport?: ImportedOrderRef;
};
type Decimal = { value: bigint; scale: number };
function decimal(v: string): Decimal | null {
  v = v.trim();
  if (!/^(?:0|[1-9]\d{0,14})(?:\.\d{1,12})?$/.test(v)) return null;
  const [a, b = ''] = v.split('.');
  return { value: BigInt(a + b), scale: b.length };
}
function format(d: Decimal): string {
  const s = d.value.toString().padStart(d.scale + 1, '0');
  return d.scale ? s.slice(0, -d.scale) + '.' + s.slice(-d.scale) : s;
}
function sum(values: Decimal[]): Decimal {
  const scale = Math.max(0, ...values.map((v) => v.scale));
  return {
    scale,
    value: values.reduce((s, v) => s + v.value * 10n ** BigInt(scale - v.scale), 0n),
  };
}
function equal(a: Decimal, b: Decimal) {
  return sum([a]).value * 10n ** BigInt(b.scale) === b.value * 10n ** BigInt(a.scale);
}
export function multiplyExact(a: string, b: string): string | null {
  const x = decimal(a),
    y = decimal(b);
  return x && y ? format({ value: x.value * y.value, scale: x.scale + y.scale }) : null;
}
export const verifiedCalculationNote = '后端确认修改前原金额一致；';
const calculatedEdit = (f: DraftField) =>
  f.certainty === 'user-modified' && f.note.startsWith(verifiedCalculationNote);
export function evaluateDraft(draft: OrderDraft): DraftEvaluation {
  const issues: DraftIssue[] = [],
    amounts: Decimal[] = [],
    quantities: Decimal[] = [],
    lineAmounts: Record<string, string | null> = {};
  const issue = (path: string, message: string, severity: 'error' | 'review' = 'review') =>
    issues.push({ path, message, severity });
  for (const k of headerFields) {
    const f = draft.header[k];
    if (f.certainty === 'needs-review' && k !== 'currency')
      issue('header.' + k, fieldLabels[k] + '待确认：' + (f.note || '请对照原件'));
  }
  for (const k of ['buyerName', 'orderDate', 'deliveryDate'] as const)
    if (!draft.header[k].value) issue('header.' + k, fieldLabels[k] + '缺失');
  if ((draft.header.buyerName.value || '').replace(/\s/g, '').includes('宁波甬勒包装制品有限公司'))
    issue('header.buyerName', '采购方被识别为本公司，请核对采购方与供应方。', 'error');
  for (const k of ['orderDate', 'deliveryDate'] as const)
    if (draft.header[k].value && !dateSchema.safeParse(draft.header[k].value).success)
      issue('header.' + k, '日期必须是明确有效的 YYYY-MM-DD。', 'error');
  if (
    draft.header.orderDate.value &&
    draft.header.deliveryDate.value &&
    draft.header.deliveryDate.value < draft.header.orderDate.value
  )
    issue('header.deliveryDate', '交货日期早于订单日期。', 'error');
  const currency = inspectCurrency(draft.header.currency.value);
  if (currency.message)
    issue('header.currency', currency.message, currency.currency ? 'review' : 'error');
  else if (draft.header.currency.certainty === 'needs-review')
    issue('header.currency', '币种按人民币（CNY）保存，请对照原件核对。');
  if (!draft.header.taxMode.value) issue('header.taxMode', '原件未明确含税口径，不能自行推断。');
  for (const line of draft.lines) {
    const prefix = 'lines.' + line.id + '.',
      f = line.fields;
    for (const k of lineFields)
      if (
        f[k].certainty === 'needs-review' &&
        (!['length', 'width', 'height', 'dimensionUnit', 'material', 'flute'].includes(k) ||
          !!f[k].value)
      )
        issue(prefix + k, fieldLabels[k] + '待确认：' + (f[k].note || '请对照原件'));
    const q = decimal(f.quantity.value || ''),
      p = decimal(f.unitPrice.value || '');
    if (!q || q.value === 0n) issue(prefix + 'quantity', '数量缺失或不是有效正数。', 'error');
    else {
      quantities.push(q);
      if (q.scale > 0 || !lineSchema.shape.quantity.safeParse(Number(q.value)).success)
        issue(prefix + 'quantity', '当前 ERP 只支持不超过 1000000 的整数数量。');
    }
    if (!p) issue(prefix + 'unitPrice', '单价缺失或格式无效。', 'error');
    else if (p.scale > 4)
      issue(prefix + 'unitPrice', '原始单价超过四位小数，当前正式订单仍需人工处理；未四舍五入。');
    else if (
      !lineSchema.shape.unitPriceCents.safeParse(Number((p.value * 100n) / 10n ** BigInt(p.scale)))
        .success
    )
      issue(prefix + 'unitPrice', '原文单价超过当前 ERP 可保存的金额范围，草稿原值已保留。');
    for (const k of ['length', 'width', 'height'] as const) {
      if (f[k].value) {
        try {
          const n = parseDimension(f[k].value);
          if (normalizeDimensionUnit(f.dimensionUnit.value) === 'cm' && n !== null && n > 1000)
            throw new Error();
        } catch {
          issue(
            'products.' + (f.productName.value || line.id) + '.' + k,
            '产品“' +
              (f.productName.value || '未命名') +
              '”' +
              fieldLabels[k] +
              '必须为有效正数且不超过10000mm或1000cm；未知时可留空。',
            'error',
          );
        }
      }
    }
    if (!f.productName.value) issue(prefix + 'productName', '产品名称缺失。', 'error');
    if (f.unit.value !== '只')
      issue(prefix + 'unit', '数量单位不是明确的“只”，需人工核对单位映射。');
    if (!f.specification.value) issue(prefix + 'specification', '产品规格未识别。');
    const computed = q && p ? { value: q.value * p.value, scale: q.scale + p.scale } : null;
    lineAmounts[line.id] = computed ? format(computed) : null;
    if (computed) amounts.push(computed);
    const stated = decimal(f.statedAmount.value || '');
    if (f.statedAmount.value?.trim() && !stated)
      issue(prefix + 'statedAmount', '原文行金额不是有效数值，请核对后修正，不能忽略。', 'error');
    if (stated && computed && !equal(stated, computed))
      issue(
        prefix + 'statedAmount',
        (calculatedEdit(f.quantity) || calculatedEdit(f.unitPrice)) &&
          f.statedAmount.certainty !== 'user-modified'
          ? '数量或单价经用户修改，正式金额按新值重算；原文行金额保留供对照，请核对。'
          : '原文行金额与数量 × 单价不一致，请核对折扣、税费或识别错误。',
        (calculatedEdit(f.quantity) || calculatedEdit(f.unitPrice)) &&
          f.statedAmount.certainty !== 'user-modified'
          ? 'review'
          : 'error',
      );
  }
  const totalQ = quantities.length === draft.lines.length ? sum(quantities) : null,
    totalA = amounts.length === draft.lines.length ? sum(amounts) : null;
  for (const [k, computed] of [
    ['statedTotalQuantity', totalQ],
    ['statedTotalAmount', totalA],
  ] as const) {
    const stated = decimal(draft.header[k].value || '');
    if (draft.header[k].value?.trim() && !stated)
      issue('header.' + k, fieldLabels[k] + '不是有效数值，请核对后修正。', 'error');
    if (stated && computed && !equal(stated, computed))
      issue(
        'header.' + k,
        draft.header[k].certainty !== 'user-modified' &&
          draft.lines.some(
            (l) =>
              calculatedEdit(l.fields.quantity) ||
              (k === 'statedTotalAmount' && calculatedEdit(l.fields.unitPrice)),
          )
          ? fieldLabels[k] + '保留原文值；用户已修改数量/单价，正式订单使用后端新合计，请核对。'
          : fieldLabels[k] + '与后端计算值不一致，不能把数量合计当作金额。',
        draft.header[k].certainty !== 'user-modified' &&
          draft.lines.some(
            (l) =>
              calculatedEdit(l.fields.quantity) ||
              (k === 'statedTotalAmount' && calculatedEdit(l.fields.unitPrice)),
          )
          ? 'review'
          : 'error',
      );
  }
  const details = draft.lines.map(({ fields: f }) => ({
    name: f.productName.value,
    length: f.length.value ? Number(f.length.value) : null,
    width: f.width.value ? Number(f.width.value) : null,
    height: f.height.value ? Number(f.height.value) : null,
    material: f.material.value,
    flute: f.flute.value,
    dimensionUnit: f.dimensionUnit.value,
  }));
  for (const text of productNotices(details)) issue('products.optional', text);
  return {
    issues: issues.filter(
      (v, i, a) =>
        a.findIndex(
          (x) => x.path === v.path && x.message === v.message && x.severity === v.severity,
        ) === i,
    ),
    lineAmounts,
    totalQuantity: totalQ ? format(totalQ) : null,
    totalAmount: totalA ? format(totalA) : null,
  };
}
export const blankField = (): DraftField => missingField();
