/** 发票关联往来的读和判定：发票详情（含关联的往来）、往来还能不能挂发票、整张红冲后还能重开多少。 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { quantityString } from '../../shared/core/index.js';
import { many, one, rows } from '../core/index.js';
import { financeError } from './core.js';
import { sourceDocumentNumber, sourceReversed } from './business-source.js';
import { sumOf } from './finance-rows.js';
import { row } from './query.js';
import { reissueReleasedByObligation } from './red-invoices.js';
import { isReversed } from './reversal-pairs.js';

const obligation = rows.fin_obligations.shape;
/** 发票关联的一笔往来：关联一行，加上往来日期和金额、来源事件、来源单号和来源明细（JSON 文字） */
const linkedObligation = rows.fin_invoice_links.extend({
  date: obligation.date,
  obligation_amount: obligation.amount_cents,
  event_id: obligation.event_id,
  source_number: z.string().nullable(),
  source_lines: z.string().nullable(),
});
/** 发票详情：发票一行和它关联的往来（数量另给文字，页面回传关联时用） */
export const invoiceDetailSchema = z.object({
  invoice: rows.fin_invoices,
  links: z.array(linkedObligation.extend({ quantity: z.string().nullable() })),
});
export type InvoiceDetail = z.output<typeof invoiceDetailSchema>;
/** 发票和它关联的往来（带来源单号、来源明细） */
export function invoiceDetail(db: DatabaseSync, key: number): InvoiceDetail {
  const links = many(
    db,
    linkedObligation,
    `SELECT l.*,o.date,o.amount_cents AS obligation_amount,o.event_id,e.source_number,
      json_extract(e.snapshot,'$.doc.lines') AS source_lines
      FROM fin_invoice_links l JOIN fin_obligations o ON o.id=l.obligation_id LEFT JOIN fin_events e ON e.id=o.event_id
      WHERE invoice_id=? ORDER BY obligation_id`,
    key,
  )
    // 库里存千分位整数 quantity_units；页面回传关联时用的是 quantity 文字，两边要对得上。
    .map((l) => ({ ...l, quantity: l.quantity_units == null ? null : quantityString(l.quantity_units) }));
  return { invoice: row(db, 'fin_invoices', key), links };
}

/**
 * 被替代（superseded）的往来、冲销行本身、已被更正冲销的旧往来、凭证已作废的往来，已撤销或被更正替代的到货名下的往来都不能再挂发票，
 * 关联和确认时都要查。冲销按红字凭证没作废算（reversal-pairs.ts 的 isReversed），和来源更正认原往来的口径一致。
 */
export function assertInvoiceableObligation(db: DatabaseSync, obligationId: number, voided: (arrival: string) => string) {
  // SQL 的真假是 1/0；凭证编号有值却联不到凭证时 v.status 是 NULL，整个条件可能是 NULL（按不算处理）
  const stale = one(
    db,
    z.object({ n: z.number().nullable(), voided: z.string().nullable() }),
    `SELECT o.tax_status='superseded' OR (o.voucher_id IS NOT NULL AND v.status='void') OR o.reversal_of IS NOT NULL
          OR ${isReversed('o')} AS n,
        CASE WHEN e.source_kind='arrival' AND ${sourceReversed('e', 'arrival')} THEN ${sourceDocumentNumber('e')} END AS voided
        FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id LEFT JOIN fin_events e ON e.id=o.event_id
        WHERE o.id=?`,
    obligationId,
  );
  if (!stale) financeError('往来单不存在。', 404);
  // 撤销以后到票已转走的暂估就定了（撤销那个月的成本按它冲回库存），再关联发票那个月就对不上；
  // 关联时和确认待确认发票时各自说怎么办（voided 收到货单号）
  if (stale.voided !== null) financeError(voided(stale.voided));
  if (stale.n) financeError('该往来单已被更正或冲销，请关联更正后的往来单。');
}

/**
 * 发票开错重开：原发票整张红冲释放出来的额度可以由新蓝票重开，减去已经重开过的。
 * 折让、退货这类只冲一部分的红票不释放额度，否则再开一张蓝票就把折让抵消了。
 * 重开的发票不再冲暂估（暂估在第一次到票时已经转回），关联记录的对应暂估记为 0 以示区分；
 * 销售重开（开票确认收入）也用同一个标记，表示这笔关联整笔是重开、往来已经加回。
 */
export function reissueCapacity(db: DatabaseSync, obligationId: number, exceptInvoice: number) {
  const released = reissueReleasedByObligation(db, [obligationId]).get(obligationId) || 0;
  const reissued = sumOf(
    db,
    `SELECT coalesce(sum(l.amount_cents),0) AS n FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id
        WHERE l.obligation_id=? AND i.id<>? AND i.gross>0
        AND i.status NOT IN ('draft','void') AND l.estimate_cents=0`,
    obligationId,
    exceptInvoice,
  );
  return released - reissued;
}
