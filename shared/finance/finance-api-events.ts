// 归前端财务-甲。财务接口表“业务单据进财务”一块（服务端 server/finance/routes.ts 的 eventRoutes）：补扫、待处理、补税率、生成凭证、红冲重做、核对。
// 补税率、生成凭证、红冲重做、核对的正文规则还在服务端（server/finance/event-handling.ts、event-voucher.ts），先按 JSON 对象收。
import type { z } from 'zod';
import type { pagingSchema } from '../core/index.js';
import type { Body, Data, Page } from './finance-api-shapes.js';

/** 财务事件一行（fin_events 整行，照 server/finance/event-shared.ts 的 readEvent）：snapshot 是存库的 JSON 文字 */
type FinanceEventRow = {
  id: number;
  source_kind: string;
  source_id: string;
  event_type: string;
  source_version: number;
  source_hash: string;
  date: string;
  amount_cents: number | null;
  status: string;
  voucher_id: number | null;
  problem: string | null;
  version: number;
  revenue_recognition: string | null;
  snapshot: string;
};
/**
 * 一条财务事件的详情（照 server/finance/event-views.ts 的 get）：事件整行，快照解析好（来源单据内容、金额、缺什么，
 * 结构见 server/finance/source-snapshot.ts，这里先按 JSON 对象），被它接手的上一条，和上一条比改了什么
 */
type FinanceEventDetail = Omit<FinanceEventRow, 'snapshot'> & {
  snapshot: Data;
  previous: FinanceEventRow | null;
  changes: { label: string; before: string; after: string }[];
};

/**
 * 业务单据列表一行（照 server/finance/event-views.ts 的 list）：事件几列和单号；红冲状态（被冲的原单据 reversed、做红冲的那条 reversal）；
 * 红冲后会不会重做（rebuild）、单据已删时能不能保留凭证（keepable），都是 0 或 1；原来那张凭证；所在月份已结账时生成凭证记到哪天；
 * 已撤销、被更正替代的到货和更正出来的替代单红字冲销默认记哪天（correction_date，别的是 null）
 */
type EventListRow = {
  id: number;
  source_kind: string;
  source_id: string;
  event_type: string;
  date: string;
  amount_cents: number | null;
  status: string;
  voucher_id: number | null;
  problem: string | null;
  version: number;
  number: string | null;
  reversal_state: 'reversed' | 'reversal' | null;
  rebuild: number;
  keepable: number;
  previous_voucher_id: number | null;
  booking_date: string | null;
  correction_date: string | null;
};

export type EventsApi = {
  /** 补扫一批业务单据（照 server/finance/events.ts 的 sync）：这次处理了几张、还有没扫完的 */
  'POST /finance/events/sync': { body: Body; response: { processed: number; remaining: boolean } };
  /** 记账前要处理的业务单据，可按状态筛；同一张单据的几条排在一起 */
  'GET /finance/events': { query?: { status?: string } & z.input<typeof pagingSchema>; response: Page<EventListRow> };
  'GET /finance/events/:id': { response: FinanceEventDetail };
  /** 单张补税率（缺价格或数量时连金额），回补完的事件 */
  'POST /finance/events/:id/resolve': { body: Body; response: FinanceEventRow };
  /** 按记账模板生成待记账凭证，回生成后的事件 */
  'POST /finance/events/:id/generate': { body: Body; response: FinanceEventRow };
  /** 红字冲销（单据还有效的接着按现在的内容重做），回处理后的事件和处理了什么 */
  'POST /finance/events/:id/correct': { body: Body; response: FinanceEventRow & { handled: string } };
  /** 核对无误（盘点调整，或单据已删时保留原凭证），回核对后的事件 */
  'POST /finance/events/:id/acknowledge': { body: Body; response: FinanceEventRow };
  /** 勾选的几张，或某个单位一个月待补的，一起补税率；回补完的每一条事件 */
  'POST /finance/tax-completion/batch': { body: Body; response: FinanceEventRow[] };
};
