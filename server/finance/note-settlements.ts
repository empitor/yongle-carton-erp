/**
 * 票据在往来上的结算：收票、开票、背书按哪个方向冲应收应付和预收预付（sides），这次冲哪几笔、记下冲了多少，
 * 这张票据现在冲在哪、冲了哪几笔（按凭证算），以及来源单据更正时把冲到那笔往来上的金额转回预收预付。
 * notes.ts 的票据服务用这些。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { many, rows } from '../core/index.js';
import { financeAudit, financeError } from './core.js';
import { lapsedStatuses, sourceIs } from './source-scan.js';
import { FinanceLedger } from './ledger.js';
import { entry, id, money, row } from './query.js';
import { allocationSum, voucherReversed } from './obligation-sql.js';
import { isReversed } from './reversal-pairs.js';

/**
 * 票据结算在往来上留下的核销记录。借用往来调整表 fin_bad_debts（坏账核销是 kind='writeoff'），
 * 记 kind='note'：哪笔往来、核销多少（退票时记负数）、挂哪张凭证。凭证都挂在票据上
 * （module_source='note'，module_id=票据编号），按凭证认是哪张票据的。
 * 往来余额、账龄、到期提醒、收付计划、核销建议都用 allocationSum，会一起算进去，和总账一致。
 */
export const noteSettlement = 'note';
/** 收票、开票、背书按往来方向记：冲应收或应付，冲不完的部分记预收或预付。 */
export const sides = {
  receivable: { party: '1122', advance: '2203', auxiliary: 'customer' },
  payable: { party: '2202', advance: '1123', auxiliary: 'supplier' },
} as const;
export type Side = keyof typeof sides;
export type Party = { kind: 'customer' | 'supplier'; id: string; name: string };
const entryColumns = rows.fin_entries.shape;
/** 票据凭证在往来、预收预付科目上按单位的净额（借减贷，红字反号） */
const positionRow = z.object({
  account_code: entryColumns.account_code,
  auxiliary_kind: entryColumns.auxiliary_kind,
  auxiliary_id: z.string(),
  auxiliary_name: entryColumns.auxiliary_name,
  net: z.number(),
});

/**
 * 这张票据在往来和预收预付上的净额（按凭证分录算，以前登记、只冲了应收应付的旧票据也对得上）：
 * party 是冲掉应收、应付的部分，advance 是记在预收、预付的部分。
 */
export function positions(db: DatabaseSync, noteId: number) {
  const nets = many(
    db,
    positionRow,
    `SELECT e.account_code,e.auxiliary_kind,e.auxiliary_id,max(e.auxiliary_name) AS auxiliary_name,
      sum((e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)) AS net
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id
      WHERE v.module_source='note' AND v.module_id=? AND v.status<>'void'
      AND e.account_code IN ('1122','2203','2202','1123') AND e.auxiliary_id IS NOT NULL
      GROUP BY e.account_code,e.auxiliary_kind,e.auxiliary_id`,
    noteId,
  );
  const result = new Map<string, { side: Side; party: Party; settled: number; advance: number }>();
  for (const r of nets) {
    const side: Side = r.auxiliary_kind === 'customer' ? 'receivable' : 'payable';
    const key = side + ':' + r.auxiliary_id;
    const item = result.get(key) ?? {
      side,
      party: {
        kind: sides[side].auxiliary,
        id: r.auxiliary_id,
        name: String(r.auxiliary_name),
      },
      settled: 0,
      advance: 0,
    };
    // 应收、预收在贷方是冲减；应付、预付在借方是冲减
    const value = side === 'receivable' ? -r.net : r.net;
    if (r.account_code === sides[side].advance) item.advance += value;
    else item.settled += value;
    result.set(key, item);
  }
  return [...result.values()];
}

/** 这张票据在某个单位的往来上各笔净核销了多少（退票时按这个冲回）。 */
export function settledLines(db: DatabaseSync, noteId: number, side: Side, partyId: string) {
  return many(
    db,
    z.object({ obligation_id: z.number(), amount: z.number() }),
    `SELECT b.obligation_id,sum(b.amount_cents) AS amount FROM fin_bad_debts b
      JOIN fin_vouchers v ON v.id=b.voucher_id JOIN fin_obligations o ON o.id=b.obligation_id
      WHERE b.kind=? AND v.module_source='note' AND v.module_id=? AND v.status<>'void' AND NOT ${voucherReversed('v')}
      AND o.kind=? AND o.party_id=? GROUP BY b.obligation_id HAVING sum(b.amount_cents)<>0 ORDER BY b.obligation_id`,
    noteSettlement,
    noteId,
    side,
    partyId,
  ).map((r) => ({ obligationId: r.obligation_id, amount: r.amount }));
}

