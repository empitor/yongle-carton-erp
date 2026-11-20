/** 收付款单：列表、详情、新增修改、确认（确认时可以直接核销）、撤销。核销和资金账户另见 allocations.ts、cash-accounts.ts。 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { MAX_PAGE_SIZE, dateSchema } from '../../shared/core/index.js';
import { accountCodeSchema, cashMethods, versionSchema } from '../../shared/finance/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { exists, many, one, rows } from '../core/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { partyName as businessPartyName } from './business-source.js';
import { FinanceCashAccounts } from './cash-accounts.js';
import {
  activeCashAccount,
  addAllocation,
  allocatedCents,
  allocationInput,
  cashDocument,
  cashDocumentView,
  cashEntries,
  cashVoucher,
} from './cash-posting.js';
import { FinanceLedger } from './ledger.js';
import { activeCashAllocation, allocationSum } from './obligation-sql.js';
import { edit, id, label, money, pageSql, request, row } from './query.js';
import { cashDocumentKinds } from './stored-values.js';

const methods = z.enum(cashMethods);
const cashKind = z.enum(cashDocumentKinds);
const cashSchema = request.extend({
  id: id.optional(),
  version: versionSchema.optional(),
  kind: cashKind,
  accountId: id,
  targetAccountId: id.optional(),
  partyId: id.optional(),
  date: dateSchema,
  amount: money,
  method: methods,
  description: label,
  counterAccount: accountCodeSchema.optional(),
  cashFlow: label.optional(),
});
/** 收付款单列表一行：资金单加已核销、未核销 */
const cashListRow = rows.fin_cash_documents.extend({ allocated: z.number(), unallocated: z.number() });
/** 确认收付款的结果：资金单详情，付出去的钱超过账户余额时带一句提醒 */
const confirmed = cashDocumentView.extend({ warning: z.string().nullable() });
/** 撤销收付款的结果：资金单详情，作废了哪几张凭证、红冲出了哪几张 */
const cancelled = cashDocumentView.extend({
  voidedVoucherIds: z.array(z.number()),
  reversalVoucherIds: z.array(z.number()),
});
/** 撤销收付款：撤销日期、原因、请求号 */
type Cancellation = { date: string; reason: string; requestId: string };

