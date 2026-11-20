// 归前端财务-乙（parties 页）。财务接口表“应收应付”一块（服务端 server/finance/routes-cash.ts 的 partyRoutes）：往来、账期、到期、账龄、对账单；
// 保证金和利息服务端注册在 cashRoutes，前端只有往来页用，也放在这一块。
// 到期提醒、现结优惠、账龄合计三种是甲在第 1 批给概览写的（照 server/finance/due.ts、parties.ts、finance-rows.ts、terms.ts）。
import type { Body, Page, Paging } from './finance-api-shapes.js';

/** 应收、应付 */
type ObligationKind = 'receivable' | 'payable';
/** 往来一行（fin_obligations 整行，金额是分）；资金发票块的开票对比也用 */
export type Obligation = {
  id: number;
  kind: string;
  party_id: string;
  party_name: string;
  date: string;
  due_date: string | null;
  amount_cents: number;
  description: string;
  event_id: number | null;
  voucher_id: number | null;
  version: number;
  tax_status: string;
  reversal_of: number | null;
  opening_id: number | null;
  terms_snapshot: string | null;
  estimate_voucher_id: number | null;
  estimate_remaining: number | null;
};
/** 到期提醒一行：一笔往来（有分期的按期拆开，installment_id 没分期是 0）还欠多少、哪天到期、还有几天（负数是已逾期） */
type DueSoonRow = {
  id: number;
  kind: string;
  party_id: string;
  party_name: string;
  date: string;
  installment_id: number;
  due_date: string;
  balance: number;
  days_to_due: number;
};
/**
 * 现结优惠：按哪条约定（比例，百分数文字）、能优惠多少（分）、最晚哪天结清；annualized 是折成年化的分数（提前 0 天是 null）。
 * 资金发票块的核销建议也用
 */
export type DiscountOffer = {
  rate: string;
  amount: number;
  deadline: string;
  annualized: { numerator: string; denominator: string } | null;
};
/** 现在结清能拿优惠的一笔：往来整行，加起算日、还没核销的余额和这次能拿的优惠 */
type DiscountRow = Obligation & { base_date: string; balance: number; offer: DiscountOffer };
/** 账龄按档的合计：第几档（没有账期的是负数）、余额、几笔 */
export type AgingTotal = { bucket: number; balance: number; count: number };
/**
 * 逐笔往来一行（照 server/finance/obligation-list.ts）：往来整行，加凭证状态、来源单据号、没有单据的是哪种（期初、利息）、
 * 已核销、坏账凭证、冲销关系（reversal 是红字冲销那笔，reversed 是被冲的原往来）、余额、离到期几天、已开票；
 * 红字冲销成对的两笔还带另一笔的编号、日期、金额、单据号、是不是重记过（pair_ 几项，不成对的没有）。
 */
type ObligationListRow = Obligation & {
  voucher_status: string | null;
  source_number: string | null;
  record_kind: 'opening' | 'interest' | null;
  allocated: number;
  bad_debt_voucher_id: number | null;
  bad_debt_voucher_status: string | null;
  bad_debt_voucher_state: string | null;
  reversal_state: 'reversal' | 'reversed' | null;
  rerecorded: number;
  pair_group: number;
  balance: number;
  days_to_due: number | null;
  invoiced: number;
  pair_id?: number;
  pair_date?: string;
  pair_amount_cents?: number;
  pair_source_number?: string | null;
  pair_rerecorded?: 0 | 1;
};

/** 账期约定（照 server/finance/terms.ts 的 termOptions，读出来已补齐默认值）：现结优惠、分期、保证金、压款利息 */
type TermOptions = {
  discounts: { type: 'month' | 'days' | 'before_due'; days: number; rate: string }[];
  installments: {
    rate: string;
    rule: { type: 'days'; days: number } | { type: 'monthly'; months: number; paymentDay: number; cutoffDay?: number };
  }[];
  deposits: boolean;
  interest: { rate: string; unit: 'annual' | 'monthly'; basis: 'overdue' | 'document'; freeDays: number } | null;
};
/** 一个单位的账期（fin_party_terms 整行；options 存的是文字） */
type PartyTermsRow = {
  kind: string;
  party_id: string;
  party_name: string;
  term_days: number;
  credit_limit: number | null;
  version: number;
  tax_rate: string | null;
  tax_mode: string | null;
  term_type: string;
  term_months: number | null;
  payment_day: number | null;
  cutoff_day: number | null;
  options: string;
};
/** 一个单位的账期，options 已解析 */
type PartyTerms = Omit<PartyTermsRow, 'options'> & { options: TermOptions };

/**
 * 按新账期重算到期日的预览（照 server/finance/due.ts 的 preview）：会改到期日的往来、分期（改前、改后、余额），
 * 按的账期，和确认时要带回去的摘要 digest。
 */
