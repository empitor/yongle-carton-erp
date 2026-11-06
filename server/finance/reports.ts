import { z } from 'zod';
import {
  periodSchema,
  accountCodeSchema,
  centsSchema,
  versionSchema,
} from '../../shared/finance.js';
import {
  financeReportTemplates as templates,
  type ReportLine,
} from '../../shared/finance-report-templates.js';
import { ImportError } from '../import/errors.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { FinanceBooks } from './books.js';
import { FinanceMonthly } from './monthly.js';
import { FinanceEvents } from './events.js';
import { FinanceOverview } from './overview.js';
import { FinanceParties } from './parties.js';
import { activeCashAllocation, allocationReversalMessage } from './pending-delivery.js';
import { entry, endOfMonth, pageSql, request } from './query.js';

const type = z.enum(['balance', 'profit', 'cashflow', 'trial']);
const filter = z.object({ period: periodSchema });
type Amount = Record<
  'opening' | 'debit' | 'credit' | 'ending' | 'year_debit' | 'year_credit',
  number
>;
const isPrefix = (code: unknown, prefixes: string[]) =>
  prefixes.some((p) => String(code).startsWith(p));
export class FinanceInfoPending extends ImportError {
  constructor(readonly details: ReturnType<FinanceReports['readiness']>) {
    super(
      details.reversalCount
        ? '本期有冲销送货单待处理，请先撤销核销并记账相关红冲。'
        : '本期有待补财务资料，请补完后再输出正式报表。',
      409,
      'FINANCE_INFO_PENDING',
    );
  }
}
export class FinanceReports {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }
  readiness(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { period } = filter.parse(raw);
    const unsynced = new FinanceEvents(this.store).unsynced(actor, period);
    const pending = unsynced.filter((r) => r.status === 'info_pending');
    const query = `FROM (
      SELECT e.*, EXISTS(SELECT 1 FROM flow_documents f WHERE e.source_kind='delivery' AND f.kind='delivery'
        AND f.id=cast(e.source_id AS INTEGER) AND f.status='reversed') AS reversed,
        EXISTS(SELECT 1 FROM fin_obligations o JOIN fin_allocations a ON a.obligation_id=o.id
          JOIN fin_vouchers original ON original.id=a.voucher_id WHERE o.event_id=e.id AND ${activeCashAllocation}) AS allocated
      FROM fin_events e WHERE e.status IN ('info_pending','awaiting_allocation_reversal') AND e.date BETWEEN ? AND ?
      AND e.id NOT IN (SELECT value FROM json_each(?))
    ) WHERE status='awaiting_allocation_reversal' OR NOT reversed OR allocated`;
    const bounds = [
      period + '-01',
      endOfMonth(period),
      JSON.stringify(unsynced.flatMap((r) => (r.id == null ? [] : [r.id]))),
    ];
    const totals = this.db
      .prepare(
        `SELECT count(*) AS count,coalesce(sum(reversed OR status='awaiting_allocation_reversal'),0) AS reversal_count,
        coalesce(sum(CASE WHEN NOT reversed THEN amount_cents END),0) AS amount,
        coalesce(sum(CASE WHEN source_kind='delivery' AND NOT reversed THEN amount_cents END),0) AS delivery ${query}`,
      )
      .get(...bounds)!;
    const rows = this.db
      .prepare(
        `SELECT id,source_kind,source_id,coalesce(json_extract(snapshot,'$.doc.number'),json_extract(snapshot,'$.doc.reference')) AS number,date,amount_cents,problem,reversed OR status='awaiting_allocation_reversal' AS reverse_pending,
      json_extract(snapshot,'$.missing') AS missing ${query} ORDER BY date,id LIMIT 30`,
      )
      .all(...bounds);
    return {
      period,
      ready: !totals.count && pending.length === 0,
      count: Number(totals.count) + pending.length,
      reversalCount: Number(totals.reversal_count),
      amount: Number(totals.amount) + pending.reduce((n, r) => n + Number(r.amount_cents), 0),
      deliveryAmount:
        Number(totals.delivery) +
        pending
          .filter((r) => r.source_kind === 'delivery')
          .reduce((n, r) => n + Number(r.amount_cents), 0),
      unsynced: unsynced.length,
      rows: [
        ...rows.map(({ reverse_pending, ...r }) => ({
          ...r,
          problem: reverse_pending ? allocationReversalMessage : r.problem,
          missing: reverse_pending
            ? ['allocation_reversal']
            : (JSON.parse(String(r.missing ?? '[]')) as string[]),
        })),
        ...pending
          .slice(0, 30)
          .map(({ snapshot, theoretical: _theoretical, ...r }) => ({
            ...r,
            number: snapshot.doc?.number ?? snapshot.doc?.reference ?? null,
          })),
      ].slice(0, 30),
    };
  }
  assertReady(user: Actor, period: string) {
    const readiness = this.readiness(user, { period });
    if (!readiness.ready) throw new FinanceInfoPending(readiness);
  }
  balances(actor: Actor | null, period: string) {
    const books = new FinanceBooks(this.store);
    const all = [];
    for (let page = 1; ; page++) {
      const data = books.read(actor, 'balance', { period, page, pageSize: 200 });
      all.push(...data.rows);
      if (page * data.pageSize >= data.filteredRecords) break;
    }
    return all as unknown as (Amount & { account_code: string; account_name: string })[];
  }
  get(actor: Actor | null, rawType: unknown, raw: unknown, snapshot = true) {
    const user = financeActor(actor),
      kind = type.parse(rawType),
      { period } = filter.parse(raw);
    if (kind !== 'trial') this.assertReady(user, period);
    if (
      snapshot &&
      kind !== 'trial' &&
      this.db.prepare("SELECT 1 FROM fin_periods WHERE period=? AND status='closed'").get(period)
    ) {
      const saved = this.db
        .prepare(
          'SELECT document FROM fin_report_snapshots WHERE period=? ORDER BY version DESC LIMIT 1',
        )
        .get(period);
      if (saved) return JSON.parse(String(saved.document))[kind] as Record<string, unknown>;
    }
    const b = this.balances(user, period),
      accounts = this.db.prepare('SELECT code,category FROM fin_accounts').all();
    const category = new Map(accounts.map((a) => [a.code, a.category]));
    const sum = (rows: typeof b, key: keyof Amount) => rows.reduce((n, r) => n + r[key], 0);
    const base = { period, needsReview: templates.needsReview };
    if (kind === 'trial')
      return {
        ...base,
        rows: b,
        opening: sum(b, 'opening'),
        ending: sum(b, 'ending'),
        debit: sum(b, 'debit'),
        credit: sum(b, 'credit'),
        balanced: sum(b, 'ending') === 0 && sum(b, 'opening') === 0,
      };
    const mapped = (
      items: ReportLine[],
      pick: (formula: ReportLine['formula']) => { amount: number; opening?: number; ytd?: number },
    ) =>
      items.map((item) => ({
        id: item.id,
        name: item.name,
        ...pick(item.formula),
        drill: item.formula.prefixes.map((account) => ({ kind: 'detail', period, account })),
      }));
    if (kind === 'balance') {
      const fallback = (categoryName: string, rows: ReportLine[], sign: 1 | -1): ReportLine[] => {
        const codes = b.filter(
          (r) =>
            category.get(r.account_code) === categoryName &&
            !rows.some((x) => isPrefix(r.account_code, x.formula.prefixes)),
        );
        return codes.length
          ? [
              ...rows,
              {
                id: 'other_' + categoryName,
                name:
                  '其他' +
                  (
                    { asset: '资产', liability: '负债', equity: '权益', cost: '成本' } as Record<
                      string,
                      string
                    >
                  )[categoryName],
                formula: { prefixes: codes.map((c) => c.account_code), sign },
              },
            ]
          : rows;
      };
      const build = (lines: ReportLine[]) =>
        mapped(lines, ({ prefixes, sign }) => {
          const rows = b.filter((r) => isPrefix(r.account_code, prefixes));
          return { amount: sum(rows, 'ending') * sign, opening: sum(rows, 'opening') * sign };
        });
      const assets = build(fallback('cost', fallback('asset', templates.balance.assets, 1), 1));
      const liabilities = build(fallback('liability', templates.balance.liabilities, -1));
      const equity = build(fallback('equity', templates.balance.equity, -1));
      const profit = b.filter((r) => category.get(r.account_code) === 'profit');
      equity.push({
        id: 'unclosedProfit',
        name: '未结转损益',
        amount: -sum(profit, 'ending'),
        opening: -sum(profit, 'opening'),
        drill: profit.map((r) => ({ kind: 'detail', period, account: r.account_code })),
      });
      const sumRows = (rows: typeof assets) => rows.reduce((n, r) => n + r.amount, 0);
      const totalAssets = sumRows(assets),
        totalLiabilities = sumRows(liabilities),
        totalEquity = sumRows(equity);
      return {
        ...base,
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
    if (kind === 'profit') {
      const facts = this.db
        .prepare(
          `SELECT e.account_code,sum((e.debit-e.credit)*CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END) AS ytd,
        sum(CASE WHEN v.period=? THEN (e.debit-e.credit)*CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END ELSE 0 END) AS current
        FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id JOIN fin_accounts a ON a.code=e.account_code
        WHERE a.category='profit' AND v.status='posted' AND v.period BETWEEN ? AND ?
        AND coalesce(v.module_source,'') NOT IN ('profit_close','annual_close') GROUP BY e.account_code`,
        )
        .all(period, period.slice(0, 4) + '-01', period);
      const opening = this.db
        .prepare(
          `SELECT account_code,year_debit-year_credit AS amount FROM fin_opening WHERE auxiliary_id IS NULL
        AND EXISTS(SELECT 1 FROM fin_settings WHERE substr(start_period,1,4)=?)`,
        )
        .all(period.slice(0, 4));
      const lines = mapped(templates.profit.lines, ({ prefixes, sign }) => {
        const rows = facts.filter((r) => isPrefix(r.account_code, prefixes));
        return {
          amount: rows.reduce((n, r) => n + Number(r.current), 0) * sign,
          ytd:
            (rows.reduce((n, r) => n + Number(r.ytd), 0) +
              opening
                .filter((r) => isPrefix(r.account_code, prefixes))
                .reduce((n, r) => n + Number(r.amount), 0)) *
            sign,
        };
      });
      const netProfit = -facts.reduce((n, r) => n + Number(r.current), 0);
      const yearProfit =
        -facts.reduce((n, r) => n + Number(r.ytd), 0) -
        opening
          .filter((r) => category.get(r.account_code) === 'profit')
          .reduce((n, r) => n + Number(r.amount), 0);
      return { ...base, name: templates.profit.name, lines, netProfit, yearProfit };
    }
    const facts = this.db
      .prepare(
        `SELECT e.cash_flow AS item,e.account_code,sum((e.debit-e.credit)*
      (CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)) AS amount,count(*) AS entries
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id JOIN fin_accounts a ON a.code=e.account_code
      WHERE v.status='posted' AND v.period=? AND (a.cash_kind IS NOT NULL OR EXISTS(
        SELECT 1 FROM fin_cash_accounts c WHERE c.account_code=e.account_code))
      GROUP BY e.cash_flow,e.account_code`,
      )
      .all(period);
    const lines = facts.map((r) => ({
      ...r,
      amount: Number(r.amount),
      group:
        Object.entries(templates.cashflow.groups).find(([, items]) =>
          items.includes(String(r.item)),
        )?.[0] ?? (r.item === '内部转账' ? 'transfer' : 'unclassified'),
      drill: { kind: 'detail', period, account: r.account_code },
    }));
    const opening = b
      .filter((r) =>
        this.db
          .prepare(
            'SELECT 1 FROM fin_accounts a WHERE code=? AND (cash_kind IS NOT NULL OR EXISTS(SELECT 1 FROM fin_cash_accounts c WHERE c.account_code=a.code))',
          )
          .get(r.account_code),
      )
      .reduce((n, r) => n + r.opening, 0);
    const total = lines.reduce((n, r) => n + Number(r.amount), 0);
    return {
      ...base,
      name: templates.cashflow.name,
      lines,
      opening,
      total,
      ending: opening + total,
      unclassified: lines.filter((r) => r.group === 'unclassified'),
    };
  }
  budgets(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { period } = filter.parse(raw);
    return pageSql(
      this.db,
      `SELECT *,actual-amount_cents AS difference FROM (
      SELECT b.*,a.name,(CASE WHEN a.direction='credit' THEN -1 ELSE 1 END)*coalesce((SELECT sum((e.debit-e.credit)*CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.period=b.period AND v.status='posted'
      AND coalesce(v.module_source,'') NOT IN ('profit_close','annual_close') AND e.account_code LIKE b.account_code||'%'),0) AS actual
      FROM fin_budgets b JOIN fin_accounts a ON a.code=b.account_code WHERE b.period=?)`,
      [period],
      raw,
      'account_code',
    );
  }
  budget(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = request
      .extend({
        period: periodSchema,
        accountCode: accountCodeSchema,
        amount: centsSchema,
        version: versionSchema.optional(),
      })
      .parse(raw);
    return financeWrite(this.store, user, 'budget.save', v, () => {
      if (this.db.prepare("SELECT 1 FROM fin_periods WHERE period=? AND status='closed'").get(v.period))
        financeError('该期间已结账，不能修改预算。', 409);
      const get = () =>
        this.db
          .prepare('SELECT * FROM fin_budgets WHERE period=? AND account_code=?')
          .get(v.period, v.accountCode);
      const before = get();
      if (before) checkVersion(before, v.version ?? 0);
      else if (v.version) financeError('预算记录不存在。', 404);
      if (!this.db.prepare('SELECT 1 FROM fin_accounts WHERE code=?').get(v.accountCode))
        financeError('预算科目不存在。');
      this.db
        .prepare(
          `INSERT INTO fin_budgets(period,account_code,amount_cents) VALUES(?,?,?)
        ON CONFLICT(period,account_code) DO UPDATE SET amount_cents=excluded.amount_cents,version=version+1`,
        )
        .run(v.period, v.accountCode, v.amount);
      const after = get()!;
      financeAudit(this.store, user, 'save', 'fin_budgets', null, before ?? null, after);
      return { ...after };
    });
  }
  dashboard(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor),
      { period } = filter.parse(raw);
    const monthly = new FinanceMonthly(this.store);
    const trend = monthly.trend(user, { period });
    const current = trend.at(-1)!;
    const accounting = this.db
      .prepare(
        `SELECT
      coalesce(sum(CASE WHEN e.account_code LIKE '5001%' OR e.account_code LIKE '5051%' THEN -amount ELSE 0 END),0) AS revenue,
      coalesce(sum(CASE WHEN e.account_code LIKE '5401%' OR e.account_code LIKE '5402%' THEN amount ELSE 0 END),0) AS salesCost,
      coalesce(sum(CASE WHEN e.account_code LIKE '56%' THEN amount ELSE 0 END),0) AS expense,
      coalesce(sum(-amount),0) AS profit
      FROM (SELECT e.account_code,(e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END) AS amount
        FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id JOIN fin_accounts a ON a.code=e.account_code
        WHERE v.status='posted' AND v.period=? AND a.category='profit' AND coalesce(v.module_source,'')<>'profit_close') e`,
      )
      .get(period)!;
    const date = endOfMonth(period),
      parties = new FinanceParties(this.store);
    const receivable = parties.aging(user, { kind: 'receivable', date, pageSize: 1 });
    const payable = parties.aging(user, { kind: 'payable', date, pageSize: 1 });
    const pending = this.readiness(user, { period });
    const funds = new FinanceOverview(this.store).summary(user, { date });
    return {
      period,
      current,
      trend,
      estimated: current.missingTax > 0 || current.missingPrice > 0,
      missingTax: current.missingTax,
      accounting: {
        ...accounting,
        grossProfit: Number(accounting.revenue) - Number(accounting.salesCost),
        pendingAmount: pending.amount,
        estimatedRevenue: Number(accounting.revenue) + pending.deliveryAmount,
        cash: funds.accounts.reduce((n, r) => n + Number(r.balance), 0),
        receivable: receivable.totals,
        payable: payable.totals,
      },
    };
  }
  profitClosingEntries(user: Actor, period: string) {
    const b = this.balances(user, period);
    const lines = b.flatMap((r) => {
      const a = this.db
        .prepare('SELECT category,auxiliary FROM fin_accounts WHERE code=?')
        .get(r.account_code);
      if (a?.category !== 'profit' || !r.ending) return [];
      if (a.auxiliary) financeError('损益科目启用了辅助核算，需逐辅助项结转。');
      return [entry(r.account_code, Math.max(0, -r.ending), Math.max(0, r.ending))];
    });
    const balance = lines.reduce((n, r) => n + r.debit - r.credit, 0);
    if (balance) lines.push(entry('3103', Math.max(0, -balance), Math.max(0, balance)));
    return lines;
  }
}
