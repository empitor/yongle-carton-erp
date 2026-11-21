// 归前端财务-乙（reports 页，成本毛利在 costs 页）。财务接口表“报表结账”一块（服务端 server/finance/routes-period.ts 的 periodRoutes）：
// 成本、毛利，正式报表、预算、结账和归档。
// 看板（reports/dashboard）是甲在第 1 批给概览写的（照 server/finance/reports.ts 的 dashboard）。
import type { FinanceSourceKind } from '../core/index.js';
import type { Body, Data, Page, Paging } from './finance-api-shapes.js';
import type { PeriodJobResult } from './finance-api-costs.js';
import type { BookBalanceRow } from './finance-api-ledger.js';
import type { MonthlyReport } from './finance-api-overview.js';
import type { AgingTotal } from './finance-api-parties.js';
import type { FinancePeriod } from './finance-api-settings.js';

/**
 * 经营看板：这个月和最近 12 个月的经营数，有没有缺税率、缺价格（数字是估算），
 * 记账口径按凭证算的收入、成本、利润（分），待补单据的金额、含待补的估算收入、资金余额、应收应付按账龄档的合计
 */
type ReportDashboard = {
  period: string;
  current: MonthlyReport;
  trend: MonthlyReport[];
  estimated: boolean;
  missingTax: number;
  accounting: {
    revenue: number;
    salesCost: number;
    expense: number;
    profit: number;
    grossProfit: number;
    pendingAmount: number;
    estimatedRevenue: number;
    cash: number;
    receivable: AgingTotal[];
    payable: AgingTotal[];
  };
};

/** 一个月一个库存品的成本（fin_cost_snapshots 一行）：期初、入库、出库、期末的数量（千分之一）和金额（分） */
type CostingRow = {
  stock_id: number;
  period: string;
  stock_name: string;
  unit: string;
  opening_qty: number;
  opening_cents: number;
  in_qty: number;
  in_cents: number;
  out_qty: number;
  out_cents: number;
  end_qty: number;
  end_cents: number;
};
/** 算成本前要人填的一笔出入库：要不要补金额、对方科目，是不是跨期补登 */
type CostingValuation = {
  needsAmount: boolean;
  needsCounter: boolean;
  late: boolean;
  id: string;
  date: string;
  quantity: number;
  source_kind: string;
  notes: string;
  name: string;
  unit: string;
  kind: 'raw' | 'finished';
};
/** 算成本时填的一笔金额（重做时带出来） */
type CostingValuationInput = { movementId: string; unit: string; amount: number; reason: string; counterAccount?: string };
/**
 * 算成本前要准备的（照 server/finance/costing.ts 的 requirements）：算过没有（done 是重做）、是不是启用月、
 * 启用前已有库存要填的期初、跨期补登的流水、上次填的金额和期初、要人填的出入库
 */
type CostingRequirements = {
  period: string;
  done: boolean;
  isStart: boolean;
  opening: { stockId: number; name: string; unit: string; quantity: number }[];
  late: { id: string; date: string; name: string; unit: string; quantity: number; source_kind: string }[];
  previousValuations: CostingValuationInput[];
  previousOpening: { stockId: number; amount: number }[];
  voucherId: number | null;
  valuations: CostingValuation[];
};
/** 算成本的明细（照 server/finance/costing.ts 的 costingDetails） */
type CostingDetails = {
  rows: {
    stockId: number;
    name: string;
    kind: string;
    unit: string;
    openingQty: number;
    openingCents: number;
    inQty: number;
    inCents: number;
    outQty: number;
    outCents: number;
    endQty: number;
    endCents: number;
  }[];
  sales: { id: string; orderId: number | null; customerId: number | null; productId: number | null; cost: number }[];
  valuations: CostingValuationInput[];
  applied: string[];
  issues: [string, number, string][];
  receipts: [string, number, string][];
  residuals: { stockId: number; name: string; cents: number; account: string; reason: string }[];
  late: string[];
  ranAt: string;
  maxRowid: number;
};
/** 毛利一行：按订单、客户、产品或月份分组（没分配的是 null），成本没算的是 null，estimated 是收入里估算的部分 */
type MarginRow = { group_id: string | number | null; revenue: number; cost: number | null; margin: number | null; estimated: number };

/** 月末几步：计提工资、税费、折旧、算成本 */
type PeriodJobKind = 'payroll' | 'tax' | 'depreciation' | 'costing';
/** 结账检查里的待补单据一行（业务单据的财务事件，或还没登记进来的单据） */
type ClosingReadinessRow =
  | {
      problem: string | null;
      missing: string[];
      id: number;
      source_kind: string;
      source_id: string;
      number: string | null;
      date: string;
      amount_cents: number | null;
    }
  | {
      number: string | null;
      id: number | null;
      source_kind: FinanceSourceKind;
      source_id: string;
      date: string;
      amount_cents: number | null;
      status: 'info_pending' | 'ready' | 'difference' | 'cost_pending' | 'waiting_invoice' | 'no_amount';
      missing: ('quantity' | 'tax' | 'price')[];
      problem: string | null;
    };
/** 结账检查的一步（照 server/finance/closing.ts 的 check）：各步带的东西不一样，月末几步（key 是 jobs）带还没做的 missing 和要重做的 stale */
type ClosingStep =
  | { key: string; ok: boolean; stale: boolean; annualStale: boolean; annualNext: boolean; blocking: boolean }
  | { key: string; ok: boolean; count: number; blocking: boolean }
  | {
      key: string;
      ok: boolean;
      missing: PeriodJobKind[];
      stale: { kind: PeriodJobKind; reason: string; voucherId: number | null }[];
      blocking: boolean;
    }
  | {
      key: string;
      ok: boolean;
      count: number;
      items: {
        id: number;
        version: number;
        source_kind: string;
        source_id: string;
        number: string | null;
        date: string;
        problem: string;
      }[];
      blocking: boolean;
    }
  | { key: string; ok: boolean; blocking: boolean };
