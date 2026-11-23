/**
 * 正式报表怎么算：试算平衡表、资产负债表按科目余额表，利润表、现金流量表按已记账分录。
 * FinanceReports.get 查完权限、资料齐不齐、有没有结账快照以后调这里。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Actor, Store } from '../../core/index.js';
import { many, rows } from '../../core/index.js';
import { financeReportTemplates as templates, type ReportLine } from '../../../shared/finance/index.js';
import { FinanceBooks } from '../ledger/books.js';
import { allPages } from '../base/query.js';
import { yearOf } from '../base/days.js';
import type {
  BalanceReport,
  CashflowReport,
  Drill,
  ProfitReport,
  ReportSnapshot,
  SnapshotKind,
} from './report-shapes.js';

/** 科目余额表的全部行：各科目（按辅助项分开时各辅助项）期初、本期、本年和期末 */
export function ledgerBalances(store: Store, actor: Actor | null, period: string) {
  const books = new FinanceBooks(store);
  return allPages((paging) => books.read(actor, 'balance', { period, ...paging }));
}
type Balance = ReturnType<typeof ledgerBalances>[number];
type Amount = 'opening' | 'debit' | 'credit' | 'ending' | 'year_debit' | 'year_credit';

/** 科目编码 → 类别（资产、负债、权益、成本、损益） */
export const categoryByCode = (db: DatabaseSync) =>
  new Map(
    many(db, rows.fin_accounts.pick({ code: true, category: true }), 'SELECT code,category FROM fin_accounts').map(
      (a) => [a.code, a.category],
    ),
  );

const isPrefix = (code: string, prefixes: string[]) => prefixes.some((p) => code.startsWith(p));
const sum = (lines: readonly Balance[], key: Amount) => lines.reduce((n, r) => n + r[key], 0);
const head = (period: string) => ({ period, needsReview: templates.needsReview });
const drillTo = (period: string, account: string): Drill => ({ kind: 'detail', period, account });
/** 模板的每一行按公式取数，带上点进去看的科目 */
const mapped = <P extends object>(period: string, items: ReportLine[], pick: (formula: ReportLine['formula']) => P) =>
  items.map((item) => ({
    id: item.id,
    name: item.name,
    ...pick(item.formula),
    drill: item.formula.prefixes.map((account) => drillTo(period, account)),
  }));

export function trialBalance(period: string, b: Balance[]) {
  return {
    ...head(period),
    rows: b,
    opening: sum(b, 'opening'),
    ending: sum(b, 'ending'),
    debit: sum(b, 'debit'),
    credit: sum(b, 'credit'),
    balanced: sum(b, 'ending') === 0 && sum(b, 'opening') === 0,
  };
}
export type TrialReport = ReturnType<typeof trialBalance>;

/** 模板没列到的同类科目归成的“其他××”一行叫什么 */
type OtherCategory = 'asset' | 'liability' | 'equity' | 'cost';
const otherNames: Record<OtherCategory, string> = { asset: '资产', liability: '负债', equity: '权益', cost: '成本' };

