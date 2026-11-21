import { z } from 'zod';
import { parseStoredJson } from '../core/index.js';
import { priceBases } from '../../shared/core/index.js';
import { taxModes } from '../../shared/finance/index.js';

/*
 * 财务事件存的来源单据快照（fin_events.snapshot）：同步时（events.ts）写，补财务资料、红字冲销并重做时
 * （event-handling.ts）在上面改；生成凭证、“改了什么”、成本计算、发票匹配读。写、读都按这里的结构核对。
 */

/** 快照里财务不读的项：原样留着。来源是库里单据按结构读出来的内容，都是 JSON 值（页面详情原样拿到） */
const untouched = z.json();
/** 快照里明细的纸板资料（到货明细的 item）：财务读品名、单位和按面积计价的长宽，别的项原样留着 */
const sourceItem = z
  .object({
    name: z.string().optional(),
    unit: z.string().optional(),
    length: z.number().nullable().optional(),
    width: z.number().nullable().optional(),
    dimensionUnit: z.string().nullable().optional(),
  })
  .catchall(untouched);
/** 快照里的一行明细（送货、到货明细）：财务读的那几项，别的项原样留着 */
const sourceLine = z.object({
  quantity: z.string(),
  unit: z.string().optional(),
  productName: z.string().optional(),
  unitPrice: z.string().nullable().optional(),
  unitPriceExact: z.string().optional(),
  priceBasis: z.enum(priceBases).nullable().optional(),
  taxMode: z.string().optional(),
  taxRate: z.string().optional(),
  stockId: z.number().nullable().optional(),
  purchaseLineId: z.number().nullable().optional(),
  orderId: z.number().optional(),
  orderLineId: z.number().optional(),
  orderNumber: z.string().optional(),
  purchaseId: z.number().nullable().optional(),
  purchaseNumber: z.string().optional(),
  productId: z.number().optional(),
  stockedQuantity: z.string().nullable().optional(),
  acceptedQuantity: z.string().nullable().optional(),
  item: sourceItem.optional(),
}).catchall(untouched);
/**
 * 来源单据的内容（送货、到货、完工单的 document 加上单号，盘点流水是流水几项拼的）：财务读的那几项，
 * 别的项原样留着（快照照旧存整份单据，“有差异”的改前改后对比从这里读）。
 */
const financeSourceDocument = z.object({
  number: z.string().optional(),
  reference: z.string().optional(),
  confirmedAt: z.string().optional(),
  customerId: z.number().optional(),
  customerName: z.string().optional(),
  supplierId: z.number().optional(),
  supplierName: z.string().optional(),
  correctionOf: z.number().nullable().optional(),
  correctionOfReceiptId: z.string().optional(),
  replacedBy: z.number().optional(),
  lines: z.array(sourceLine).optional(),
}).catchall(untouched);
export type FinanceSourceLine = z.output<typeof sourceLine>;
export type FinanceSourceDocument = z.output<typeof financeSourceDocument>;

/** 按单据内容算出的金额：整单和逐行的不含税、含税、税额（分），exact 是这一行的精确金额文字（amounts.ts） */
const documentMoney = z.strictObject({
  net: z.number(),
  gross: z.number(),
  tax: z.number(),
  lines: z.array(z.strictObject({ exact: z.string(), net: z.number(), gross: z.number(), tax: z.number() })),
});
/** 逐行算金额用的精确金额、含税口径和税率（空着是还缺） */
const financialLine = z.strictObject({ exact: z.string(), mode: z.string(), rate: z.string() });
/** 逐行的税率、口径从哪来：明细（line）、往来单位（party）、人补的（manual、party、no_tax）；没有是 null */
const taxSourceItem = z.strictObject({ rate: z.string().nullable(), mode: z.string().nullable() });
/** 资料待补缺的是什么：税率、数量、价格 */
const missingKinds = ['tax', 'quantity', 'price'] as const;

/**
 * 一条财务事件的快照。启用前的单据只记一个空的 {}，所以每项都可能没有。
 * previous 是被它接手的上一条事件（编号、指纹、状态），“改了什么”沿着它往前找。
 */
const eventSnapshot = z.strictObject({
  doc: financeSourceDocument.optional(),
  money: documentMoney.nullable().optional(),
  documentAmount: z.number().nullable().optional(),
  taxSource: z.array(taxSourceItem).optional(),
  theoretical: documentMoney.nullable().optional(),
  financialLines: z.array(financialLine).optional(),
  missing: z.array(z.enum(missingKinds)).optional(),
  warnings: z.array(z.string()).optional(),
  previous: z.strictObject({ eventId: z.number(), hash: z.string(), status: z.string() }).nullable().optional(),
  evidence: z.string().optional(),
});
export type EventSnapshot = z.output<typeof eventSnapshot>;
export type DocumentMoney = z.output<typeof documentMoney>;
/** 补财务资料时人填的一行：精确金额、含税口径、税率（event-handling.ts 收的，也是快照里 financialLines 的样子） */
export const evidenceLine = z.strictObject({
  exact: z.string().regex(/^\d{1,24}(\.\d{1,24})?$/),
  mode: z.enum(taxModes),
  rate: z
    .string()
    .trim()
    .regex(/^\d{1,3}(\.\d{1,6})?%?$/),
});

/** 读一条事件的快照 */
export function readSnapshot(event: { id: number; snapshot: string }): EventSnapshot {
  return parseStoredJson(eventSnapshot, event.snapshot, `fin_events.snapshot（财务事件 ${event.id}）`);
}

/** 写进 fin_events.snapshot 的文字：先按同一份结构核对，对不上是程序写错了（服务端错误，不是用户填错） */
export function snapshotText(snapshot: EventSnapshot): string {
  const checked = eventSnapshot.safeParse(snapshot);
  if (!checked.success) throw new Error('财务事件快照和结构对不上：' + checked.error.message, { cause: checked.error });
  return JSON.stringify(snapshot);
}

/*
 * 事件快照里单据字段的取法。快照的 doc 是抄来的业务单据（送货、到货、完工单的 document），
 * 财务别处取单号、往来单位、明细都走这几个，不各写一遍 JSON 路径。
 * column 是快照所在的列或表达式（默认 snapshot）；root 是快照在那段 JSON 里的位置（默认整段就是快照）。
 */

/** 单据的单号：单据号，没有时退用对方单号；再没有时用 fallback（SQL 表达式）。 */
export const snapshotNumber = (column = 'snapshot', fallback?: string, root = '$') =>
  `coalesce(json_extract(${column},'${root}.doc.number'),json_extract(${column},'${root}.doc.reference')${
    fallback ? ',' + fallback : ''
  })`;

/** 单据上的往来单位名称：客户名，没有时取供应商名。 */
export const snapshotPartyName = (column = 'snapshot', root = '$') =>
  `coalesce(json_extract(${column},'${root}.doc.customerName'),json_extract(${column},'${root}.doc.supplierName'))`;

/** 单据上往来单位编号的 JSON 路径 */
export const snapshotPartyIdPath = (kind: 'customer' | 'supplier') =>
  kind === 'customer' ? '$.doc.customerId' : '$.doc.supplierId';

/** 逐行展开单据明细（json_each，行在 value 里，行号在 key 里） */
export const snapshotLines = (column = 'snapshot') => `json_each(${column},'$.doc.lines')`;

/** JS 里取单号：单据号，没有时退用对方单号，再没有用 fallback。 */
export function documentNumber(
  doc: { number?: string; reference?: string } | null | undefined,
  fallback: string | null = null,
): string | null {
  return doc?.number ?? doc?.reference ?? fallback;
}