export class FinanceSettlements {
  private ledger: FinanceLedger;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
  }
  private get db() {
    return this.store.db;
  }

  cashList(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        kind: cashKind.optional(),
        accountId: id.optional(),
        partyId: z.string().optional(),
        from: dateSchema.optional(),
        to: dateSchema.optional(),
      })
      .parse(raw);
    const sql = `SELECT c.*, ${allocationSum('a.cash_id=c.id')} AS allocated,
      c.amount_cents-${allocationSum('a.cash_id=c.id')} AS unallocated FROM fin_cash_documents c
      WHERE (? IS NULL OR c.kind=?) AND (? IS NULL OR c.account_id=? OR c.target_account_id=?)
      AND (? IS NULL OR c.party_id=?) AND c.date BETWEEN ? AND ?`;
    const account = q.accountId ?? null;
    return pageSql(
      this.db,
      {
        schema: cashListRow,
        sql,
        values: [
          q.kind ?? null,
          q.kind ?? null,
          account,
          account,
          account,
          q.partyId ?? null,
          q.partyId ?? null,
          q.from ?? '0000-01-01',
          q.to ?? '9999-12-31',
        ],
        order: 'date',
      },
      raw,
    );
  }

  cash(actor: Actor | null, rawId: unknown) {
    financeActor(actor);
    return cashDocument(this.db, id.parse(rawId));
  }

  saveCash(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:cash'),
      v = cashSchema.parse(raw);
    return financeWrite(this.store, user, { action: 'cash.save', input: v, result: rows.fin_cash_documents }, () =>
      this.writeCash(user, v),
    );
  }

  /** 新建或修改一张待确认的资金单（工资发放、费用付款也走这里），要在调用方的事务里 */
  writeCash(user: Actor, v: z.output<typeof cashSchema>) {
    financeActor(user, 'finance:cash');
    if (!this.db.isTransaction) financeError('资金单须在同一事务生成。');
    this.ledger.openPeriod(user, v.date);
    const before = v.id ? row(this.db, 'fin_cash_documents', v.id) : null;
    if (before) {
      checkVersion(before, v.version ?? 0);
      if (before.status !== 'draft') financeError('已确认资金单不可修改。', 409);
    }
    activeCashAccount(this.db, v.accountId);
    let partyName: string | null = null;
    if (v.kind === 'receipt' || v.kind === 'payment') {
      if (!v.partyId) financeError('请填写往来单位。');
      partyName = businessPartyName(this.db, v.kind === 'receipt' ? 'customer' : 'supplier', v.partyId);
    } else if (v.kind === 'transfer') {
      if (!v.targetAccountId || v.targetAccountId === v.accountId)
        financeError('请填写不同的转入资金账户。');
      activeCashAccount(this.db, v.targetAccountId);
    } else if (!v.counterAccount || !v.cashFlow) financeError('请填写对方科目和现金流量项目。');
    const args = [
      v.kind,
      v.accountId,
      v.targetAccountId ?? null,
      v.partyId == null ? null : String(v.partyId),
      partyName,
      v.date,
      v.amount,
      v.method,
      v.description,
      v.counterAccount ?? null,
      v.cashFlow ?? null,
    ] as const;
    let key: number;
    if (before) {
      key = before.id;
      this.db
        .prepare(
          `UPDATE fin_cash_documents SET kind=?,account_id=?,target_account_id=?,party_id=?,party_name=?,
        date=?,amount_cents=?,method=?,description=?,counter_account=?,cash_flow=?,version=version+1 WHERE id=?`,
        )
        .run(...args, key);
    } else {
      key = Number(
        this.db
          .prepare(
            `INSERT INTO fin_cash_documents(kind,account_id,target_account_id,party_id,party_name,date,
        amount_cents,method,description,counter_account,cash_flow) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(...args).lastInsertRowid,
      );
    }
    const after = row(this.db, 'fin_cash_documents', key);
    financeAudit(this.store, user, { action: 'save', entity: 'fin_cash_documents', id: key, before, after });
    return after;
  }

  confirm(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:cash'),
      key = id.parse(rawId);
    const v = edit.extend({ allocations: z.array(allocationInput).max(100).default([]) }).parse(raw);
    const input = { ...v, key };
    return financeWrite(this.store, user, { action: 'cash.confirm', input, result: confirmed }, () => {
      const before = row(this.db, 'fin_cash_documents', key);
      checkVersion(before, v.version);
      if (before.status !== 'draft') financeError('只有待确认的收付款可以确认。', 409);
      const date = before.date;
      const vouchers = v.allocations.map((a) =>
        addAllocation(this.store, this.ledger, user, { c: before, v: a, date, requestId: v.requestId, initial: true }),
      );
      const left = before.amount_cents - allocatedCents(this.db, 'cash_id', key);
      if (left)
        vouchers.push(
          cashVoucher(this.ledger, user, {
            key,
            date,
            description: before.description,
            entries: cashEntries(this.db, before, left, false),
            requestId: v.requestId,
            cash: true,
          }),
        );
      this.db
        .prepare("UPDATE fin_cash_documents SET status='confirmed',voucher_id=?,version=version+1 WHERE id=?")
        .run(vouchers[0], key);
      const outgoing = ['payment', 'transfer', 'outlay'].includes(before.kind);
      const daily = outgoing ? new FinanceCashAccounts(this.store).daily(user, { date, pageSize: MAX_PAGE_SIZE }) : null;
      const balance = daily?.rows.find((r) => r.id === before.account_id)?.closing;
      const after = {
        ...cashDocument(this.db, key),
        warning: outgoing && balance != null && balance < before.amount_cents ? '资金余额不足，请核对。' : null,
      };
      financeAudit(this.store, user, { action: 'confirm', entity: 'fin_cash_documents', id: key, before, after });
      return after;
    });
  }

  cancel(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:cash'),
      key = id.parse(rawId);
    const v = edit.extend({ date: dateSchema, reason: label }).parse(raw);
    const input = { ...v, key };
    return financeWrite(this.store, user, { action: 'cash.cancel', input, result: cancelled }, () => {
      const before = row(this.db, 'fin_cash_documents', key);
      checkVersion(before, v.version);
      if (before.status !== 'confirmed') financeError('只有已确认资金单可以撤销。', 409);
      if (v.date < before.date) financeError('撤销日期不得早于资金单日期。');
      if (
        exists(
          this.db,
          `SELECT 1 FROM fin_allocations a JOIN fin_vouchers original ON original.id=a.voucher_id
        WHERE a.cash_id=? AND ${activeCashAllocation}`,
          key,
        )
      )
        financeError('请先撤销核销，已生成的核销红冲须先记账。', 409);
      this.ledger.openPeriod(user, v.date);
      const undone = this.undoVouchers(user, key, v);
      this.db.prepare("UPDATE fin_cash_documents SET status='cancelled',version=version+1 WHERE id=?").run(key);
      this.reopenExpense(user, key);
      const after = { ...cashDocument(this.db, key), status: 'cancelled', ...undone };
      financeAudit(this.store, user, {
        action: 'cancel',
        entity: 'fin_cash_documents',
        id: key,
        before,
        after: { ...after, date: v.date, reason: v.reason },
      });
      return after;
    });
  }

  /** 撤销收付款时它的凭证：已记账的红冲，没记账的作废；返回作废的、红冲出来的凭证编号 */
  private undoVouchers(user: Actor, key: number, v: Cancellation) {
    const vouchers = many(
      this.db,
      rows.fin_vouchers,
      `SELECT v.* FROM fin_vouchers v
      WHERE v.module_source='cash' AND v.module_id=? AND v.status<>'void'
      AND v.reversal_of IS NULL AND NOT EXISTS(
        SELECT 1 FROM fin_vouchers red WHERE red.reversal_of=v.id AND red.status='posted')
      ORDER BY v.id`,
      key,
    );
    const voidedVoucherIds: number[] = [],
      reversalVoucherIds: number[] = [];
    for (const voucher of vouchers) {
      if (v.date < voucher.date) financeError('撤销日期不得早于关联凭证日期。');
      const requestId =
        'cash-cancel:' + createHash('sha256').update(JSON.stringify([v.requestId, voucher.id])).digest('hex');
      const ref = { requestId, version: voucher.version };
      if (voucher.status === 'posted') {
        const red = this.ledger.reverse(user, voucher.id, { ...ref, date: v.date, description: v.reason }, { linked: true, cash: true });
        reversalVoucherIds.push(Number(red.header.id));
      } else {
        this.ledger.transition(user, voucher.id, 'void', ref, { linked: true, cash: true });
        voidedVoucherIds.push(voucher.id);
      }
    }
    return { voidedVoucherIds, reversalVoucherIds };
  }

  /** 这张资金单付的报销费用退回“已审批”，可以重新付款 */
  private reopenExpense(user: Actor, key: number) {
    const expense = one(this.db, rows.fin_expenses, "SELECT * FROM fin_expenses WHERE cash_id=? AND status='paid'", key);
    if (!expense) return;
    this.db.prepare("UPDATE fin_expenses SET status='approved',cash_id=NULL,version=version+1 WHERE id=?").run(expense.id);
    financeAudit(this.store, user, {
      action: 'payment_cancel',
      entity: 'fin_expenses',
      id: expense.id,
      before: expense,
      after: row(this.db, 'fin_expenses', expense.id),
    });
  }
}