/**
 * 出正式报表、结账前资料补没补完（照 server/finance/reports.ts 的 readiness）：补完了没有、还卡着几张、
 * 其中几张是已冲销的送货单、涉及金额（分）、其中送货的金额、还没登记进财务的几张和其中前几张是哪几张
 * （读之前已补扫到完，剩下的是内容读不出来、补扫跳过的）、列出来的前几张
 */
type ReportReadiness = {
  period: string;
  ready: boolean;
  count: number;
  reversalCount: number;
  amount: number;
  deliveryAmount: number;
  unsynced: number;
  /** 读之前的补扫没成功（原因在出错记录里）：正式报表、结账照拦 */
  syncFailed: boolean;
  unsyncedSources: { source_kind: FinanceSourceKind; source_id: string; number: string | null }[];
  rows: ClosingReadinessRow[];
};
/** 结账检查：这个月和下一个能结的月、这个月的期间记录、待补单据、各步、能不能结账 */
type ClosingCheck = {
  period: string;
  next: string | null;
  record: FinancePeriod | null;
  readiness: ReportReadiness;
  steps: ClosingStep[];
  canClose: boolean;
};

/* 正式报表（照 server/finance/report-shapes.ts、report-sheets.ts）：金额是分，已结账的月份是结账时存的快照 */

/** 报表一行点进去看的：这个科目这个月的明细账 */
type ReportDrill = { kind: 'detail'; period: string; account: string };
/** 几张表都有的：期间、项目和公式还没经过懂账的人复核 */
type ReportHead = { period: string; needsReview: boolean };
/** 资产负债表一行：期末、年初（按科目方向取过正负） */
type BalanceLine = { id: string; name: string; amount: number; opening: number; drill: ReportDrill[] };
type BalanceReport = ReportHead & {
  name: string;
  assets: BalanceLine[];
  liabilities: BalanceLine[];
  equity: BalanceLine[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  difference: number;
  balanced: boolean;
};
/** 利润表一行：本月、本年累计 */
type ProfitLine = { id: string; name: string; amount: number; ytd: number; drill: ReportDrill[] };
type ProfitReport = ReportHead & { name: string; lines: ProfitLine[]; netProfit: number; yearProfit: number };
/** 现金流量表一行：一个现金流量项目（没填是 null）在一个现金科目上的净额、几条分录、归哪类活动 */
type CashflowLine = {
  item: string | null;
  account_code: string;
  amount: number;
  entries: number;
  group: string;
  drill: ReportDrill;
};
type CashflowReport = ReportHead & {
  name: string;
  lines: CashflowLine[];
  opening: number;
  total: number;
  ending: number;
  unclassified: CashflowLine[];
};
/** 试算平衡表：科目余额表的全部行和期初、期末、本期借贷的合计 */
type TrialReport = ReportHead & {
  rows: BookBalanceRow[];
  opening: number;
  ending: number;
  debit: number;
  credit: number;
  balanced: boolean;
};

/** 预算（fin_budgets 一行，金额是分） */
type BudgetRecord = { period: string; account_code: string; amount_cents: number; version: number };
/** 预算列表一行：加科目名称、这个月实际发生、差额（实际减预算） */
type BudgetRow = BudgetRecord & { name: string; actual: number; difference: number };

export type ReportsApi = {
  /** 一个月的库存成本，可只看一个库存品 */
  'GET /finance/costing': { query: { period: string; stockId?: number } & Paging; response: Page<CostingRow> };
  'GET /finance/costing/requirements': { query: { period: string }; response: CostingRequirements };
  /** 算（或重做）一个月的成本 */
  'POST /finance/costing': { body: Body; response: PeriodJobResult<CostingDetails> };
  /** 毛利，按订单、客户、产品或月份分组 */
  'GET /finance/margin': {
    query: { period: string; group?: 'order' | 'customer' | 'product' | 'month' } & Paging;
    response: Page<MarginRow>;
  };
  'GET /finance/reports/readiness': { query: { period: string }; response: ReportReadiness };
  'GET /finance/reports/dashboard': { query: { period: string }; response: ReportDashboard };
  /** kind 是 trial、balance、profit、cashflow；回的那张表没带种类，页面按各表自己的项认（试算平衡表有 rows） */
  'GET /finance/reports/:kind': {
    query: { period: string };
    response: TrialReport | BalanceReport | ProfitReport | CashflowReport;
  };
  'GET /finance/budgets': { query: { period: string } & Paging; response: Page<BudgetRow> };
  /** 新建或改一个科目这个月的预算（改要带版本） */
  'PUT /finance/budgets': { body: Body; response: BudgetRecord };
  /** 结账检查；stale=0 只看各步跑没跑（工资、资产页面用），不重算看要不要重做 */
  'GET /finance/closing': { query: { period: string; stale?: '0' | '1' }; response: ClosingCheck };
  /** 计提税费：明细是增值税工作底稿各项，加税前利润和所得税 */
  'POST /finance/closing/tax': {
    body: Body;
    response: PeriodJobResult<Data & { pretax: number; income: number }>;
  };
  /** 结转损益（12 月带 annual 是年度利润）：几行分录，补结转时带原来那张凭证 */
  'POST /finance/closing/profit': {
    body: Body;
    response: PeriodJobResult<{ entries: number; previousVoucher?: number | null }>;
  };
  /** 结账、反结账：回这个月改好的期间记录 */
  'POST /finance/closing/close': { body: Body; response: FinancePeriod };
  'POST /finance/closing/reopen': { body: Body; response: FinancePeriod };
};
