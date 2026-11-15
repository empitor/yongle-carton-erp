/** 核销：给资金单推荐核销哪几笔往来、核销、撤销核销（转回预收预付）、多付转抵（credit-transfer.ts）。 */
import { z } from 'zod';
import { dateSchema } from '../../shared/core/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { exists, many, one, rows } from '../core/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import {
  addAllocation,
  allocatedCents,
  allocationInput,
  cashDocument,
  cashDocumentView,
  cashEntries,
  cashVoucher,
  revokedToAdvance,
  roleOf,
  type CashRow,
} from './cash-posting.js';
import { transferCredit, transferInput, transferred } from './credit-transfer.js';
import { refreshPendingDeliveryReversals } from './event-status.js';
import { FinanceLedger } from './ledger.js';
import { allocationSum, obligationBaseDate } from './obligation-sql.js';
import { edit, entry, id, label, row } from './query.js';
import { isReversed } from './reversal-pairs.js';
import { snapshotNumber } from './source-snapshot.js';
import { discount, snapshotOptions } from './terms.js';

/** 请求号最长 100 字；撤销用的子请求号超长时截前 60 字再接上编号和后缀 */
const REQUEST_ID_MAX = 100;
const REVOKE_PREFIX = 60;

type AllocationRow = z.output<typeof rows.fin_allocations>;
/** 推荐核销的一笔往来：往来加起算日、余额、最早一期分期的到期日、来源单据号 */
const suggestRow = rows.fin_obligations.extend({
  base_date: z.string(),
  balance: z.number(),
  first_installment: z.string().nullable(),
  source_number: z.string().nullable(),
});
/** 撤销核销的结果：多付转抵成对撤销时带上另一笔 */
const revoked = rows.fin_allocations.extend({ paired: rows.fin_allocations.optional() });

/** 撤销核销：撤哪几笔（多付转抵成对，第一笔是点撤销的那笔）、资金单、撤销日期、原因、请求号 */
type Revocation = {
  user: Actor;
  key: number;
  members: AllocationRow[];
  cash: CashRow;
  date: string;
  reason: string;
  requestId: string;
};

export class FinanceAllocations {
  private readonly ledger: FinanceLedger;
  constructor(private readonly store: Store) {
    this.ledger = new FinanceLedger(store);
  }
  private get db() {
    return this.store.db;
  }

  suggest(actor: Actor | null, rawId: unknown, raw: unknown) {
    financeActor(actor);
    const q = z.object({ date: dateSchema.optional() }).parse(raw),
      key = id.parse(rawId);
    const cash = row(this.db, 'fin_cash_documents', key);
    const rule = roleOf(cash.kind);
    if (!rule) return { allocations: [], available: 0 };
    const date = q.date ?? cash.date;
    let left = cash.amount_cents - allocatedCents(this.db, 'cash_id', key);
    const available = left;
    const balances = many(
      this.db,
      suggestRow,
      `SELECT * FROM (SELECT o.*,${obligationBaseDate('o')} AS base_date,
      o.amount_cents-${allocationSum('a.obligation_id=o.id')} AS balance,
      (SELECT min(i.due_date) FROM fin_installments i WHERE i.obligation_id=o.id) AS first_installment,
      (SELECT ${snapshotNumber('e.snapshot')} FROM fin_events e WHERE e.id=o.event_id) AS source_number
      FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id WHERE o.kind=? AND o.party_id=? AND o.date<=?
      AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status='posted') AND NOT ${isReversed('o')}
      ) WHERE balance>0 ORDER BY coalesce(first_installment,due_date,date),date,id LIMIT 100`,
      rule.obligation,
      cash.party_id,
      date,
    );
    const allocations = [];
    for (const o of balances) {
      if (left <= 0) break;
      const amount = Math.min(left, o.balance);
      const options = snapshotOptions(o.terms_snapshot, `fin_obligations.terms_snapshot（往来 ${o.id}）`);
      allocations.push({
        obligationId: o.id,
        version: o.version,
        amount,
        discount: 0,
        offer: discount(o.base_date, o.due_date, date, o.balance, options),
        dueDate: o.due_date,
        date: o.date,
        description: o.description,
        balance: o.balance,
        sourceNumber: o.source_number,
      });
      left -= amount;
    }
    return { allocations, available, unallocated: left };
  }

