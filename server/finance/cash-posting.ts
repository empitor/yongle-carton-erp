/**
 * 收付款和核销记账的共用步骤：资金单方向对应的科目、收付款分录、生成凭证、已核销合计、记一笔核销、读资金单详情。
 * 收付款单（settlements.ts）和核销（allocations.ts）都用。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { versionSchema } from '../../shared/finance/index.js';
import type { FinanceEntry } from '../../shared/finance/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { exists, many, one, rows } from '../core/index.js';
import { checkVersion, financeAudit, financeError } from './core.js';
import { sourceObserved } from './catch-up.js';
import type { FinanceLedger } from './ledger.js';
import { allocationReversalMessage, allocationSum, obligationBaseDate } from './obligation-sql.js';
import { entry, id, label, money, row } from './query.js';
import { isReversed } from './reversal-pairs.js';
import { financeTemplate } from './template.js';
import { discount, snapshotOptions } from './terms.js';
import { expectRow, sumOf } from './finance-rows.js';

/** 一笔核销的输入 */
export const allocationInput = z.strictObject({
  obligationId: id,
  version: versionSchema,
  amount: money,
  discount: z.number().int().nonnegative().default(0),
  reason: label.optional(),
});
type AllocationInput = z.output<typeof allocationInput>;
/** 资金单一行（fin_cash_documents） */
export type CashRow = z.output<typeof rows.fin_cash_documents>;
type ObligationRow = z.output<typeof rows.fin_obligations>;
/** 收客户款、付供应商款对应的往来方向和科目 */
export const roles = {
  receipt: { obligation: 'receivable', auxiliary: 'customer', party: '1122', advance: '2203' },
  payment: { obligation: 'payable', auxiliary: 'supplier', party: '2202', advance: '1123' },
} as const;
type Role = (typeof roles)[keyof typeof roles];
/** 资金单方向对应的往来规则：只有收客户款、付供应商款有，别的（转账、其他收支）是 undefined */
export function roleOf(kind: string): Role | undefined {
  return kind === 'receipt' || kind === 'payment' ? roles[kind] : undefined;
}
/** 撤销“确认时就核销”的核销以后，钱转回预收（预付）的那张凭证的摘要；对账单上写成“转为预收款” */
export const revokedToAdvance = '撤销核销转预收预付';

/** 资金单详情：资金单加它的核销和凭证（编号、凭证号、期间、状态） */
export const cashDocumentView = rows.fin_cash_documents.extend({
  allocations: z.array(rows.fin_allocations),
  vouchers: z.array(rows.fin_vouchers.pick({ id: true, number: true, period: true, status: true })),
});

/** 资金账户对应的科目；停用了报错。 */
export function activeCashAccount(db: DatabaseSync, key: number) {
  const account = row(db, 'fin_cash_accounts', key);
  if (!account.enabled) financeError('资金账户已停用。');
  return account.account_code;
}

/** 收付款的分录：转账、其他收支按对方科目；收客户款、付供应商款记到应收应付（toParty）或预收预付。 */
export function cashEntries(db: DatabaseSync, c: CashRow, amount: number, toParty: boolean) {
  const bank = activeCashAccount(db, c.account_id);
  if (c.kind === 'transfer')
    return [
      entry(activeCashAccount(db, Number(c.target_account_id)), amount, 0, null, '内部转账'),
      entry(bank, 0, amount, null, '内部转账'),
    ];
  if (c.kind === 'income' || c.kind === 'outlay') {
    const counter = String(c.counter_account),
      flow = String(c.cash_flow);
    if (counter === bank) financeError('收支对方科目须不同。');
    return c.kind === 'income'
      ? [entry(bank, amount, 0, null, flow), entry(counter, 0, amount)]
      : [entry(counter, amount, 0), entry(bank, 0, amount, null, flow)];
  }
  const rule = roleOf(c.kind) ?? financeError('资金单方向不匹配。'),
    auxiliary = { kind: rule.auxiliary, id: String(c.party_id), name: String(c.party_name) };
  const counter = toParty ? rule.party : rule.advance;
  return c.kind === 'receipt'
    ? [entry(bank, amount, 0, null, '销售商品收到的现金'), entry(counter, 0, amount, auxiliary)]
    : [entry(counter, amount, 0, auxiliary), entry(bank, 0, amount, null, '购买商品支付的现金')];
}