/** 指定冲哪几笔往来、各冲多少 */
export const noteAllocations = z
  .array(z.strictObject({ obligationId: id, amount: money }))
  .max(100)
  .optional();
type Line = { obligationId: number; amount: number };
/** 还欠着的一笔往来，带余额和最早一期分期的到期日 */
const openRow = rows.fin_obligations.extend({ balance: z.number(), first_installment: z.string().nullable() });

/** 这个单位还没结清的往来，按到期先后排，和收付款的核销建议一个口径；给了 ids 只查这几笔。 */
function openItems(db: DatabaseSync, side: Side, partyId: string, date: string, ids?: number[]) {
  return many(
    db,
    openRow,
    `SELECT * FROM (SELECT o.*,o.amount_cents-${allocationSum('a.obligation_id=o.id')} AS balance,
    (SELECT min(i.due_date) FROM fin_installments i WHERE i.obligation_id=o.id) AS first_installment
    FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
    WHERE o.kind=? AND o.party_id=? AND o.date<=? AND o.amount_cents>0 AND o.tax_status<>'superseded'
    AND (o.voucher_id IS NULL OR v.status='posted')
    AND NOT ${isReversed('o')}
    AND NOT EXISTS(SELECT 1 FROM fin_events e
      WHERE e.id=o.event_id AND e.source_kind='delivery' AND ${sourceIs('e', 'reversed')})
    AND (? IS NULL OR o.id IN (SELECT value FROM json_each(?))))
    WHERE balance>0 ORDER BY coalesce(first_installment,due_date,date),date,id LIMIT 500`,
    side,
    partyId,
    date,
    lapsedStatuses(db),
    ids ? 1 : null,
    JSON.stringify(ids ?? []),
  );
}

/** 一次冲往来：哪一方、哪个单位、哪天、最多冲多少，指定了冲哪几笔的按指定的 */
type SettlementPlan = { side: Side; partyId: string; date: string; amount: number; explicit?: z.output<typeof noteAllocations> };

/** 这次冲哪几笔往来：指定了按指定的，没指定按到期先后冲，冲不完的留给预收、预付。 */
export function planSettlement(db: DatabaseSync, plan: SettlementPlan) {
  const { side, partyId, date, amount, explicit } = plan;
  // 指定了的按指定的那几笔查，不受“先取前 500 笔”的限制
  const open = openItems(db, side, partyId, date, explicit?.map((a) => a.obligationId));
  const lines: Line[] = [];
  if (explicit) {
    if (new Set(explicit.map((a) => a.obligationId)).size !== explicit.length) financeError('同一笔往来不能重复核销。');
    for (const a of explicit) {
      const item = open.find((o) => o.id === a.obligationId);
      if (!item) financeError('核销的往来不属于这个单位，或已经结清、尚未记账。');
      if (a.amount > item.balance) financeError('核销金额超过这笔往来的未结金额。');
      lines.push({ obligationId: a.obligationId, amount: a.amount });
    }
  } else {
    let left = amount;
    for (const o of open) {
      if (left <= 0) break;
      const value = Math.min(left, o.balance);
      lines.push({ obligationId: o.id, amount: value });
      left -= value;
    }
  }
  const total = lines.reduce((n, l) => n + l.amount, 0);
  if (total > amount) financeError('核销金额合计超过票据金额。');
  return { lines, total };
}

