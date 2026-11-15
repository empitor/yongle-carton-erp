import { call, textField } from '../../ui/index';
import { MAX_PAGE_SIZE, PREVIEW_CHANGED_CODE } from '../../../shared/core/index';
import { finRead, finWritten, requestId, type FinData, type FinanceWrites, type FinRequest } from '../fin-api';
import type { SubmitValues } from '../form-values';
import type { Kind } from './shared';
import type { TermsBody } from './terms-form';

/*
 * 应收应付的请求：往来单、到期日、坏账、多付转抵、保证金、压款利息、对账单、账期，几个列表一页一页的读法（给 FinList）。
 * 只读一次、跟着条件变的（到期提醒、收付计划、对账单）页面用 useFinRead 直接读。
 */

/** 应收应付页的写入（一个写地址只由这个文件发） */
const send = call<FinanceWrites>();
/** 带版本号的一条记录：写入时带上版本，别人改过就被拒。 */
type Versioned = { id: number; version: number };
/** FinList 往查询参数里补的翻页 */
type PageQuery = { page: number; pageSize: number };
/** 页面填的内容（通用表单窗口交上来的，规则在服务端校验） */
type Values = SubmitValues;

/** 欠款明细逐笔的一行 */
export type ObligationRow = FinData<'GET /finance/obligations'>['rows'][number];
/** 按新账期重算到期日的预览（确认时带回 digest） */
export type DuePreview = FinData<'GET /finance/due-recalculation'>;

/** 一次取完的列表（一个单位的往来单、保证金）：按服务端一页最多的条数读 */
const ALL_AT_ONCE = MAX_PAGE_SIZE;
/** 读一个单位的全部往来单（选往来单、多付转抵选被抵的那笔），给 useFinRead；没给单位时读全部单位的第一页 */
export const partyObligations = (kind: Kind, partyId?: string): FinRequest<'GET /finance/obligations'> => [
  'GET /finance/obligations',
  { query: { kind, partyId, pageSize: ALL_AT_ONCE } },
];

/* ---------- 列表（FinList 的 list） ---------- */
export const listObligations = (query: { kind: Kind; partyId?: string } & PageQuery) =>
  finRead('GET /finance/obligations', { query });
export const listDiscountOpportunities = (query: { kind: Kind } & PageQuery) =>
  finRead('GET /finance/discount-opportunities', { query });
export const listPartyTerms = (query: { kind: 'customer' | 'supplier' } & PageQuery) =>
  finRead('GET /finance/party-terms', { query });
/** 按单位的应收应付（带全部单位的合计） */
export const listHeld = (query: { kind: Kind; date?: string } & PageQuery) => finRead('GET /finance/held', { query });
/** 账龄逐笔（带分档天数和每档合计） */
export const listAging = (query: { kind: Kind; basis: 'document' | 'due'; overdue?: '1' } & PageQuery) =>
  finRead('GET /finance/aging', { query });
/** 一个月要计息的往来和建议 */
export const listInterest = (query: { period: string; kind: Kind } & PageQuery) =>
  finRead('GET /finance/interest', { query });
/** 保证金一次全取（服务端一页最多 200 条） */
export const allDeposits: FinRequest<'GET /finance/deposits'> = [
  'GET /finance/deposits',
  { query: { pageSize: ALL_AT_ONCE } },
];
/** 保证金一行（带退回、转抵记录） */
export type DepositRow = FinData<'GET /finance/deposits'>['rows'][number];
/** 计息列表一行 */
export type InterestRow = FinData<'GET /finance/interest'>['rows'][number];

/* ---------- 欠款明细 ---------- */
/** 手工新建一笔应收或应付 */
export const createObligation = (kind: Kind, values: Values) =>
  finWritten(send('POST /finance/obligations', { body: { requestId: requestId(), ...values, kind } }));
export const changeDueDate = (row: Versioned, values: Values) =>
  finWritten(send('PUT /finance/obligations/:id/due', {
    params: { id: row.id },
    body: { requestId: requestId(), ...values, version: row.version },
  }));
export const writeOffBadDebt = (row: Versioned, values: Values) =>
  finWritten(send('POST /finance/obligations/:id/bad-debt', {
    params: { id: row.id },
    body: { requestId: requestId(), ...values, version: row.version },
  }));
export const transferCredit = (body: { date: string; amount: number; from: Versioned; to: Versioned }) =>
  finWritten(send('POST /finance/obligations/transfer-credit', { body: { requestId: requestId(), ...body } }));

/* ---------- 按新账期重算到期日 ---------- */
/** 先看会改哪些（带回 digest）；确认时把 digest 带回去，预览以后数据变了就被拒 */
export const previewDueRecalculation = (kind: Kind, partyId: string) =>
  finRead('GET /finance/due-recalculation', { query: { kind, partyId } });
/** 预览以后往来或账期变了：窗口已换成最新的预览，请人核对后再确认 */
export const recalcChangedMessage = '预览以后往来或账期有变化，上面已经换成最新的重算结果，请核对后再确认。';
/**
 * 按预览确认重算。预览以后往来或账期被别人改了（服务端类别 preview-changed）：读回最新的预览交给 reloaded
 * （窗口换成最新的），再报 recalcChangedMessage，人看过再确认；别的拒绝照服务端的原话报。和单据核对窗同一个做法。
 */
export async function applyDueRecalculation(
  body: { kind: Kind; partyId: string; digest: string; reason: string },
  reloaded: (next: DuePreview) => void,
) {
  try {
    return await finWritten(send('POST /finance/due-recalculation', { body: { requestId: requestId(), ...body } }));
  } catch (e) {
    if (textField(e, 'code') !== PREVIEW_CHANGED_CODE) throw e;
    reloaded(await previewDueRecalculation(body.kind, body.partyId));
    throw new Error(recalcChangedMessage);
  }
}

/* ---------- 保证金、压款利息 ---------- */
export const saveDeposit = (values: Values) =>
  finWritten(send('POST /finance/deposits', { body: { requestId: requestId(), ...values } }));
/** 退回（refund）或转抵货款（apply） */
export const depositAction = (deposit: Versioned, kind: 'refund' | 'apply', values: Values) =>
  finWritten(send('POST /finance/deposits/:id/actions', {
    params: { id: deposit.id },
    body: { requestId: requestId(), ...values, kind, version: deposit.version },
  }));
export const confirmInterest = (period: string, row: Versioned, values: Values) =>
  finWritten(send('POST /finance/interest/confirm', {
    body: { requestId: requestId(), ...values, period, obligationId: row.id, version: row.version },
  }));

/* ---------- 对账单、账期 ---------- */
export const markStatement = (body: {
  kind: Kind;
  partyId: string;
  from: string;
  to: string;
  status: string;
  discrepancy: string;
  version?: number;
}) => finWritten(send('PUT /finance/statements', { body: { requestId: requestId(), ...body } }));
export const readPartyTerms = (kind: 'customer' | 'supplier', partyId: string) =>
  finRead('GET /finance/party-terms/:kind/:id', { params: { kind, id: partyId } });
export const savePartyTerms = (kind: 'customer' | 'supplier', partyId: string, body: TermsBody & { version?: number }) =>
  finWritten(send('PUT /finance/party-terms/:kind/:id', {
    params: { kind, id: partyId },
    body: { requestId: requestId(), ...body },
  }));
