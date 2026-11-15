// 归前端财务-甲。财务接口表“凭证账簿”一块（服务端 server/finance/routes.ts 的 ledgerRoutes）：凭证、来源页面生成的凭证、账簿、修改记录。
import type { z } from 'zod';
import type { ApiJson, pagingSchema } from '../core/index.js';
import type {
  auxiliaryKinds,
  voucherChangeSchema,
  voucherEditSchema,
  voucherReversalSchema,
  voucherSchema,
  VoucherTransition,
} from './finance.js';
import type { Body, Page } from './finance-api-shapes.js';

/** 按 server/core/paging.ts 分页的列表：第几页（不给回全部）、每页几条、排序 */
type CorePaging = z.input<typeof pagingSchema>;

/** 凭证头（fin_vouchers 整行，照 server/finance/voucher-read.ts）：状态是 draft、pending、approved、posted、void 之一 */
type VoucherHeader = {
  id: number;
  number: number;
  date: string;
  period: string;
  description: string;
  attachment_count: number;
  event_id: number | null;
  reversal_of: number | null;
  status: string;
  maker_id: string;
  maker_name: string;
  approver_id: string | null;
  approver_name: string | null;
  approved_at: string | null;
  poster_id: string | null;
  poster_name: string | null;
  posted_at: string | null;
  created_at: string;
  version: number;
  module_source: string | null;
  module_id: number | null;
};
/** 一条分录（fin_entries 整行，金额是分） */
type VoucherEntry = {
  voucher_id: number;
  position: number;
  account_code: string;
  description: string;
  debit: number;
  credit: number;
  auxiliary_kind: (typeof auxiliaryKinds)[number] | null;
  auxiliary_id: string | null;
  auxiliary_name: string | null;
  cash_flow: string | null;
};
/** 凭证的来源单据：财务事件的种类、编号、事件类型、状态和单号 */
type VoucherSourceEvent = {
  id: number;
  source_kind: string;
  source_id: string;
  event_type: string;
  status: string;
  number: string | null;
};
/** 凭证头和分录（照 voucher-read.ts 的 voucherRecordSchema）：新建、改、推进一步、作废、红冲的结果；费用块的员工借款也回它 */
export type VoucherRecord = { header: VoucherHeader; entries: VoucherEntry[] };
/** 明细账、序时账、日记账一行（照 server/finance/books.ts 的 detailRow）：一条分录，红字凭证的金额取负 */
type BookEntryRow = {
  voucher_id: number;
  date: string;
  period: string;
  number: number;
  reversal_of: number | null;
  position: number;
  account_code: string;
  account_name: string;
  description: string;
  auxiliary_kind: string | null;
  auxiliary_id: string | null;
  auxiliary_name: string | null;
  cash_flow: string | null;
  debit: number;
  credit: number;
};
/** 总账、科目余额表、辅助明细账一行（books.ts 的 balanceRow）：一个科目（按辅助项分开时一个辅助项）期初、本期、本年、期末 */
export type BookBalanceRow = {
  account_code: string;
  account_name: string;
  auxiliary_kind: string | null;
  auxiliary_id: string | null;
  auxiliary_name: string | null;
  opening: number;
  debit: number;
  credit: number;
  year_debit: number;
  year_credit: number;
  ending: number;
};
/** 一页账簿：总账、科目余额表、辅助明细账是汇总行，别的是分录行；带期间和谁在看 */
type BookPage<Row> = Page<Row> & { period: string; viewer: string };
/** 一条修改记录（business_audit 一行，照 server/finance/audit-log.ts）：document 是操作自己记的改前改后 */
type AuditRow = {
  id: number;
  at: string;
  actor_id: string;
  actor_name: string;
  source: string;
  action: string;
  entity: string;
  record_id: number | null;
  document: ApiJson;
};
/** 凭证详情（照 voucher-read.ts 的 voucherDetail）：凭证头和分录，它冲的那张、冲掉它的那张（没作废的），来源单据或来源功能的那笔记录 */
type VoucherDetail = {
  header: VoucherHeader;
  entries: VoucherEntry[];
  original: { id: number; period: string; number: number } | null;
  reversedBy: { id: number; period: string; number: number; status: string } | null;
  source:
    | VoucherSourceEvent
    | {
        module: string;
        id: number | null;
        event: VoucherSourceEvent | null;
        record: { kind: string | null; date: string; amount: number } | null;
      }
    | null;
};

export type LedgerApi = {
  /** 凭证列表（凭证头），可按期间、状态筛 */
  'GET /finance/vouchers': { query?: { period?: string; status?: string } & CorePaging; response: Page<VoucherHeader> };
  'POST /finance/vouchers': { body: z.input<typeof voucherSchema>; response: VoucherRecord };
  'GET /finance/vouchers/:id': { response: VoucherDetail };
  'PUT /finance/vouchers/:id': { body: z.input<typeof voucherEditSchema>; response: VoucherRecord };
  'POST /finance/vouchers/:id/reverse': { body: z.input<typeof voucherReversalSchema>; response: VoucherRecord };
  /** 来源页面生成的凭证撤回、红冲（正文规则在 server/finance/derived-vouchers.ts）：回原凭证的凭证头 */
  'POST /finance/source-vouchers/:id/withdraw': { body: Body; response: VoucherHeader };
  'POST /finance/source-vouchers/:id/reverse': { body: Body; response: VoucherHeader };
  /** kind 是 general、balance、auxiliary（汇总行）或 detail、journal、cash、bank（分录行）；account 只看一个科目 */
  'GET /finance/books/:kind': {
    query: { period: string; account?: string; auxiliaryKind?: string; auxiliaryId?: string } & CorePaging;
    response: BookPage<BookBalanceRow> | BookPage<BookEntryRow>;
  };
  /** 财务的修改记录，按北京时间的日期筛 */
  'GET /finance/audit': {
    query?: { actorId?: string; from?: string; to?: string; entity?: string; recordId?: number } & CorePaging;
    response: Page<AuditRow>;
  };
} & {
  [A in VoucherTransition as `POST /finance/vouchers/:id/${A}`]: {
    body: z.input<typeof voucherChangeSchema>;
    response: VoucherRecord;
  };
};