/** 往来上记下票据冲了多少（fin_bad_debts kind='note'，挂这次的凭证），往来加版本、记审计 */
export function recordSettlement(store: Store, user: Actor, settlement: { lines: readonly Line[]; date: string; voucher: number; reason: string }) {
  const db = store.db,
    { date, voucher, reason } = settlement;
  const insert = db.prepare(
    'INSERT INTO fin_bad_debts(obligation_id,kind,date,amount_cents,reason,voucher_id) VALUES(?,?,?,?,?,?)',
  );
  for (const l of settlement.lines) {
    if (!l.amount) continue;
    const before = row(db, 'fin_obligations', l.obligationId);
    const key = Number(insert.run(l.obligationId, noteSettlement, date, l.amount, reason, voucher).lastInsertRowid);
    db.prepare('UPDATE fin_obligations SET version=version+1 WHERE id=?').run(l.obligationId);
    financeAudit(store, user, { action: 'note_settle', entity: 'fin_bad_debts', id: key, before: null, after: row(db, 'fin_bad_debts', key) });
    financeAudit(store, user, {
      action: 'note_settle',
      entity: 'fin_obligations',
      id: l.obligationId,
      before,
      after: row(db, 'fin_obligations', l.obligationId),
    });
  }
}

/** 冲往来那一方的分录：冲掉的记应收（应付），剩下的记预收（预付）。 */
export function sideEntries(side: Side, party: Party, settled: number, advance: number, reverse = false) {
  const rule = sides[side];
  // 收票冲应收：贷应收、贷预收；开票、背书冲应付：借应付、借预付；退票方向相反
  const debitSide = (side === 'payable') !== reverse;
  const make = (code: string, n: number) =>
    n ? [debitSide ? entry(code, n, 0, party) : entry(code, 0, n, party)] : [];
  return [...make(rule.party, settled), ...make(rule.advance, advance)];
}

/**
 * 来源单据要更正时，这笔往来上的票据核销不能挡着：按票据逐张把冲到这笔往来上的金额转回预收（预付），
 * 往来上记负数核销，凭证挂回原票据。票据的钱还在，等更正后的新往来出来，在票据详情里“核销到欠款”。
 */
export function releaseNoteSettlements(
  store: Store,
  user: Actor,
  obligationId: number,
  date: string,
  reason: string,
) {
  const db = store.db;
  const obligation = row(db, 'fin_obligations', obligationId);
  const side: Side = obligation.kind === 'payable' ? 'payable' : 'receivable';
  const rule = sides[side];
  const party: Party = { kind: rule.auxiliary, id: obligation.party_id, name: obligation.party_name };
  const settled = many(
    db,
    z.object({ note_id: z.number(), last: z.string(), amount: z.number() }),
    `SELECT v.module_id AS note_id,max(b.date) AS last,sum(b.amount_cents) AS amount FROM fin_bad_debts b
      JOIN fin_vouchers v ON v.id=b.voucher_id
      WHERE b.kind=? AND b.obligation_id=? AND v.module_source='note' AND v.status<>'void' AND NOT ${voucherReversed('v')}
      GROUP BY v.module_id HAVING sum(b.amount_cents)>0 ORDER BY v.module_id`,
    noteSettlement,
    obligationId,
  );
  const ledger = new FinanceLedger(store);
  for (const { amount, note_id: noteId, last } of settled) {
    const when = date < last ? last : date;
    const entries =
      side === 'receivable'
        ? [entry(rule.party, amount, 0, party), entry(rule.advance, 0, amount, party)]
        : [entry(rule.advance, amount, 0, party), entry(rule.party, 0, amount, party)];
    const voucher = ledger.createLinked(user, 'note', noteId, {
      date: when,
      requestId: 'note-release:' + noteId + ':' + obligationId + ':' + amount,
      description: '来源更正，票据核销转回' + (side === 'receivable' ? '预收' : '预付') + '：' + reason,
      entries,
    });
    const key = Number(
      db
        .prepare(
          'INSERT INTO fin_bad_debts(obligation_id,kind,date,amount_cents,reason,voucher_id) VALUES(?,?,?,?,?,?)',
        )
        .run(obligationId, noteSettlement, when, -amount, reason, voucher.header.id).lastInsertRowid,
    );
    db.prepare('UPDATE fin_notes SET version=version+1 WHERE id=?').run(noteId);
    financeAudit(store, user, { action: 'note_release', entity: 'fin_bad_debts', id: key, before: null, after: row(db, 'fin_bad_debts', key) });
  }
  if (settled.length) {
    db.prepare('UPDATE fin_obligations SET version=version+1 WHERE id=?').run(obligationId);
    financeAudit(store, user, {
      action: 'note_release',
      entity: 'fin_obligations',
      id: obligationId,
      before: obligation,
      after: row(db, 'fin_obligations', obligationId),
    });
  }
  return settled.length;
}