export function balanceSheet(period: string, b: Balance[], category: Map<string, string>): BalanceReport {
  const withOthers = (categoryName: OtherCategory, lines: ReportLine[], sign: 1 | -1): ReportLine[] => {
    const codes = b.filter(
      (r) =>
        category.get(r.account_code) === categoryName &&
        !lines.some((x) => isPrefix(r.account_code, x.formula.prefixes)),
    );
    if (!codes.length) return lines;
    const prefixes = codes.map((c) => c.account_code);
    return [...lines, { id: 'other_' + categoryName, name: '其他' + otherNames[categoryName], formula: { prefixes, sign } }];
  };
  const build = (lines: ReportLine[]) =>
    mapped(period, lines, ({ prefixes, sign }) => {
      const matched = b.filter((r) => isPrefix(r.account_code, prefixes));
      return { amount: sum(matched, 'ending') * sign, opening: sum(matched, 'opening') * sign };
    });
  const assets = build(withOthers('cost', withOthers('asset', templates.balance.assets, 1), 1));
  const liabilities = build(withOthers('liability', templates.balance.liabilities, -1));
  const equity = build(withOthers('equity', templates.balance.equity, -1));
  const profit = b.filter((r) => category.get(r.account_code) === 'profit');
  equity.push({
    id: 'unclosedProfit',
    name: '未结转损益',
    amount: -sum(profit, 'ending'),
    opening: -sum(profit, 'opening'),
    drill: profit.map((r) => drillTo(period, r.account_code)),
  });
  const total = (lines: typeof assets) => lines.reduce((n, r) => n + r.amount, 0);
  const totalAssets = total(assets),
    totalLiabilities = total(liabilities),
    totalEquity = total(equity);
  return {
    ...head(period),
    name: templates.balance.name,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    difference: totalAssets - totalLiabilities - totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

/** 损益科目本月、本年发生额（不含损益结转、年度结转凭证），红字凭证取负 */
const profitFact = z.object({ account_code: z.string(), ytd: z.number(), current: z.number() });
/** 期初录入的本年累计（启用当年才有） */
const openingYear = z.object({ account_code: z.string(), amount: z.number() });

export function profitStatement(db: DatabaseSync, period: string, category: Map<string, string>): ProfitReport {
  const year = yearOf(period);
  const facts = many(
    db,
    profitFact,
    `SELECT e.account_code,sum((e.debit-e.credit)*CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END) AS ytd,
    sum(CASE WHEN v.period=? THEN (e.debit-e.credit)*CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END ELSE 0 END) AS current
    FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id JOIN fin_accounts a ON a.code=e.account_code
    WHERE a.category='profit' AND v.status='posted' AND v.period BETWEEN ? AND ?
    AND coalesce(v.module_source,'') NOT IN ('profit_close','annual_close') GROUP BY e.account_code`,
    period,
    year + '-01',
    period,
  );
  const opening = many(
    db,
    openingYear,
    `SELECT account_code,year_debit-year_credit AS amount FROM fin_opening WHERE auxiliary_id IS NULL
    AND EXISTS(SELECT 1 FROM fin_settings WHERE substr(start_period,1,4)=?)`,
    year,
  );
  const lines = mapped(period, templates.profit.lines, ({ prefixes, sign }) => {
    const matched = facts.filter((r) => isPrefix(r.account_code, prefixes));
    const openingYtd = opening.filter((r) => isPrefix(r.account_code, prefixes)).reduce((n, r) => n + r.amount, 0);
    return {
      amount: matched.reduce((n, r) => n + r.current, 0) * sign,
      ytd: (matched.reduce((n, r) => n + r.ytd, 0) + openingYtd) * sign,
    };
  });
  const netProfit = -facts.reduce((n, r) => n + r.current, 0);
  const yearProfit =
    -facts.reduce((n, r) => n + r.ytd, 0) -
    opening.filter((r) => category.get(r.account_code) === 'profit').reduce((n, r) => n + r.amount, 0);
  return { ...head(period), name: templates.profit.name, lines, netProfit, yearProfit };
}

/** 现金科目上的分录按现金流量项目、科目合计 */
const cashFact = z.object({
  item: rows.fin_entries.shape.cash_flow,
  account_code: z.string(),
  amount: z.number(),
  entries: z.number(),
});
/** 现金流量项目归哪类活动：模板里列了的按模板，内部转账单列，别的算未归类 */
const cashGroup = (item: string | null) =>
  Object.entries(templates.cashflow.groups).find(([, items]) => items.includes(String(item)))?.[0] ??
  (item === '内部转账' ? 'transfer' : 'unclassified');

export function cashflowStatement(db: DatabaseSync, period: string, b: Balance[]): CashflowReport {
  const facts = many(
    db,
    cashFact,
    `SELECT e.cash_flow AS item,e.account_code,sum((e.debit-e.credit)*
    (CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)) AS amount,count(*) AS entries
    FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id JOIN fin_accounts a ON a.code=e.account_code
    WHERE v.status='posted' AND v.period=? AND (a.cash_kind IS NOT NULL OR EXISTS(
      SELECT 1 FROM fin_cash_accounts c WHERE c.account_code=e.account_code))
    GROUP BY e.cash_flow,e.account_code`,
    period,
  );
  const lines = facts.map((r) => ({ ...r, group: cashGroup(r.item), drill: drillTo(period, r.account_code) }));
  // 期初现金：现金、银行科目和资金账户挂的科目的期初
  const cashCodes = new Set(
    many(
      db,
      rows.fin_accounts.pick({ code: true }),
      'SELECT code FROM fin_accounts a WHERE cash_kind IS NOT NULL OR EXISTS(SELECT 1 FROM fin_cash_accounts c WHERE c.account_code=a.code)',
    ).map((a) => a.code),
  );
  const opening = b.filter((r) => cashCodes.has(r.account_code)).reduce((n, r) => n + r.opening, 0);
  const total = lines.reduce((n, r) => n + r.amount, 0);
  return {
    ...head(period),
    name: templates.cashflow.name,
    lines,
    opening,
    total,
    ending: opening + total,
    unclassified: lines.filter((r) => r.group === 'unclassified'),
  };
}

/** 一张报表：哪种和算出来的内容（导出、归档按种类排版） */
export type Report =
  | { kind: 'balance'; data: BalanceReport }
  | { kind: 'profit'; data: ProfitReport }
  | { kind: 'cashflow'; data: CashflowReport }
  | { kind: 'trial'; data: TrialReport };

/** 结账快照里的一张 */
export function savedReport(saved: ReportSnapshot, kind: SnapshotKind): Report {
  switch (kind) {
    case 'balance':
      return { kind, data: saved.balance };
    case 'profit':
      return { kind, data: saved.profit };
    case 'cashflow':
      return { kind, data: saved.cashflow };
  }
}
