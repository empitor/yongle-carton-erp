// 归前端财务-甲。财务接口表“资金发票”一块（服务端 server/finance/routes-cash.ts 的 cashRoutes、bankRoutes、invoiceRoutes）：
// 资金账户、收付款和核销、承兑汇票、银行流水，发票、税务底稿（保证金和利息在应收应付那一块）。
// 回答照服务端代码写（行是各表整行，金额是分）；正文的规则还在服务端（各服务文件开头的 zod），这里照旧按 JSON 对象收。
import type { Body, Page, Paging } from './finance-api-shapes.js';
import type { DiscountOffer, Obligation } from './finance-api-parties.js';
import type { FinanceSettingsView } from './finance-api-settings.js';

/** 应收、应付 */
type ObligationKind = 'receivable' | 'payable';

/** 资金账户（fin_cash_accounts 整行，照 server/finance/cash-accounts.ts）：kind 是 bank、cash 等；enabled 是 0 或 1 */
type CashAccount = {
  id: number;
  name: string;
  kind: string;
  account_code: string;
  last_four: string | null;
  enabled: number;
  version: number;
};
/** 资金日报一行：期初、当天收入、支出、期末；期末是负数时 insufficient 为 1 */
type CashDailyRow = {
  id: number;
  name: string;
  kind: string;
  account_code: string;
  income: number;
  expense: number;
  opening: number;
  closing: number;
  insufficient: number;
};

/** 收付款单（fin_cash_documents 整行，照 server/finance/settlements.ts）：kind 是 receipt、payment、transfer、income、outlay 之一 */
type CashDocument = {
  id: number;
  kind: string;
  account_id: number;
  target_account_id: number | null;
  party_id: string | null;
  party_name: string | null;
  date: string;
  amount_cents: number;
  method: string;
  description: string;
  counter_account: string | null;
  cash_flow: string | null;
  voucher_id: number | null;
  status: string;
  version: number;
};
/** 一笔核销（fin_allocations 整行）：reversal_of 是撤销核销另记的那笔冲的原核销；initial 是确认收付款时就核销的（0 或 1） */
type Allocation = {
  id: number;
  cash_id: number;
  obligation_id: number;
  date: string;
  amount_cents: number;
  voucher_id: number;
  initial: number;
  reversal_of: number | null;
  status: string;
  version: number;
  discount_cents: number;
  discount_reason: string | null;
};
/** 收付款详情（照 server/finance/cash-posting.ts 的 cashDocumentView）：收付款单、它的核销和凭证 */
type CashDocumentView = CashDocument & {
  allocations: Allocation[];
  vouchers: { id: number; number: number; period: string; status: string }[];
};
/** 建议核销的一笔往来（照 server/finance/allocations.ts 的 suggest）：建议核销多少、按约定能拿的现结优惠、到期日、单据日、余额、来源单号 */
type AllocationSuggestion = {
  obligationId: number;
  version: number;
  amount: number;
  discount: number;
  offer: DiscountOffer | null;
  dueDate: string | null;
  date: string;
  description: string;
  balance: number;
  sourceNumber: string | null;
};

/** 承兑票据（fin_notes 整行，照 server/finance/notes.ts）：kind 是 receivable、payable；status 见 noteStatuses */
type Note = {
  id: number;
  number: string;
  kind: string;
  bank: string;
  party_id: string;
  party_name: string;
  date: string;
  due_date: string;
  amount_cents: number;
  status: string;
  voucher_id: number | null;
  version: number;
};
/** 票据能有的状态（server/finance/stored-values.ts 的 noteStatuses） */
type NoteStatus = 'held' | 'endorsed' | 'discounted' | 'matured' | 'returned' | 'cancelled';

/** 一笔银行流水（fin_bank_rows 整行，照 server/finance/bank.ts）：金额收入为正、支出为负；voucher_id 是匹配上的第一张凭证 */
type BankRow = {
  id: number;
  account_id: number;
  date: string;
  amount_cents: number;
  reference: string | null;
  party_name: string;
  description: string;
  fingerprint: string;
  voucher_id: number | null;
  entry_position: number | null;
  version: number;
};
/** 匹配的一行分录：哪张凭证第几行 */
type BankEntryRef = { voucherId: number; position: number };
/** 资金科目的一行已记账分录（bank.ts 的 cashEntryRow，红字按负数）：哪个资金账户、哪张收付款单、对方是谁 */
type CashEntry = {
  voucher_id: number;
  position: number;
  date: string;
  description: string;
  auxiliary_name: string | null;
  amount: number;
  account_id: number;
  cash_id: number | null;
  party_name: string;
};
/** 建议匹配的一条：金额相同的单行分录（entries 是 null），或同一张收付款单同一天几行合起来（entries 是这几行） */
type BankSuggestion =
  | (CashEntry & { entries: null })
  | {
      cash_id: number;
      date: string;
      party_name: string;
      amount: number;
      voucher_id: null;
      position: null;
      entries: BankEntryRef[];
    };
