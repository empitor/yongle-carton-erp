import { z } from 'zod';
import { DRAFT_VALUE_MAX, doubtColumns, formCell as cell, toolParameters, type ReceiptResult } from '../../shared/import/index.js';

/*
 * 到货识别的“表”：交给模型填的就是这张表（一个工具的参数）。每栏只填原件上的字，没写的留空；
 * 拿不准的列进“拿不准”，交回后转成识别结果（存进原件记录，到货页按它预填）。
 */
const lineColumns = {
  name: cell('纸板名称：照原文写全，原文带的大小、颜色、型号这类区分的字不能丢'),
  specification: cell('规格：照原文写，原文没写单位就不要补单位'),
  material: cell('材质'),
  flute: cell('楞型'),
  length: cell('长：只写数字'),
  width: cell('宽：只写数字'),
  dimensionUnit: cell('尺寸单位：mm 或 cm，原文没写单位就留空，不要补'),
  quantity: cell('数量（张）：只写数字'),
  unit: cell('数量单位：照原文写'),
  area: cell('面积（m²）：只写数字'),
  unitPrice: cell('单价：照原文保留小数位'),
  priceBasis: z
    .enum(['area', 'quantity'])
    .nullable()
    .optional()
    .describe('计价方式：area 按面积，quantity 按张；原件看不出就留空'),
  notes: cell('备注'),
};
const headColumns = {
  supplierName: cell('供应商：发货的那一家，一般是抬头或落款的公司名，不是本公司'),
  reference: cell('送货单号：供应商这张送货单自己的单号，照原文写全'),
  purchaseNumber: cell('关联的采购单号：送货单上写的本公司采购单号或订单号'),
  date: cell('送货日期：YYYY-MM-DD'),
  notes: cell('备注'),
};
/** 一张送货单最多几行明细 */
const RECEIPT_LINES_MAX = 100;
/** 拿不准的栏目可以填哪些：整单的在前，明细里整单没有的在后 */
const [firstField, ...otherFields] = [...new Set([...Object.keys(headColumns), ...Object.keys(lineColumns)])];
const fields: [string, ...string[]] = [firstField, ...otherFields];
export const receiptFormSchema = z.object({
  ...headColumns,
  lines: z.array(z.object(lineColumns)).min(1).max(RECEIPT_LINES_MAX).describe('送货明细，一行一种纸板，照原件顺序'),
  ...doubtColumns(fields, RECEIPT_LINES_MAX),
});
export const receiptFormTool = () => ({
  name: 'submit_delivery_note',
  description: '交回从原件上读到的供应商送货单（只填原件上写了的）',
  parameters: toolParameters(receiptFormSchema),
});

/** 栏目的中文叫法：说明里冒号前那段 */
const columnLabels = new Map<string, string>(
  Object.entries({ ...headColumns, ...lineColumns }).map(([key, column]) => [key, (column.description ?? '').split('：')[0]]),
);
const label = (field: string) => columnLabels.get(field) ?? '';
const text = (v: string | null | undefined) => (v?.trim() ? v.slice(0, DRAFT_VALUE_MAX) : null);
/** 填好的表 → 识别结果：空格子是 null；拿不准的写进提醒（到货页列给人看） */
export function receiptFromForm(raw: unknown): ReceiptResult {
  const form = receiptFormSchema.parse(raw);
  const doubts = form.uncertain.map((u) => (u.line ? '第 ' + u.line + ' 行' : '') + label(u.field) + '拿不准：' + u.reason);
  return {
    supplierName: text(form.supplierName),
    reference: text(form.reference),
    purchaseNumber: text(form.purchaseNumber),
    date: text(form.date),
    notes: text(form.notes),
    warnings: [...new Set([...form.warnings, ...doubts])].slice(0, 100),
    lines: form.lines.map((l) => ({
      name: text(l.name),
      specification: text(l.specification),
      material: text(l.material),
      flute: text(l.flute),
      length: text(l.length),
      width: text(l.width),
      dimensionUnit: text(l.dimensionUnit),
      quantity: text(l.quantity),
      unit: text(l.unit),
      area: text(l.area),
      unitPrice: text(l.unitPrice),
      priceBasis: l.priceBasis ?? null,
      notes: text(l.notes),
    })),
  };
}