/** 收付款、核销生成的一张凭证：挂在哪张资金单（key）上、日期、摘要、分录、请求号；cash 为真时用出纳权限 */
type CashVoucher = {
  key: number;
  date: string;
  description: string;
  entries: FinanceEntry[];
  requestId: string;
  cash: boolean;
};
/** 收付款、核销生成的凭证（来源记成这张资金单），返回凭证编号 */
export function cashVoucher(ledger: FinanceLedger, user: Actor, voucher: CashVoucher) {
  const { key, date, description, entries, requestId, cash } = voucher;
  return Number(
    ledger.createLinked(
      user,
      'cash',
      key,
      { date, description, entries, requestId },
      cash ? 'finance:cash' : 'finance:edit',
    ).header.id,
  );
}

/** 资金单或往来上已核销的合计（分）。 */
export function allocatedCents(db: DatabaseSync, where: 'cash_id' | 'obligation_id', key: number) {
  return sumOf(db, 'SELECT ' + allocationSum('a.' + where + '=?') + ' AS n', key);
}

/** 一笔核销：哪张资金单（c）、核销哪笔往来多少（v）、核销日期、请求号；initial 是确认收付款时就核销的 */
type Allocation = { c: CashRow; v: AllocationInput; date: string; requestId: string; initial: boolean };

/** 资金单和往来对得上：收付方向、往来单位一致，往来是正数，核销日期不早于两边的日期；返回方向规则 */
function allocationRule({ c, date }: Allocation, before: ObligationRow) {
  const rule = roleOf(c.kind);
  if (
    !rule ||
    before.kind !== rule.obligation ||
    before.party_id !== c.party_id ||
    before.amount_cents <= 0 ||
    date < c.date ||
    date < before.date
  )
    financeError('核销的日期、方向或往来单位不匹配。');
  return rule;
}

/** 往来还能核销：来源送货单没冲销（按补扫看到的状态，财务请求前已补扫过）、往来凭证已记账、往来没被红冲 */
function checkObligationOpen(store: Store, ledger: FinanceLedger, user: Actor, before: ObligationRow) {
  const db = store.db;
  if (
    before.event_id &&
    exists(db, `SELECT 1 FROM fin_events e WHERE e.id=? AND e.source_kind='delivery' AND ${sourceObserved('e', 'reversed')}`, before.event_id)
  )
    financeError(allocationReversalMessage, 409);
  if (before.tax_status === 'superseded' || (before.voucher_id && ledger.get(user, before.voucher_id).header.status !== 'posted'))
    financeError('往来凭证须先记账。');
  if (exists(db, `SELECT 1 FROM fin_obligations o WHERE o.id=? AND ${isReversed('o')}`, before.id))
    financeError('已红冲往来单不能核销。');
}

/** 核销金额不超过往来余额、资金单还没核销的部分；手工改了现结优惠要写原因 */
function checkAmounts(db: DatabaseSync, { c, v, date }: Allocation, before: ObligationRow) {
  const balance = before.amount_cents - allocatedCents(db, 'obligation_id', v.obligationId);
  if (v.discount >= v.amount || v.amount > balance || v.amount - v.discount > c.amount_cents - allocatedCents(db, 'cash_id', c.id))
    financeError('核销金额超过可用余额。');
  const base = expectRow(
    one(db, z.object({ d: z.string() }), `SELECT ${obligationBaseDate('o')} AS d FROM fin_obligations o WHERE o.id=?`, v.obligationId),
    '往来 ' + v.obligationId,
  ).d;
  const options = snapshotOptions(before.terms_snapshot, `fin_obligations.terms_snapshot（往来 ${before.id}）`);
  const offer = discount(base, before.due_date, date, v.amount, options);
  if (v.discount && v.discount !== offer?.amount && !v.reason) financeError('手工覆盖优惠时必须填写原因。');
}

