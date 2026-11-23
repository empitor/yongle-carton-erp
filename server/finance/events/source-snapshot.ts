import { z } from 'zod';
import { parseStoredJson } from '../../core/index.js';
import { financeSourceSchemas } from '../../../shared/business/index.js';
import { storedTaxModes } from '../../../shared/finance/index.js';

/*
 * 财务事件存的来源单据快照（fin_events.snapshot）：同步时（events.ts）写，补财务资料、红字冲销并重做时
 * （event-handling.ts）在上面改，都经 event-columns.ts 和从它取出来的几列一起写；生成凭证、“改了什么”、成本计算、
 * 发票匹配读。写、读都按这里的结构核对。往来单位、单号、理论金额、缺税率按 SQL 查的时候读列，不按 JSON 路径读快照。
 */

const { delivery, arrival, production, stock } = financeSourceSchemas;
const deliveryLine = delivery.shape.lines.element.shape,
  arrivalLine = arrival.shape.lines.element.shape;
/** 快照里的一行明细：送货、到货明细的财务口径合在一起读（快照不记种类，种类在事件行上），纸板资料只有到货明细有 */
const sourceLine = z
  .object({ ...deliveryLine, ...arrivalLine, item: arrivalLine.item.partial() })
  .partial()
  .extend({ quantity: arrivalLine.quantity });
/**
 * 快照里的来源内容（doc）：四种来源的财务口径（shared/business/flow/finance-source.ts 的 financeSourceSchemas）合在一起读，
 * 加上同步时补的单号（withNumber）；每项都可能没有。快照只存财务口径，多出来的项（按旧结构存的）读的时候忽略。
 */
const financeSourceDocument = z
  .object({ ...production.shape, ...stock.shape, ...arrival.shape, ...delivery.shape, number: z.string(), lines: z.array(sourceLine) })
  .partial();
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
 * 被它接手的上一条（fin_events.previous_event_id、previous_status）和同步时按单据内容算出的金额（document_cents）只存在列里。
 */
const eventSnapshot = z.strictObject({
  doc: financeSourceDocument.optional(),
  money: documentMoney.nullable().optional(),
  taxSource: z.array(taxSourceItem).optional(),
  theoretical: documentMoney.nullable().optional(),
  financialLines: z.array(financialLine).optional(),
  missing: z.array(z.enum(missingKinds)).optional(),
  warnings: z.array(z.string()).optional(),
  evidence: z.string().optional(),
});
export type EventSnapshot = z.output<typeof eventSnapshot>;
export type DocumentMoney = z.output<typeof documentMoney>;
/** 补财务资料时人填的一行：精确金额、含税口径、税率（event-handling.ts 收的，也是快照里 financialLines 的样子） */
export const evidenceLine = z.strictObject({
  exact: z.string().regex(/^\d{1,24}(\.\d{1,24})?$/),
  mode: z.enum(storedTaxModes),
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
 * 事件快照里单据明细和单号的取法（单号、往来单位在 SQL 里读 fin_events 的列，见 event-columns.ts）。
 * column 是快照所在的列或表达式（默认 snapshot）。
 */

/** 逐行展开单据明细（json_each，行在 value 里，行号在 key 里） */
export const snapshotLines = (column = 'snapshot') => `json_each(${column},'$.doc.lines')`;

/** 取单号：单据号，没有时退用对方单号，再没有用 fallback（fin_events.source_number 按它算，fallback 不进列）。 */
export function documentNumber(
  doc: { number?: string; reference?: string } | null | undefined,
  fallback: string | null = null,
): string | null {
  return doc?.number ?? doc?.reference ?? fallback;
}
