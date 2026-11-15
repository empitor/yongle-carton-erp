// 归前端财务-甲。财务接口表“概览和月度台账”一块（服务端 server/finance/routes.ts 的 overviewRoutes）：概览、单据的财务记录、月度台账、经营报表。
// 回答照服务端 server/finance/overview.ts、monthly.ts、monthly-sql.ts 写（金额都是分）；服务端返回值由 route() 的类型检查对上。
import type { financeMetricNames } from './labels.js';
import type { ApiJson } from '../core/index.js';
import type { Page, Paging } from './finance-api-shapes.js';

/** 月度台账、概览的金额类型：送货、到货、实收、实付、优惠、利息、保证金、接单（叫法在 labels.ts） */
type MonthlyMetric = keyof typeof financeMetricNames;

/** 月度台账、经营明细的筛选：哪个月，只看哪项、哪个单据月份（YYYY-MM、预收预付、没核销到单据），只看缺税率的 */
type MonthlyQuery = { period: string; metric?: MonthlyMetric; sourceMonth?: string; missingTax?: '0' | '1' };

/** 一个月里按金额类型、单据月份的合计：金额（都没价格是 null）、缺价格几条、共几条、缺税率几条 */
type MonthlySource = {
  metric: string;
  source_month: string;
  amount: number | null;
  missing: number;
  count: number;
  missing_tax: number;
};
/** 一个月里按单位到期的往来：到期额、月底前已核销、还没结的 */
type MonthlyDue = {
  kind: string;
  party_id: string;
  party_name: string;
  due: number;
  settled: number;
  outstanding: number;
};
/** 一个月的经营数：各金额类型的合计，理论、实际盈亏，没算进理论金额的（缺价格或数量）、缺税率的条数 */
export type MonthlyReport = { period: string } & { [M in MonthlyMetric]: number } & {
  theoreticalProfit: number;
  actualProfit: number;
  missingPrice: number;
  missingTax: number;
  /** 实收、实付来自哪个月的单子（金额不为 0 的） */
  sources: MonthlySource[];
  due: MonthlyDue[];
};

/**
 * 月度台账、经营明细的一行（各来源合在一起）：哪项、编号、日期、单据月份、单号、往来单位、金额（没价格或数量是 null）、
 * 明细（事件快照，或收付款、利息、保证金、凭证分录、订单几项，形状各不相同）、状态、到期日、已收付、是否缺税率
 */
type MonthlyRow = {
  metric: string;
  id: number | null;
  date: string;
  source_month: string | null;
  source_id: string | null;
  number: string | null;
  party: string | null;
  amount: number | null;
  detail: ApiJson;
  status: string;
  due_date: string | null;
  paid: number;
  missing_tax: number;
};

/** 概览的待处理数、逾期、资金账户余额（截至那天），和这个月、最近结账的会计期间 */
type FinanceSummary = {
  events: number;
  pendingApproval: number;
  overdue: { kind: string; count: number; amount: number }[];
  accounts: {
    id: number;
    name: string;
    kind: string;
    last_four: string | null;
    account_code: string;
    balance: number;
  }[];
  period: string;
  current: { period: string; status: string; version: number } | null;
  latestClosed: string | null;
};

/** 一张单据（或一张订单下的单据）的财务记录一行：财务事件，和它挂的往来、已收付、冲销关系；receipts 是收付款的 JSON 文字 */
type RelatedRow = {
  id: number;
  source_id: string;
  date: string;
  status: string;
  voucher_id: number | null;
  problem: string | null;
  amount_cents: number | null;
  obligation_id: number | null;
  obligation_amount: number | null;
  due_date: string | null;
  obligation_date: string | null;
  rerecorded: number;
  paid: number;
  reversal_state: string | null;
  receipts: string;
};

/** 月度台账一页，加上这个月的经营数和应收应付合计 */
type MonthlyLedger = Page<MonthlyRow> & {
  summary: MonthlyReport & {
    receivable: number;
    receivablePaid: number;
    receivableRemaining: number;
    payable: number;
    payablePaid: number;
    payableRemaining: number;
  };
};

export type OverviewApi = {
  'GET /finance/summary': { query?: { date?: string }; response: FinanceSummary };
  /** kind 是 orders、delivery、arrival，按先后排（sort 不起作用） */
  'GET /finance/related/:kind/:id': { query?: Paging; response: Page<RelatedRow> };
  'GET /finance/monthly-ledger': { query: MonthlyQuery & Paging; response: MonthlyLedger };
  'GET /finance/monthly-report': { query: { period: string }; response: MonthlyReport };
  'GET /finance/monthly-report/detail': { query: MonthlyQuery & Paging; response: Page<MonthlyRow> };
  /** 到 period 为止最近 months 个月（默认这个月、12 个月，最多 24 个月），从早到晚 */
  'GET /finance/monthly-report/trend': { query?: { period?: string; months?: number }; response: MonthlyReport[] };
};
