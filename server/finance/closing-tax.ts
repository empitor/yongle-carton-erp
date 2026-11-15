/** 月末税费计提怎么算：附加税按应交增值税、所得税按税前利润，只读不写（计提、结账检查看要不要重做都用它） */
import { z } from 'zod';
import type { Actor, Store } from '../core/index.js';
import { one } from '../core/index.js';
import { BASIS_POINTS } from '../../shared/finance/index.js';
import { financeError } from './core.js';
import { entry } from './query.js';
import { FinanceTax } from './vat.js';
import { proportion } from './amounts.js';
import { expectRow } from './finance-rows.js';

/** 税费计提（kind='tax'）执行记录的明细：增值税工作底稿各项（JSON 值，原样存），加税前利润和所得税 */
export const taxJobDetails = z.object({ pretax: z.number(), income: z.number() }).catchall(z.json());

/**
 * 按现在的账算某个月的税费计提。利润不算税费计提凭证自己（含重做时冲销的那张），
 * 否则记账后再算，附加税又从利润里扣一遍。
 */
export function taxPlan(store: Store, user: Actor, period: string) {
  const tax = new FinanceTax(store).worksheet(user, { period });
  const { profit } = expectRow(
    one(
      store.db,
      z.object({ profit: z.number() }),
      `SELECT coalesce(sum((credit-debit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)),0) AS profit
    FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id JOIN fin_accounts a ON a.code=e.account_code
    WHERE v.status='posted' AND v.period=? AND a.category='profit' AND e.account_code NOT LIKE '5801%'
    AND coalesce(v.module_source,'') NOT IN ('profit_close','annual_close','tax')`,
      period,
    ),
    '本月损益合计',
  );
  if (tax.payable == null && tax.taxpayer === 'small') financeError('请到财务设置填写小规模征收率。');
  const surcharges = [
    ['222102', tax.urban],
    ['222103', tax.education],
    ['222104', tax.localEducation],
  ] as const;
  if (Number(tax.payable) > 0 && surcharges.some(([, value]) => value == null))
    financeError('本月有应交增值税，请到财务设置填写附加税率，不用缴的填 0。');
  const pretax = Math.max(0, profit),
    rate = tax.rates.income;
  if (pretax && rate == null) financeError('本月有利润，请到财务设置填写所得税率，暂不计提的填 0。');
  const extra = surcharges.reduce((n, [, value]) => n + (value ?? 0), 0);
  const income = rate == null ? 0 : proportion(Math.max(0, pretax - extra), rate, BASIS_POINTS);
  const entries = extra
    ? [
        entry('5403', extra, 0),
        ...surcharges.flatMap(([code, amount]) => (amount ? [entry(code, 0, amount)] : [])),
      ]
    : [];
  if (income) entries.push(entry('5801', income, 0), entry('222105', 0, income));
  return { entries, details: { ...tax, pretax, income } };
}