type DueRecalculation = {
  rows: { id: number; before: string | null; dueDate: string | null; version: number; balance: number }[];
  installments: {
    id: number;
    version: number;
    dueDate: string;
    before: string | null;
    obligationId: number;
    balance: number;
  }[];
  terms: PartyTermsRow;
  digest: string;
};
/** 一笔往来（有分期的按期拆开，installment_id 没分期是 0）还欠多少、哪天到期（没有账期是空） */
type DueItem = {
  id: number;
  kind: string;
  party_id: string;
  party_name: string;
  date: string;
  installment_id: number;
  due_date: string | null;
  balance: number;
};
/**
 * 收付计划（照 server/finance/due-summary.ts 的 paymentPlan）：现在的资金、已逾期一行和往后几个月的应收应付和滚出来的资金、
 * 没有账期的另列、没退回的保证金，和点一个月看的到期明细（一页）。
 */
type PaymentPlan = {
  openingCash: number;
  forecast: { period: string; receivable: number; payable: number; forecastCash: number }[];
  noTerms: { period: string | null; receivable: number; payable: number };
  deposits: { kind: string; balance: number }[];
  detail: Page<DueItem>;
};
/** 对账记录（fin_statements 整行）：已发送、已确认、有差异 */
type StatementRecord = {
  id: number;
  kind: string;
  party_id: string;
  from_date: string;
  to_date: string;
  status: string;
  discrepancy: string;
  version: number;
};
/**
 * 对账单（照 server/finance/statements.ts）：期初、期末、期末还没抵货款的预收（预付）、各行发生额和对账记录。
 * 一行的 red 是红字冲销那行、reversed 是已被冲销的原来那行、rerecorded 是更正后重记的那行（都是 0 或 1）。
 */
type Statement = {
  opening: number;
  closing: number;
  advance: number;
  items: {
    voucher_id: number | null;
    date: string;
    number: number | null;
    description: string;
    position: number;
    due_date: string | null;
    delta: number;
    red: number;
    reversed: number;
    rerecorded: number;
    days_to_due: number | null;
  }[];
  state: StatementRecord | null;
};
/** 一段时间、一个单位的对账单（页面上日期框清空时不带那一项，服务端报“请填写明确日期”） */
type StatementQuery = { kind: ObligationKind; partyId: string; from?: string; to?: string };

/** 按单位的应收应付一行（照 server/finance/due-summary.ts 的 heldByParty）：还没到期、已到期、没有账期、预收、还欠，账期几列、超授信、已送货未开票 */
type HeldRow = {
  party_id: string;
  party_name: string | null;
  held: number;
  due: number;
  no_terms: number;
  earliest_due: string | null;
  advance: number;
  net: number;
  term_type: string | null;
  term_days: number | null;
  term_months: number | null;
  payment_day: number | null;
  cutoff_day: number | null;
  credit_limit: number | null;
  over_limit: number;
  uninvoiced: number;
};
/** 账龄逐笔一行（照 server/finance/parties.ts 的 aging）：往来加截至那天的余额、红字冲销待记账、账龄天数、离到期几天、分到哪一档 */
type AgingRow = Obligation & {
  balance: number;
  reversal_pending: number;
  days: number;
  days_to_due: number | null;
  bucket: number;
};
/** 保证金的一次退回或转抵（照 server/finance/deposits-interest.ts，各带自己的凭证三列） */
type DepositActionItem = {
  id: number;
  kind: 'refund' | 'apply';
  date: string;
  amount_cents: number;
  obligation_id: number | null;
  voucher_id: number;
  voucher_status: string;
  voucher_state: string | null;
};
/** 保证金一行：fin_deposits 整行加余额、凭证状态和退回转抵记录 */
type DepositRow = {
  id: number;
  kind: string;
  party_kind: string;
  party_id: string;
  party_name: string;
  date: string;
  amount_cents: number;
  description: string;
  voucher_id: number | null;
  version: number;
  balance: number;
  voucher_status: string | null;
  voucher_state: string | null;
  actions: DepositActionItem[];
};
/** 压款利息的建议（照 server/finance/terms.ts 的 overdueInterest）：从哪天之后算到哪天、几天、按什么利率，多少钱 */
type InterestEstimate = {
  amount: number;
  begins: string;
  from: string;
  asOf: string;
  days: number;
  balance: number;
  rate: string;
  unit: 'annual' | 'monthly';
  basis: 'overdue' | 'document';
};
/** 计息列表一行：还欠着的往来，加上次确认算到哪天、这个月确认过的、最后一次核销日期和这次的建议（缺到期日时没有） */
type InterestRow = Obligation & {
  base_date: string;
  balance: number;
  confirmed_through: string | null;
  interest_id: number | null;
  confirmed: number;
  last_paid: string | null;
  estimate: InterestEstimate | null;
};