  allocate(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit
      .extend({ date: dateSchema, allocations: z.array(allocationInput).min(1).max(100) })
      .parse(raw);
    const input = { ...v, key };
    return financeWrite(this.store, user, { action: 'cash.allocate', input, result: cashDocumentView }, () => {
      const before = row(this.db, 'fin_cash_documents', key);
      checkVersion(before, v.version);
      if (
        before.status !== 'confirmed' ||
        exists(
          this.db,
          `SELECT 1 FROM fin_vouchers WHERE module_source='cash' AND module_id=? AND status NOT IN ('posted','void')`,
          key,
        )
      )
        financeError('请先完成资金凭证记账。');
      v.allocations.forEach((a) =>
        addAllocation(this.store, this.ledger, user, { c: before, v: a, date: v.date, requestId: v.requestId, initial: false }),
      );
      this.db.prepare('UPDATE fin_cash_documents SET version=version+1 WHERE id=?').run(key);
      const after = cashDocument(this.db, key);
      financeAudit(this.store, user, { action: 'allocate', entity: 'fin_cash_documents', id: key, before, after });
      return after;
    });
  }

  revoke(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit.extend({ date: dateSchema, reason: label }).parse(raw);
    const input = { ...v, key };
    return financeWrite(this.store, user, { action: 'cash.revoke', input, result: revoked }, () => {
      const before = row(this.db, 'fin_allocations', key),
        cash = row(this.db, 'fin_cash_documents', before.cash_id);
      checkVersion(before, v.version);
      // 多付转抵的转出、转入两笔共用一张对冲凭证（别的核销各有各的凭证），只能一起撤销：
      // 一张红冲凭证同时冲回两笔，否则剩下那笔再撤会撞上“已存在有效红冲凭证”，资金单也撤不掉。
      const partner = before.reversal_of
        ? undefined
        : one(
            this.db,
            rows.fin_allocations,
            'SELECT * FROM fin_allocations WHERE cash_id=? AND voucher_id=? AND id<>? AND reversal_of IS NULL',
            before.cash_id,
            before.voucher_id,
            key,
          );
      const members = partner ? [before, partner] : [before];
      this.checkRevocable(members, v.date);
      this.revokeMembers({ user, key, members, cash, date: v.date, reason: v.reason, requestId: v.requestId });
      for (const m of members) refreshPendingDeliveryReversals(this.store, user, m.obligation_id);
      const after = row(this.db, 'fin_allocations', key);
      return partner ? { ...after, paired: row(this.db, 'fin_allocations', partner.id) } : after;
    });
  }

  /** 要撤的几笔都还算数、没被撤过，撤销日期不早于核销日期 */
  private checkRevocable(members: readonly AllocationRow[], date: string) {
    for (const m of members)
      if (m.status !== 'active' || m.reversal_of || exists(this.db, 'SELECT 1 FROM fin_allocations WHERE reversal_of=?', m.id))
        financeError('核销已撤销或已生成反向核销。', 409);
    if (members.some((m) => date < m.date)) financeError('撤销日期不得早于核销日期。');
  }

