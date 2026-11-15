import { call } from '../../ui/index';
import { finRead, finWritten, requestId, type FinanceWrites, type FinQuery, type FinRequest } from '../fin-api';
import { accruePayroll, depreciate, type PeriodJobExtra } from '../costs/costs-api';
import type { SubmitValues } from '../form-values';

/*
 * 报表结账的请求：月末几步（折旧、工资和费用资产页同一个提交）、结账、反结账、预算，
 * 预算列表一页一页的读法（给 FinList）。只读一次、跟着月份变的（待补单据、报表、结账检查）页面用 useFinRead 直接读。
 */

/** 报表结账页的写入（一个写地址只由这个文件发） */
const send = call<FinanceWrites>();
/** FinList 往查询参数里补的翻页 */
type PageQuery = { page: number; pageSize: number };

/** 结账页上直接办的月末一步（成本到成本页的窗口里算） */
export type ClosingJob = 'depreciation' | 'payroll' | 'tax' | 'profit';

/** 这个月出正式报表、结账前还有哪些单据没补完，给 useFinRead */
export const readinessOf = (period: string): FinRequest<'GET /finance/reports/readiness'> => [
  'GET /finance/reports/readiness',
  { query: { period } },
];
/** 一张报表（试算平衡、资产负债、利润、现金流量），给 useFinRead */
export const reportOf = (
  kind: 'trial' | 'balance' | 'profit' | 'cashflow',
  period: string,
): FinRequest<'GET /finance/reports/:kind'> => ['GET /finance/reports/:kind', { params: { kind }, query: { period } }];

/** 结账页上的月末一步；extra 里放 annual（年度利润）、redo 和原凭证号 */
export function runPeriodJob(job: ClosingJob, period: string, extra: PeriodJobExtra = {}) {
  switch (job) {
    case 'depreciation':
      return depreciate(period, extra);
    case 'payroll':
      return accruePayroll(period, extra);
    case 'tax':
      return finWritten(send('POST /finance/closing/tax', { body: { requestId: requestId(), period, ...extra } }));
    case 'profit':
      return finWritten(send('POST /finance/closing/profit', { body: { requestId: requestId(), period, ...extra } }));
  }
}
export const closePeriod = (period: string, version: number) =>
  finWritten(send('POST /finance/closing/close', { body: { requestId: requestId(), period, version } }));
export const reopenPeriod = (period: string, reason: string, version: number) =>
  finWritten(send('POST /finance/closing/reopen', { body: { requestId: requestId(), period, reason, version } }));

export const listBudgets = (query: FinQuery<'GET /finance/budgets'> & PageQuery) =>
  finRead('GET /finance/budgets', { query });
/** 保存一个科目这个月的预算；改已有的带上版本 */
export const saveBudget = (values: SubmitValues & { period: string; version?: number }) =>
  finWritten(send('PUT /finance/budgets', { body: { requestId: requestId(), ...values } }));