export type PartiesApi = {
  /** 选客户、供应商用的单位名单（没归档的，编号和名称）：财务自己的地址，出纳这类纯财务账号也能读 */
  'GET /finance/parties': { query: { kind: 'customer' | 'supplier' }; response: { id: number; name: string }[] };
  /** 一种往来（应收或应付）的逐笔列表，可只看一个单位；红字冲销的两笔排在一起 */
  'GET /finance/obligations': {
    query: { kind: ObligationKind; partyId?: string; page?: number; pageSize?: number };
    response: Page<ObligationListRow>;
  };
  /** 手工新建一笔应收或应付，回新建的那笔 */
  'POST /finance/obligations': { body: Body; response: Obligation };
  /** 坏账处理，回坏账记录（fin_bad_debts 一行） */
  'POST /finance/obligations/:id/bad-debt': {
    body: Body;
    response: { id: number; obligation_id: number; kind: string; date: string; amount_cents: number; reason: string; voucher_id: number };
  };
  /** 多付转抵：转了多少，按收付款单拆开的几笔（各自的对冲凭证） */
  'POST /finance/obligations/transfer-credit': {
    body: Body;
    response: { amount: number; parts: { cashId: number; amount: number; voucherId: number }[] };
  };
  /** 账期列表（客户或供应商），每行带这个单位已记账的应收余额 receivable */
  'GET /finance/party-terms': {
    query?: { kind?: 'customer' | 'supplier'; partyId?: string } & Paging;
    response: Page<PartyTerms & { receivable: number }>;
  };
  /** 一个单位的账期，没设过是 null */
  'GET /finance/party-terms/:kind/:id': { response: PartyTerms | null };
  'PUT /finance/party-terms/:kind/:id': { body: Body; response: PartyTerms | null };
  /** 账龄逐笔（只算已记账的），加分档的天数 bands 和每档的合计 totals；overdue=1 只看逾期，basis 按单据日或到期日算 */
  'GET /finance/aging': {
    query: { kind: ObligationKind; date?: string; overdue?: '1' | '0'; basis?: 'document' | 'due' } & Paging;
    response: Page<AgingRow> & { bands: number[]; totals: AgingTotal[] };
  };
  /** 改一笔往来的到期日，回改过的那一行 */
  'PUT /finance/obligations/:id/due': { body: Body; response: Obligation };
  /** 按新账期重算到期日：先预览 */
  'GET /finance/due-recalculation': { query: { kind: ObligationKind; partyId: string }; response: DueRecalculation };
  /** 按预览确认重算（带回预览的 digest，预览以后数据变了回 409 preview-changed）：改了几笔往来、几期分期 */
  'POST /finance/due-recalculation': { body: Body; response: { updated: number; updatedInstallments: number } };
  /** 按单位的应收应付（一页）和全部单位的合计 */
  'GET /finance/held': {
    query: { kind: ObligationKind; date?: string; partyId?: string } & Paging;
    response: Page<HeldRow> & {
      totals: { held: number; due: number; no_terms: number; advance: number; uninvoiced: number; net: number };
    };
  };
  /** 截至 date（默认今天）往后 months 个月（默认 6）；dueMonth 是看哪个月（或 overdue）的到期明细 */
  'GET /finance/payment-plan': {
    query?: { date?: string; months?: number; dueMonth?: string; partyId?: string } & Paging;
    response: PaymentPlan;
  };
  /** 截至 date（默认今天）往后 days 天（默认 7 天）内到期、还欠着的，按到期日排 */
  'GET /finance/due-soon': { query?: { date?: string; days?: number } & Paging; response: Page<DueSoonRow> };
  /** 截至 date（默认今天）还欠着、现在结清能拿优惠的（不收 sort，按日期、编号排） */
  'GET /finance/discount-opportunities': {
    query?: { date?: string; kind?: ObligationKind; page?: number; pageSize?: number };
    response: Page<DiscountRow>;
  };
  'GET /finance/statements': { query: StatementQuery; response: Statement };
  /** 标记对账状态，回对账记录 */
  'PUT /finance/statements': { body: Body; response: StatementRecord };
  /** 保证金列表：kind 只看付出（paid）或收到（received），partyId 只看一个单位 */
  'GET /finance/deposits': { query?: { kind?: 'paid' | 'received'; partyId?: number } & Paging; response: Page<DepositRow> };
  /** 新建保证金，回 fin_deposits 一行 */
  'POST /finance/deposits': { body: Body; response: Omit<DepositRow, 'balance' | 'voucher_status' | 'voucher_state' | 'actions'> };
  /** 退回或转抵，回这次的记录（fin_deposit_actions 一行） */
  'POST /finance/deposits/:id/actions': {
    body: Body;
    response: { id: number; deposit_id: number; kind: string; date: string; amount_cents: number; obligation_id: number | null; voucher_id: number | null };
  };
  /** 一个月要计息的往来和这次的建议；asOf 是算到哪天（看的那天和月底取早的） */
  'GET /finance/interest': {
    query: { period: string; kind: ObligationKind; date?: string } & Paging;
    response: Page<InterestRow> & { asOf: string };
  };
  /** 确认一次利息，回 fin_interest 一行 */
  'POST /finance/interest/confirm': {
    body: Body;
    response: { id: number; obligation_id: number; period: string; date: string; amount_cents: number; reason: string; voucher_id: number | null; version: number };
  };
};