  /**
   * 撤销核销：核销凭证已记账的红冲并记反向核销，没记账的作废；月份没结账的核销标成撤销中（已撤销）。
   * 确认收付款时就核销的，钱转回预收（预付）。最后给往来、资金单加版本并记审计。
   */
  private revokeMembers(r: Revocation) {
    const { user, key, members, cash } = r;
    const record = this.ledger.get(user, members[0].voucher_id).header;
    const closed = exists(this.db, "SELECT 1 FROM fin_periods WHERE period=? AND status='closed'", record.period);
    this.ledger.openPeriod(user, r.date);
    // 子事务使用派生请求号，外层重试整体回放。
    const derived = r.requestId + ':r';
    const ref = {
      version: Number(record.version),
      requestId: derived.length > REQUEST_ID_MAX ? derived.slice(0, REVOKE_PREFIX) + ':' + key + ':revoke' : derived,
    };
    if (record.status === 'posted') this.reverseMembers(r, record.id, ref);
    else this.ledger.transition(user, record.id, 'void', ref, { linked: true });
    if (!closed)
      for (const m of members)
        this.db
          .prepare('UPDATE fin_allocations SET status=?,version=version+1 WHERE id=?')
          .run(record.status === 'posted' ? 'reversing' : 'revoked', m.id);
    if (members[0].initial) this.returnToAdvance(r, record.status === 'posted');
    for (const m of members)
      this.db.prepare('UPDATE fin_obligations SET version=version+1 WHERE id=?').run(m.obligation_id);
    this.db.prepare('UPDATE fin_cash_documents SET version=version+1 WHERE id=?').run(cash.id);
    const partner = members.at(1);
    for (const m of members)
      financeAudit(this.store, user, {
        action: 'revoke',
        entity: 'fin_allocations',
        id: m.id,
        before: m,
        after: {
          ...row(this.db, 'fin_allocations', m.id),
          reason: r.reason,
          date: r.date,
          ...(partner ? { pairedWith: m.id === key ? partner.id : key } : {}),
        },
      });
  }

  /** 核销凭证已记账：红冲它，每笔记一条反向核销 */
  private reverseMembers(r: Revocation, voucherId: number, ref: { version: number; requestId: string }) {
    const reversal = this.ledger.reverse(r.user, voucherId, { ...ref, date: r.date, description: r.reason }, { linked: true });
    const insert = this.db.prepare(
      `INSERT INTO fin_allocations
      (cash_id,obligation_id,date,amount_cents,voucher_id,initial,reversal_of,discount_cents) VALUES(?,?,?,?,?,?,?,?)`,
    );
    for (const m of r.members) {
      const reverseId = Number(
        insert.run(m.cash_id, m.obligation_id, r.date, -m.amount_cents, reversal.header.id, m.initial, m.id, -m.discount_cents)
          .lastInsertRowid,
      );
      financeAudit(this.store, r.user, {
        action: 'reverse',
        entity: 'fin_allocations',
        id: reverseId,
        before: null,
        after: row(this.db, 'fin_allocations', reverseId),
      });
    }
  }

  /** 确认收付款时就核销的撤销以后，钱转回预收（预付）：核销凭证没记账的按收付款重记，记过账的另出一张转预收（预付） */
  private returnToAdvance(r: Revocation, posted: boolean) {
    const { cash } = r,
      first = r.members[0];
    const rule = roleOf(cash.kind) ?? financeError('资金单方向不匹配。');
    const auxiliary = { kind: rule.auxiliary, id: String(cash.party_id), name: String(cash.party_name) };
    const amount = first.amount_cents - first.discount_cents;
    let entries;
    if (!posted) entries = cashEntries(this.db, cash, amount, false);
    else {
      const bank = row(this.db, 'fin_cash_accounts', cash.account_id).account_code;
      const flow = cash.kind === 'receipt' ? '销售商品收到的现金' : '购买商品支付的现金';
      entries =
        cash.kind === 'receipt'
          ? [entry(bank, amount, 0, null, flow), entry(rule.advance, 0, amount, auxiliary)]
          : [entry(rule.advance, amount, 0, auxiliary), entry(bank, 0, amount, null, flow)];
    }
    cashVoucher(this.ledger, r.user, {
      key: cash.id,
      date: r.date,
      description: revokedToAdvance,
      entries,
      requestId: r.requestId,
      cash: false,
    });
  }

  /** 多付转抵（见 credit-transfer.ts） */
  transferCredit(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const v = transferInput.parse(raw);
    return financeWrite(this.store, user, { action: 'cash.transferCredit', input: v, result: transferred }, () =>
      transferCredit(this.store, this.ledger, user, v),
    );
  }
}