/** 余额调节表：账面、银行余额，两边各自没对上的，调节后的余额和差额 */
type BankReconcile = {
  bookBalance: number;
  bankBalance: number;
  adjustedBook: number;
  adjustedBank: number;
  difference: number;
  bankUnmatched: (BankRow & { unmatched_amount: number })[];
  bookUnmatched: CashEntry[];
};

/** 发票（fin_invoices 整行，照 server/finance/invoices.ts）：direction 是 sale、purchase；rate 是百分数文字；红票的金额是负数 */
type Invoice = {
  id: number;
  direction: string;
  type: string;
  number: string;
  date: string;
  party_id: string;
  party_name: string;
  tax_id: string;
  net: number;
  rate: string;
  tax: number;
  gross: number;
  status: string;
  original_id: number | null;
  voucher_id: number | null;
  transfer_voucher_id: number | null;
  attachment_id: number | null;
  version: number;
};
/** 发票关联的一笔往来（fin_invoice_links 整行）：本票金额、对应暂估、数量（千分位整数）和单位 */
type InvoiceLink = {
  invoice_id: number;
  obligation_id: number;
  amount_cents: number;
  estimate_cents: number | null;
  net_cents: number | null;
  quantity_units: number | null;
  unit: string | null;
};
/**
 * 发票详情（照 server/finance/invoice-rules.ts 的 invoiceDetail）：发票一行和它关联的往来
 * （加往来日期和金额、来源事件、来源单号、来源明细的 JSON 文字，数量另给文字）
 */
type InvoiceDetail = {
  invoice: Invoice;
  links: (InvoiceLink & {
    date: string;
    obligation_amount: number;
    event_id: number | null;
    source_number: string | null;
    source_lines: string | null;
    quantity: string | null;
  })[];
};
/** 应付一行的三单匹配（照 server/finance/invoice-matching.ts 的 threeWay）：采购、到货、发票各自的数量（按单位）和金额，两两的差 */
type ThreeWayMatching = {
  purchases: {
    obligation_id: number;
    id: number;
    number: string;
    line_id: number;
    quantity_units: number;
    unit: string;
    amount: number | null;
  }[];
  invoices: (InvoiceLink & { number: string; date: string; status: string })[];
  orderedQty: Record<string, number>;
  stockedQty: Record<string, number>;
  invoiceQty: Record<string, number>;
  ordered: number | null;
  arrived: number | null;
  invoiced: number | null;
  orderQuantityDiff: boolean | null;
  invoiceQuantityDiff: boolean | null;
  orderAmountDiff: number | null;
  invoiceAmountDiff: number | null;
};
/**
 * 开票对比一行（invoice-matching.ts 的 matchingRow）：往来整行，加还欠多少、已开票（没开过是 null）、来源事件快照（JSON 文字）；
 * 应付另带三单匹配
 */
type InvoiceMatchingRow = Obligation & {
  outstanding: number;
  invoiced: number | null;
  source: string | null;
  matching?: ThreeWayMatching;
};
/** 税务底稿（照 server/finance/vat.ts 的 worksheet）：增值税销项、进项、转出、留抵和应纳，附加税（缺税率是 null） */
type TaxWorksheet = {
  period: string;
  taxpayer: FinanceSettingsView['taxpayer'];
  output: number;
  input: number;
  transfer: number;
  carryIn: number;
  carryOut: number;
  payable: number | null;
  rates: FinanceSettingsView['taxRates'];
  urban: number | null;
  education: number | null;
  localEducation: number | null;
  notice: string;
};

