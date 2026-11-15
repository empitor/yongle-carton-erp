import { z } from 'zod';
import type { FinData } from './fin-api';

/*
 * 月度台账、概览明细的一行，和它的“明细”（detail）里页面要显示的几项。detail 按来源形状各不相同
 * （送货、到货是事件快照；收付款核销把快照放在 source 里；收付款、凭证分录、利息、保证金、接单是各自的几项），
 * 服务端按 JSON 原样给（server/finance/monthly-sql.ts）。这里只认要显示的几项，类型不对的当没有，不影响别的项。
 */

/** 月度台账、概览明细的一行（两个地址回的是同一种行） */
export type SourceRow = FinData<'GET /finance/monthly-ledger'>['rows'][number];

const text = z.string().optional().catch(undefined);
const id = z.number().optional().catch(undefined);
/** 来源单据的一行明细（送货、到货明细，照 server/finance/source-snapshot.ts 的 sourceLine），和补税率的一行（exact、rate、mode） */
const lineView = z.object({
  productName: text,
  name: text,
  unit: text,
  item: z.object({ name: text, unit: text }).optional().catch(undefined),
  quantity: text,
  stockedQuantity: text,
  unitPrice: text,
  unitPriceExact: text,
  taxRate: text,
  taxMode: text,
  exact: text,
  rate: text,
  mode: text,
});
const lines = z.array(lineView).optional().catch(undefined);
/** 事件快照里要显示的：来源单据的明细、提醒、补过的税率行 */
const snapshotView = z.object({
  doc: z.object({ lines }).optional().catch(undefined),
  warnings: z.array(z.string()).optional().catch(undefined),
  financialLines: lines,
});
const detailView = snapshotView.extend({
  /** 收付款核销那一行：来源单据的快照 */
  source: snapshotView.optional().catch(undefined),
  description: text,
  cashId: id,
  voucherId: id,
});
export type SourceLine = z.output<typeof lineView>;

/** 读一行的明细；明细不是对象时什么都没有 */
export function readSourceDetail(detail: unknown): z.output<typeof detailView> {
  const read = detailView.safeParse(detail);
  return read.success ? read.data : {};
}
