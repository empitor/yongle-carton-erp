import { call } from '../../ui/index';
import { finRead, finWritten, requestId, type FinanceWrites, type FinRequest } from '../fin-api';

/* 月度台账的读（一页明细）和补税率的写入：单张补、选中几张一起补、按单位补一个月。都先取单据最新的版本号。 */

const send = call<FinanceWrites>();

type LedgerQuery = FinRequest<'GET /finance/monthly-ledger'>[1]['query'];
/** 月度台账的一页（FinList 按它翻页），带这个月的合计 */
export const listMonthlyLedger = (query: LedgerQuery) => finRead('GET /finance/monthly-ledger', { query });

/** 补税率要带这张单据现在的版本号（台账的一行里没有） */
const eventVersion = async (id: number) => (await finRead('GET /finance/events/:id', { params: { id } })).version;

/** 补税率的一行：金额（缺价格或数量时填）、税率（百分数，不带 %）、含税口径 */
export type ResolveLine = { exact: string; rate: string; mode: string };
/** 几张一起补时怎么补：填税率和口径，或无税、不开票，或用往来单位的默认税率；依据选填 */
export type TaxHow = { rate?: string; mode?: string; noTax?: boolean; usePartyDefault?: boolean; evidence?: string };

/** 单张补税率：逐行的税率、口径（缺价格时连金额） */
export const resolveEventTax = async (id: number, body: { evidence?: string; lines: ResolveLine[] }) => {
  const version = await eventVersion(id);
  return finWritten(
    send('POST /finance/events/:id/resolve', { params: { id }, body: { ...body, version, requestId: requestId() } }),
  );
};

/** 几张一起补 */
export const completeTaxForEvents = async (ids: number[], how: TaxHow) => {
  const items = await Promise.all(ids.map(async (id) => ({ id, version: await eventVersion(id) })));
  return finWritten(send('POST /finance/tax-completion/batch', { body: { items, ...how, requestId: requestId() } }));
};
/** 按单位补一个月所有待补的 */
export const completeTaxForParty = (
  body: { kind: 'customer' | 'supplier'; partyId: string; period: string },
  how: TaxHow,
) => finWritten(send('POST /finance/tax-completion/batch', { body: { ...body, ...how, requestId: requestId() } }));
