import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { many, rows } from '../core/index.js';
import { proportion } from './amounts.js';

const invoice = rows.fin_invoices.shape;
/** 蓝票关联的一笔往来和关联金额，按往来编号排（分摊的先后） */
const blueLink = rows.fin_invoice_links.pick({ obligation_id: true, amount_cents: true });
const blueLinks = (db: DatabaseSync, invoiceId: number) =>
  many(
    db,
    blueLink,
    'SELECT obligation_id,amount_cents FROM fin_invoice_links WHERE invoice_id=? ORDER BY obligation_id',
    invoiceId,
  );

/** 关联到这些往来的蓝票，带上它被红冲的累计（正数） */
const redOfBlue = z.object({ id: invoice.id, gross: invoice.gross, red: z.number() });

/**
 * 红票冲掉的开票额度落到原蓝票关联的哪些往来上。按关联累计分摊，
 * 每笔都是整数分，合计正好等于红票额，不会逐笔截断丢掉尾差。
 * onlyNormal 只看状态为已确认的蓝票；否则排除待确认和作废。
 */
export function redReleasedByObligation(
  db: DatabaseSync,
  obligationIds: number[],
  onlyNormal = false,
) {
  const out = new Map<number, number>();
  if (!obligationIds.length) return out;
  const blues = many(
    db,
    redOfBlue,
    `SELECT DISTINCT i.id,i.gross,coalesce((SELECT sum(-r.gross) FROM fin_invoices r
          WHERE r.original_id=i.id AND r.status NOT IN ('draft','void')),0) AS red
        FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id
        WHERE l.obligation_id IN (SELECT value FROM json_each(?)) AND i.gross>0 AND ` +
      (onlyNormal ? "i.status='normal'" : "i.status NOT IN ('draft','void')"),
    JSON.stringify(obligationIds),
  );
  for (const blue of blues) {
    const red = Math.min(blue.red, blue.gross);
    if (red <= 0) continue;
    let cumulative = 0,
      used = 0;
    for (const l of blueLinks(db, blue.id)) {
      cumulative += l.amount_cents;
      const upto = proportion(red, cumulative, blue.gross);
      out.set(l.obligation_id, (out.get(l.obligation_id) || 0) + upto - used);
      used = upto;
    }
  }
  return out;
}

/**
 * 开错重开释放的额度：只有原蓝票被红冲完（累计红冲等于原票）才算，额度是最后补齐的那部分，
 * 也就是原票减去之前的折让红票。只冲了一部分的折让红票不释放额度，免得再开一张蓝票把折让抵消掉。
 * 原蓝票须有凭证（采购发票都有；销售发票只有开票确认收入时才有），否则红冲不动往来，也谈不上重开恢复。
 * 分摊口径和 redReleasedByObligation 一致：按原蓝票关联累计分摊，整数分、合计不丢尾差。
 */
export function reissueReleasedByObligation(db: DatabaseSync, obligationIds: number[]) {
  const out = new Map<number, number>();
  if (!obligationIds.length) return out;
  const blues = many(
    db,
    rows.fin_invoices.pick({ id: true, gross: true }),
    `SELECT DISTINCT i.id,i.gross FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id
        WHERE l.obligation_id IN (SELECT value FROM json_each(?)) AND i.gross>0
        AND i.voucher_id IS NOT NULL AND i.status NOT IN ('draft','void')`,
    JSON.stringify(obligationIds),
  );
  for (const blue of blues) {
    const gross = blue.gross;
    const amounts = many(
      db,
      z.object({ amount: z.number() }),
      "SELECT -gross AS amount FROM fin_invoices WHERE original_id=? AND status NOT IN ('draft','void') ORDER BY id",
      blue.id,
    ).map((r) => r.amount);
    const total = amounts.reduce((n, v) => n + v, 0);
    const last = amounts.at(-1);
    if (last === undefined || total < gross) continue;
    const earlier = Math.min(gross, total - last);
    let cumulative = 0,
      used = 0;
    for (const l of blueLinks(db, blue.id)) {
      cumulative += l.amount_cents;
      // 分到这笔的“整票”份额减去“之前折让”份额
      const upto = cumulative - proportion(earlier, cumulative, gross);
      out.set(l.obligation_id, (out.get(l.obligation_id) || 0) + upto - used);
      used = upto;
    }
  }
  return out;
}
