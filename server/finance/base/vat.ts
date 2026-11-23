import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { BASIS_POINTS, periodSchema } from '../../../shared/finance/index.js';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { many } from '../../core/index.js';
import { financeActor } from './core.js';
import { sumOf } from './finance-rows.js';
import { percentCents, proportion } from './amounts.js';
import { adjacentPeriod, endOfMonth } from './periods.js';
import { readFinanceSettings } from './settings.js';

/** 附加税、征收率按万分之几（BASIS_POINTS）存；换成百分之几给 percentCents（它收的是百分比） */
const BASIS_POINTS_PER_PERCENT = 100;

/** 一个月增值税三个科目的发生额：销项、进项、进项转出 */
type VatFlows = { output: number; input: number; transfer: number };
const noFlows = (): VatFlows => ({ output: 0, input: 0, transfer: 0 });

/** 到 period 为止，增值税三个科目逐月的发生额（已记账凭证，红字凭证按负数算） */
function vatMonths(db: DatabaseSync, period: string) {
  const flows = many(
    db,
    z.object({ period: z.string(), account_code: z.string(), n: z.number() }),
    `SELECT v.period,e.account_code,sum(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END*(credit-debit)) AS n
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.status='posted' AND v.period<=?
      AND e.account_code LIKE '222101%' GROUP BY v.period,e.account_code`,
    period,
  );
  const months = new Map<string, VatFlows>();
  for (const r of flows) {
    const m = months.get(r.period) ?? noFlows();
    if (r.account_code.startsWith('22210102')) m.output += r.n;
    else if (r.account_code.startsWith('22210101')) m.input -= r.n;
    else if (r.account_code.startsWith('22210103')) m.transfer += r.n;
    months.set(r.period, m);
  }
  return months;
}

/** 期初进项留抵：进项借方余额减去销项、进项转出的贷方余额，净额在借方的部分。 */
function openingCarry(db: DatabaseSync) {
  const net = sumOf(
    db,
    `SELECT coalesce(sum(debit-credit),0) AS n FROM fin_opening
          WHERE account_code LIKE '22210101%' OR account_code LIKE '22210102%' OR account_code LIKE '22210103%'`,
  );
  return Math.max(0, net);
}

/**
 * 留抵按月滚动：上期留抵 = 上月期末留抵，不能拿以前所有月份的累计净额来算，
 * 否则前面交过税的月份会把后面的留抵吃掉。从财务启用期间开始逐月推，期初的进项留抵作为第一个月的上期留抵。
 * 返回 period 这个月的发生额、上期留抵、应纳和期末留抵。
 */
function rollCarry(months: Map<string, VatFlows>, period: string, start: string | null, opening: number) {
  let first = start != null && start < period ? start : period;
  for (const key of months.keys()) if (key < first) first = key;
  let carry = 0,
    month = { ...noFlows(), carryIn: 0, payable: 0, carryOut: 0 };
  for (let p = first; p <= period; p = adjacentPeriod(p, 1)) {
    if (p === start) carry += opening;
    const m = months.get(p) ?? noFlows();
    const net = m.output - m.input + m.transfer - carry;
    month = { ...m, carryIn: carry, payable: Math.max(0, net), carryOut: Math.max(0, -net) };
    carry = month.carryOut;
  }
  return month;
}

/** 税务底稿：增值税销项、进项、进项转出和留抵（按月滚动），附加税；结账计提税费也用它。 */
export class FinanceTax {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  worksheet(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { period } = z.object({ period: periodSchema }).parse(raw);
    const settings = readFinanceSettings(this.db);
    const rates = settings.taxRates;
    const months = vatMonths(this.db, period);
    const { output, input, transfer, carryIn, payable, carryOut } = rollCarry(
      months,
      period,
      settings.start_period,
      openingCarry(this.db),
    );
    const rateAmount = (value: number, rate: number | null) =>
      rate == null ? null : proportion(value, rate, BASIS_POINTS);
    const taxable = sumOf(
      this.db,
      "SELECT coalesce(sum(net),0) AS n FROM fin_invoices WHERE direction='sale' AND date BETWEEN ? AND ? AND status IN ('normal','red')",
      period + '-01',
      endOfMonth(period),
    );
    const smallEstimate =
      rates.smallVat == null
        ? null
        : percentCents(Math.max(0, taxable), String(rates.smallVat), 1, BASIS_POINTS_PER_PERCENT);
    const base = settings.taxpayer === 'small' ? smallEstimate : payable;
    return {
      period,
      taxpayer: settings.taxpayer,
      output,
      input,
      transfer,
      carryIn,
      carryOut,
      payable: base,
      rates,
      urban: base == null ? null : rateAmount(base, rates.urban),
      education: base == null ? null : rateAmount(base, rates.education),
      localEducation: base == null ? null : rateAmount(base, rates.localEducation),
      notice: '请以税局系统为准',
    };
  }
}
