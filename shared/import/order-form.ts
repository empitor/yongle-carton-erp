import { z } from 'zod';
import { MAX_ORDER_LINES } from '../core/index.js';
import {
  blankField,
  DRAFT_NOTE_MAX,
  DRAFT_VALUE_MAX,
  draftHeaderSchema,
  draftLineFieldsSchema,
  fieldLabels,
  headerFields,
  lineFields,
  type DraftField,
  type HeaderField,
  type LineField,
  type OrderDraft,
} from './order-draft.js';

/*
 * 订单识别的“表”：交给模型填的就是这张表（一个工具的参数），栏目、中文叫法和识别结果页的录入表同一份
 * （order-draft.ts 的 headerFields、lineFields、fieldLabels）。每栏只填原件上的字，没写的留空；
 * 拿不准的列进“拿不准”。哪些栏缺、哪些要核对，由程序按空着和拿不准算（evaluateDraft），不让模型填状态。
 */

/** 每栏一句说明（叫法之外表里还要说清的），没有的只用叫法 */
const hints: Partial<Record<HeaderField | LineField, string>> = {
  buyerName: '下单的那一家（合同甲方），一般是抬头或落款的公司名，名称逐字照抄',
  supplierName: '接单的那一方（通常是本公司）',
  purchaseOrderNumber: '客户自己的采购单号或合同号，照原文写全',
  orderDate: 'YYYY-MM-DD',
  currency: '照原文写（人民币、美元等）',
  taxRate: '只写数字',
  taxMode: '照原文写含税或未税',
  terms: '付款、交货、违约等条款',
  productName: '原件上的存货名称，照原文写全，原文带的大小、颜色、型号这类区分的字不能丢，不拼尺寸和包装说明',
  productCode: '料号',
  specification: '尺寸、型号等，照原文写，原文没写单位就不要补单位',
  length: '只写数字',
  width: '只写数字',
  height: '只写数字',
  dimensionUnit: 'mm 或 cm，原文没写单位就留空，不要补',
  requirements: '印刷、开槽、模切、钉箱、粘箱等',
  quantity: '只写数字',
  unit: '照原文写（只、个、箱等），不换算',
  unitPrice: '照原文保留小数位（如 1.3000）；有含税单价时填含税单价',
  statedAmount: '和单价同一口径（含税单价对应价税合计）',
  notes: '包装要求、特殊说明',
};
/** 整单交期和行交期叫法一样，整单的那一栏单独说一句 */
const headerHints: Partial<Record<HeaderField, string>> = {
  deliveryDate: '整单交期，YYYY-MM-DD；原件只写了各行交期就留空',
  notes: '整单备注',
};
const lineHints: Partial<Record<LineField, string>> = { deliveryDate: '本行交期，YYYY-MM-DD' };

/** 识别表的一格：文字或空；模型交数字也收，转成文字。长度在转成识别结果时截 */
export const formCell = (description: string) =>
  z
    .preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().nullable())
    .optional()
    .describe(description);
const cell = formCell;
const describe = (k: HeaderField | LineField, extra?: string) => {
  const hint = extra ?? hints[k];
  return hint ? fieldLabels[k] + '：' + hint : fieldLabels[k];
};
const headerFieldNames: readonly string[] = headerFields;
/** 整单的栏目在前，明细里整单没有的栏目在后（和整单同名的只列一次） */
const allFields = [...headerFields, ...lineFields.filter((k) => !headerFieldNames.includes(k))] as const;
/** 识别表的几个上限：拿不准的原因多长、最多几条，提醒最多几条（一张订单最多几行和订单本身一样，MAX_ORDER_LINES） */
const DOUBT_REASON_MAX = 300;
const DOUBTS_MAX = 200;
const WARNINGS_MAX = 60;
/** 每张识别表最后两栏：拿不准的栏目（哪一行、哪一栏、为什么），和别的提醒 */
export const doubtColumns = <F extends readonly [string, ...string[]]>(fields: F, maxLine: number) => ({
  uncertain: z
    .array(
      z.object({
        line: z.number().int().min(1).max(maxLine).nullable().optional().describe('第几行明细；整单的栏目不填'),
        field: z.enum(fields).describe('哪一栏'),
        reason: z.string().max(DOUBT_REASON_MAX).describe('为什么拿不准'),
      }),
    )
    .max(DOUBTS_MAX)
    .default([])
    .describe('看不清、拿不准的栏目，一栏一条'),
  warnings: z.array(z.string().max(1000)).max(WARNINGS_MAX).default([]).describe('其他要提醒人核对的事，一句一条'),
});
/** 去掉 JSON Schema 的 $schema 头，作工具参数 */
export const toolParameters = (schema: z.ZodType) => {
  const { $schema: _, ...parameters } = z.toJSONSchema(schema) as Record<string, unknown>;
  return parameters;
};

export const orderFormSchema = z.object({
  header: z.object(Object.fromEntries(headerFields.map((k) => [k, cell(describe(k, headerHints[k]))]))).describe('整单'),
  lines: z
    .array(z.object(Object.fromEntries(lineFields.map((k) => [k, cell(describe(k, lineHints[k]))]))))
    .min(1)
    .max(MAX_ORDER_LINES)
    .describe('订单明细，一行一个产品，照原件顺序'),
  ...doubtColumns(allFields, MAX_ORDER_LINES),
});
export type OrderForm = z.infer<typeof orderFormSchema>;

/** 全是空格算没填；有字的照原样留（前后空格也是原件上的样子，比较时由各处的比较键处理） */
const filled = (v: string | null | undefined) => (v?.trim() ? v.slice(0, DRAFT_VALUE_MAX) : null);
const lineFieldNames: readonly string[] = lineFields;
/** 填好的表 → 识别结果：空着的是“原件未提供”，拿不准的标待核对、写明原因，其余算识别出 */
export function draftFromForm(form: OrderForm): Omit<OrderDraft, 'lines'> & { lines: Record<LineField, DraftField>[] } {
  const doubts = new Map<string, string>(),
    warnings = [...form.warnings];
  const known = (line: number | null | undefined, field: string) =>
    line ? line <= form.lines.length && lineFieldNames.includes(field) : headerFieldNames.includes(field);
  for (const u of form.uncertain) {
    if (known(u.line, u.field)) doubts.set((u.line || 0) + ':' + u.field, u.reason);
    else warnings.push((u.line ? '第 ' + u.line + ' 行' : '整单') + fieldLabels[u.field] + '：' + u.reason);
  }
  const field = (value: string | null | undefined, doubt: string | undefined): DraftField => {
    const v = filled(value);
    if (doubt !== undefined) return { value: v, certainty: 'needs-review', note: doubt.slice(0, DRAFT_NOTE_MAX) };
    return v === null ? blankField() : { value: v, certainty: 'recognized', note: '' };
  };
  // 按栏目逐个填好，交给结构认一遍，得到“每栏都有”的记录类型
  const header = draftHeaderSchema.parse(
    Object.fromEntries(headerFields.map((k) => [k, field(form.header[k], doubts.get('0:' + k))])),
  );
  const lines = form.lines.map((line, i) =>
    draftLineFieldsSchema.parse(
      Object.fromEntries(lineFields.map((k) => [k, field(line[k], doubts.get(i + 1 + ':' + k))])),
    ),
  );
  return { header, lines, warnings: [...new Set(warnings)].slice(0, WARNINGS_MAX) };
}

/** 交给模型的工具：名字、一句用途、参数就是这张表 */
export function orderFormTool() {
  return { name: 'submit_order', description: '交回从原件上读到的订单（只填原件上写了的）', parameters: toolParameters(orderFormSchema) };
}