/** 核销的分录：收付款确认时就核销的直接记收付款，之后核销的从预收（预付）转到应收（应付）；现结优惠记费用 */
function allocationEntries(store: Store, { c, v, initial }: Allocation, rule: Role) {
  const cashAmount = v.amount - v.discount,
    receipt = c.kind === 'receipt';
  const auxiliary = { kind: rule.auxiliary, id: String(c.party_id), name: String(c.party_name) };
  const entries = initial
    ? cashEntries(store.db, c, cashAmount, true)
    : receipt
      ? [entry(rule.advance, cashAmount, 0, auxiliary), entry(rule.party, 0, cashAmount, auxiliary)]
      : [entry(rule.party, cashAmount, 0, auxiliary), entry(rule.advance, 0, cashAmount, auxiliary)];
  if (!v.discount) return entries;
  // 现结优惠：往来那一行多冲优惠的部分，差额记费用
  const fee = financeTemplate(store, 'settlement.discount')('fee');
  const withDiscount = entries.map((e) =>
    e.accountCode !== rule.party ? e : receipt ? { ...e, credit: e.credit + v.discount } : { ...e, debit: e.debit + v.discount },
  );
  return [...withDiscount, receipt ? entry(fee, v.discount, 0) : entry(fee, 0, v.discount)];
}

/**
 * 一笔核销：资金单的钱抵一笔往来。校验方向、日期、余额、现结优惠，生成凭证（确认时核销的 initial 直接记收付款），
 * 写核销记录和审计，返回凭证编号。
 */
export function addAllocation(store: Store, ledger: FinanceLedger, user: Actor, allocation: Allocation) {
  const db = store.db;
  const { c, v, date, requestId, initial } = allocation;
  const before = row(db, 'fin_obligations', v.obligationId);
  const rule = allocationRule(allocation, before);
  checkVersion(before, v.version);
  checkObligationOpen(store, ledger, user, before);
  checkAmounts(db, allocation, before);
  const voucher = cashVoucher(ledger, user, {
    key: c.id,
    date,
    description: initial ? c.description : '往来核销',
    entries: allocationEntries(store, allocation, rule),
    requestId,
    cash: initial,
  });
  const key = Number(
    db
      .prepare(
        `INSERT INTO fin_allocations(cash_id,obligation_id,date,amount_cents,voucher_id,initial,discount_cents,discount_reason)
    VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(c.id, v.obligationId, date, v.amount, voucher, Number(initial), v.discount, v.reason ?? null).lastInsertRowid,
  );
  db.prepare('UPDATE fin_obligations SET version=version+1 WHERE id=?').run(v.obligationId);
  financeAudit(store, user, { action: 'allocate', entity: 'fin_allocations', id: key, before: null, after: row(db, 'fin_allocations', key) });
  financeAudit(store, user, {
    action: 'allocate',
    entity: 'fin_obligations',
    id: v.obligationId,
    before,
    after: row(db, 'fin_obligations', v.obligationId),
  });
  return voucher;
}

/** 资金单详情：资金单、它的核销和凭证。 */
export function cashDocument(db: DatabaseSync, key: number): z.output<typeof cashDocumentView> {
  return {
    ...row(db, 'fin_cash_documents', key),
    allocations: many(db, rows.fin_allocations, 'SELECT * FROM fin_allocations WHERE cash_id=? ORDER BY id', key),
    vouchers: many(
      db,
      cashDocumentView.shape.vouchers.element,
      "SELECT id,number,period,status FROM fin_vouchers WHERE module_source='cash' AND module_id=? ORDER BY id",
      key,
    ),
  };
}