export type CashApi = {
  /** 截至 date（默认今天）的余额；kind 只看一种账户 */
  'GET /finance/cash/accounts': { query?: { date?: string; kind?: string } & Paging; response: Page<CashAccount & { balance: number }> };
  /** date（默认今天）这一天各资金账户的收支 */
  'GET /finance/cash/daily': { query?: { date?: string } & Paging; response: Page<CashDailyRow> };
  /** 新建或改资金账户，回存好的那一行 */
  'PUT /finance/cash/accounts': { body: Body; response: CashAccount };
  /** 收付款列表：每行加已核销、未核销；accountId 转出转入都算 */
  'GET /finance/cash/documents': {
    query?: { kind?: string; accountId?: number; partyId?: string; from?: string; to?: string } & Paging;
    response: Page<CashDocument & { allocated: number; unallocated: number }>;
  };
  'GET /finance/cash/documents/:id': { response: CashDocumentView };
  /** 新建或改一笔待确认的收付款，回存好的那一行 */
  'PUT /finance/cash/documents': { body: Body; response: CashDocument };
  /** 确认（可以同时核销）：付出去的钱超过账户余额时带一句提醒 */
  'POST /finance/cash/documents/:id/confirm': { body: Body; response: CashDocumentView & { warning: string | null } };
  /** 撤销：作废了哪几张凭证、红冲出了哪几张 */
  'POST /finance/cash/documents/:id/cancel': {
    body: Body;
    response: CashDocumentView & { voidedVoucherIds: number[]; reversalVoucherIds: number[] };
  };
  'POST /finance/cash/documents/:id/allocate': { body: Body; response: CashDocumentView };
  /** 按到期先后建议核销哪几笔（date 默认收付款那天）；available 是还能核销多少，unallocated 是建议以后还剩多少（不是往来类的没有） */
  'GET /finance/cash/documents/:id/suggestions': {
    query?: { date?: string };
    response: { allocations: AllocationSuggestion[]; available: number; unallocated?: number };
  };
  /** 撤销一笔核销；多付转抵成对撤销时带上另一笔 */
  'POST /finance/allocations/:id/revoke': { body: Body; response: Allocation & { paired?: Allocation } };
  /** 票据列表：每行加还记在预收、预付里的金额和变更凭证三列；dueDays 只看 date 往后这么多天内到期、还持有的 */
  'GET /finance/notes': {
    query?: { kind?: ObligationKind; status?: NoteStatus; dueDays?: number; date?: string } & Paging;
    response: Page<
      Note & {
        unsettled_cents: number;
        change_voucher_id: number | null;
        change_voucher_status: string | null;
        change_voucher_state: string | null;
      }
    >;
  };
  'POST /finance/notes': { body: Body; response: Note };
  'POST /finance/notes/:id/status': { body: Body; response: Note };
  'POST /finance/notes/:id/allocate': { body: Body; response: Note };
  'GET /finance/bank/rows': {
    query?: { accountId?: number; from?: string; to?: string; status?: 'matched' | 'unmatched' } & Paging;
    response: Page<BankRow>;
  };
  'GET /finance/bank/rows/:id/suggestions': { response: BankSuggestion[] };
  /** 匹配凭证分录（单行给 voucherId、position，一组给 entries；voucherId 为 null 是解除匹配），回流水和匹配上的分录 */
  'PUT /finance/bank/rows/:id/match': { body: Body; response: BankRow & { entries: BankEntryRef[] } };
  /** 余额调节表：一个账户 from 到 to，bankBalance 是银行对账单余额（分） */
  'GET /finance/bank/reconcile': {
    query: { accountId: number; from: string; to: string; bankBalance: number };
    response: BankReconcile;
  };
  /** 发票列表：每行加已关联的金额 linked */
  'GET /finance/invoices': {
    query?: { direction?: 'sale' | 'purchase'; period?: string; status?: string } & Paging;
    response: Page<Invoice & { linked: number }>;
  };
  /** 开票对比：还没开完票的应收或应付 */
  'GET /finance/invoice-matching': { query: { kind: ObligationKind } & Paging; response: Page<InvoiceMatchingRow> };
  'GET /finance/invoices/:id': { response: InvoiceDetail };
  'POST /finance/invoices': { body: Body; response: Invoice };
  'PUT /finance/invoices/:id/links': { body: Body; response: InvoiceDetail };
  'POST /finance/invoices/:id/confirm': { body: Body; response: InvoiceDetail };
  'POST /finance/invoices/:id/status': { body: Body; response: Invoice };
  'GET /finance/tax': { query: { period: string }; response: TaxWorksheet };
};
