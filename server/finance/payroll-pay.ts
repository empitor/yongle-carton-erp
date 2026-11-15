/**
 * 工资发放：工资可以分几次发（比如月中先发生活费、月底补发）。每笔发放出一张其他支出的资金单并确认，
 * 记在这个月的“工资发放”执行记录里；撤销了的那笔不算，累计不能超过计提的实发合计。
 * FinancePayroll.paymentStatus、pay 查完权限调这里。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import { dateSchema } from '../../shared/core/index.js';
import { periodSchema } from '../../shared/finance/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { financeAudit, financeError } from './core.js';
import type { FinanceLedger } from './ledger.js';
import { FinanceSettlements } from './settlements.js';
import { periodJob, periodJobResult } from './jobs.js';
import { id, money, request, row } from './query.js';
import { endOfMonth } from './periods.js';
import { paymentDetails, payrollJob, readAccrual, readPayments } from './payroll-jobs.js';

export const payInput = request.extend({ period: periodSchema, date: dateSchema, accountId: id, amount: money.optional() });
type PayInput = z.output<typeof payInput>;
/** 发一次工资的结果：这个月的工资发放记录 */
export const paidOut = periodJobResult(paymentDetails);

/** 这个月已经发了的几笔（撤销了的不算）和合计 */
function payments(db: DatabaseSync, period: string) {
  const job = payrollJob(db, period, 'payroll_pay');
  const all = job ? readPayments(job).payments : [];
  const active = all.filter((p) => row(db, 'fin_cash_documents', p.cashId).status !== 'cancelled');
  return { job, active, paid: active.reduce((n, p) => n + p.amount, 0) };
}

/** 这个月工资发了多少、还剩多少、发了几笔 */
export function paymentStatus(db: DatabaseSync, period: string) {
  const run = payrollJob(db, period, 'payroll');
  const net = run ? readAccrual(run).net : 0;
  const { active, paid } = payments(db, period);
  return { period, net, paid, remaining: Math.max(0, net - paid), payments: active.length };
}

/** 发一笔工资：出一张其他支出的资金单（冲应付职工薪酬）并确认，返回资金单和它的凭证 */
function payOut(store: Store, user: Actor, v: PayInput, pay: { amount: number; wagesAccount: string }) {
  const cash = new FinanceSettlements(store);
  const draft = cash.writeCash(user, {
    requestId: v.requestId,
    kind: 'outlay',
    accountId: v.accountId,
    date: v.date,
    amount: pay.amount,
    method: '银行',
    description: '工资发放 ' + v.period,
    counterAccount: pay.wagesAccount,
    cashFlow: '支付给职工的现金',
  });
  cash.confirm(user, draft.id, {
    version: 1,
    requestId: 'payroll-cash:' + v.period + ':' + draft.id,
  });
  return { cashId: draft.id, voucher: Number(row(store.db, 'fin_cash_documents', draft.id).voucher_id) };
}

/** 发一次工资：计提要已记账，不超过还没发的，最后一笔不早于月末；记进（或接着记）这个月的工资发放记录 */
export function payPayroll(store: Store, ledger: FinanceLedger, user: Actor, v: PayInput): z.output<typeof paidOut> {
  const db = store.db;
  const run = payrollJob(db, v.period, 'payroll');
  if (!run?.voucher_id || ledger.get(user, run.voucher_id).header.status !== 'posted')
    financeError('请先确认并记账工资计提。');
  const payroll = readAccrual(run);
  const net = payroll.net;
  if (!net) financeError('没有应发放净额。');
  const { job: previous, active, paid } = payments(db, v.period);
  const remaining = net - paid;
  if (remaining <= 0) financeError('该期间工资已全部发放。', 409);
  const amount = v.amount ?? remaining;
  if (amount > remaining)
    financeError(
      '本次发放超过还没发的工资，还剩 ' +
        Math.trunc(remaining / 100) +
        '.' +
        String(remaining % 100).padStart(2, '0') +
        ' 元。',
    );
  // 月中先发一部分（生活费）可以在月内，但不能早于工资月份的 1 号；发完的那一笔不能早于月末。
  if (v.date < v.period + '-01') financeError('工资发放日期不能早于工资月份（' + v.period + '-01 起）。');
  if (amount === remaining && v.date < endOfMonth(v.period))
    financeError('发完本月工资的那一笔，发放日期不能早于月末。');
  const out = payOut(store, user, v, { amount, wagesAccount: payroll.wagesAccount });
  const details = paymentDetails.parse({
    payments: [...active, { cashId: out.cashId, amount }],
    paid: paid + amount,
    net,
  });
  if (previous) {
    db.prepare("UPDATE fin_period_jobs SET voucher_id=?,details=? WHERE period=? AND kind='payroll_pay'").run(
      out.voucher,
      JSON.stringify(details),
      v.period,
    );
    const after = { period: v.period, kind: 'payroll_pay', voucherId: out.voucher, details };
    financeAudit(store, user, { action: 'payment_add', entity: 'fin_period_jobs', id: null, before: previous, after });
    return after;
  }
  return periodJob(store, user, { period: v.period, kind: 'payroll_pay', voucher: out.voucher, schema: paymentDetails, details });
}
