/**
 * 来源单据名下的往来（财务同步用）：送货、到货和它更正的原单算一组，名下有没有要人处理的往来，
 * 作废系统自己挂的暂估往来。events.ts 据此判断撤销、被替代的单据是直接记“已更正”还是标“有差异”。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { exists, many, rows } from '../core/index.js';
import { financeAudit } from './core.js';
import type { SourceRow } from './business-source.js';
import { row } from './query.js';
import { isReversed } from './reversal-pairs.js';
import { allocationSum, voucherStands } from './obligation-sql.js';
import type { FinanceSourceDocument } from './source-snapshot.js';

/** 送货、到货单据和它更正的原单的来源编号（这张在前）；别的来源返回 null。 */
export function relatedSources(source: SourceRow, doc: FinanceSourceDocument) {
  if (!['delivery', 'arrival'].includes(source.kind)) return null;
  const origin = doc.correctionOfReceiptId ?? doc.correctionOf;
  const id = origin == null ? null : String(origin).replace(/^flow-/, '');
  return id == null || id === source.id ? [source.id] : [source.id, id];
}

/**
 * 往来 o 上还挂着收付款核销（SQL 条件）：已记账的核销净额不为 0（撤销并记账了的正负抵掉），
 * 或者还有没记账的核销、撤销核销凭证（记账前不知道最后剩多少，按挂着算）。
 */
export const allocationsPending = (o: string) => `(${allocationSum(`a.obligation_id=${o}.id`, true)}<>0
  OR EXISTS(SELECT 1 FROM fin_allocations a JOIN fin_vouchers av ON av.id=a.voucher_id
    WHERE a.obligation_id=${o}.id AND av.status NOT IN ('posted','void')))`;

/** 往来 o 出过凭证（含到票暂估凭证，草稿也算，作废的不算）（SQL 条件） */
const hasVoucher = (o: string) =>
  `EXISTS(SELECT 1 FROM fin_vouchers v WHERE v.id IN (${o}.voucher_id,${o}.estimate_voucher_id) AND v.status<>'void')`;
/** 往来 o 有还算数的凭证（没作废、也没被红冲平）：能保留的就是它，毛利按入账算的也是它 */
const hasStandingVoucher = (o: string) =>
  `EXISTS(SELECT 1 FROM fin_vouchers v WHERE v.id IN (${o}.voucher_id,${o}.estimate_voucher_id) AND ${voucherStands('v')})`;

/** 这些单据名下还算数的往来 o（还没红冲、没被替代）满足 condition（SQL）：kind 是来源种类，ids 是来源编号的 JSON 数组 */
const sourceObligations = (kind: string, ids: string, condition: string) => `EXISTS(
  SELECT 1 FROM fin_obligations o JOIN fin_events oe ON oe.id=o.event_id
  WHERE oe.source_kind=${kind} AND oe.source_id IN (SELECT value FROM json_each(${ids}))
  AND o.reversal_of IS NULL AND o.tax_status<>'superseded' AND NOT ${isReversed('o')} AND (${condition}))`;

/** 事件 e 的来源单据名下有还算数的凭证的往来（SQL 条件）：单据删了以后能不能“核对无误，保留凭证” */
export const sourceBooked = (e: string) =>
  sourceObligations(`${e}.source_kind`, `json_array(${e}.source_id)`, hasStandingVoucher('o'));

/**
 * 这些单据名下有没有要人处理的往来：还没红冲、没被替代，并且出过凭证，
 * 或者被收付款核销、关联了发票、做过坏账或票据结算、押金抵扣、计了利息。只是系统自己挂着的暂估往来不算。
 */
export function hasPendingObligations(db: DatabaseSync, kind: string, ids: string[]) {
  const pending = `${hasVoucher('o')}
    OR ${allocationsPending('o')}
    OR EXISTS(SELECT 1 FROM fin_bad_debts b WHERE b.obligation_id=o.id)
    OR EXISTS(SELECT 1 FROM fin_deposit_actions d WHERE d.obligation_id=o.id)
    OR EXISTS(SELECT 1 FROM fin_interest i WHERE i.obligation_id=o.id)
    OR EXISTS(SELECT 1 FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id
      WHERE l.obligation_id=o.id AND i.status<>'void')`;
  return exists(db, 'SELECT 1 WHERE ' + sourceObligations('?', '?', pending), kind, JSON.stringify(ids));
}

/** 这些单据名下有还算数的凭证（没作废、没被红冲平）的往来 */
export function hasBookedObligations(db: DatabaseSync, kind: string, ids: string[]) {
  return exists(db, 'SELECT 1 WHERE ' + sourceObligations('?', '?', hasStandingVoucher('o')), kind, JSON.stringify(ids));
}

/** 作废这些单据名下系统自己挂的暂估往来（没凭证、没被动过；调用前已用 pending 确认）。 */
export function releaseProvisionalObligations(store: Store, user: Actor, kind: string, ids: string[]) {
  if (!ids.length) return;
  const provisional = many(
    store.db,
    rows.fin_obligations,
    `SELECT o.* FROM fin_obligations o JOIN fin_events e ON e.id=o.event_id
      WHERE e.source_kind=? AND e.source_id IN (SELECT value FROM json_each(?))
      AND o.voucher_id IS NULL AND o.reversal_of IS NULL AND o.tax_status<>'superseded'`,
    kind,
    JSON.stringify(ids),
  );
  supersedeObligations(store, user, provisional);
}

/** 把这些往来标成已替代，逐条写审计。 */
export function supersedeObligations(store: Store, user: Actor, obligations: z.output<typeof rows.fin_obligations>[]) {
  for (const before of obligations) {
    store.db
      .prepare("UPDATE fin_obligations SET tax_status='superseded',version=version+1 WHERE id=?")
      .run(before.id);
    financeAudit(store, user, {
      action: 'supersede',
      entity: 'fin_obligations',
      id: before.id,
      before,
      after: row(store.db, 'fin_obligations', before.id),
    });
  }
}
