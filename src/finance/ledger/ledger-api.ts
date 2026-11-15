import { call } from '../../ui/index';
import type { VoucherTransition } from '../../../shared/finance/index';
import { finRead, finWritten, requestId, type FinanceWrites, type FinQuery } from '../fin-api';
import type { SubmitValues } from '../form-values';

/*
 * 凭证账簿的读写：凭证、业务单据（生成凭证、红字冲销、核对无误）、账簿、修改记录、记账模板，和来源页面生成的凭证撤回、红冲。
 * 报表页的期初变动也用“核对无误”。写都带防重复的请求号，写完让财务页面重读。
 */

const send = call<FinanceWrites>();
/** 带版本号的一条记录：写入时带上版本，别人改过就被拒。 */
type Versioned = { id: number; version: number };

/* ---------- 列表（FinList 按它们翻页） ---------- */

export const listVouchers = (query: FinQuery<'GET /finance/vouchers'>) => finRead('GET /finance/vouchers', { query });
export const listEvents = (query: FinQuery<'GET /finance/events'>) => finRead('GET /finance/events', { query });
export const listAudit = (query: FinQuery<'GET /finance/audit'>) => finRead('GET /finance/audit', { query });
/** 一页账簿；kind 是哪种账簿（地址里的那一段），行是汇总行或分录行 */
export async function listBook({ kind, ...query }: FinQuery<'GET /finance/books/:kind'> & { kind: string }) {
  const page = await finRead('GET /finance/books/:kind', { params: { kind }, query });
  // 两种账簿各自只有一种行，合成一个列表给表格（列按账簿种类选）
  const rows: (typeof page.rows)[number][] = page.rows;
  return { ...page, rows };
}

/* ---------- 业务单据 ---------- */

export const generateEventVoucher = (row: Versioned) =>
  finWritten(
    send('POST /finance/events/:id/generate', {
      params: { id: row.id },
      body: { version: row.version, requestId: requestId() },
    }),
  );
/** 红字冲销（并重做）：更正日期、原因 */
export const correctEvent = (row: Versioned, body: SubmitValues) =>
  finWritten(
    send('POST /finance/events/:id/correct', {
      params: { id: row.id },
      body: { ...body, version: row.version, requestId: requestId() },
    }),
  );
/** 核对无误：说明 */
export const acknowledgeEvent = (row: Versioned, body: SubmitValues) =>
  finWritten(
    send('POST /finance/events/:id/acknowledge', {
      params: { id: row.id },
      body: { ...body, version: row.version, requestId: requestId() },
    }),
  );

/* ---------- 凭证 ---------- */

/** 凭证的内容：日期、摘要、附件张数、分录 */
type VoucherBody = Omit<FinanceWrites['POST /finance/vouchers']['body'], 'requestId'>;
/** 新建凭证，或改一张未记账的凭证（带上它的表头）。 */
export const saveVoucher = (body: VoucherBody, header?: Versioned) =>
  finWritten(
    header
      ? send('PUT /finance/vouchers/:id', {
          params: { id: header.id },
          body: { ...body, version: header.version, requestId: requestId() },
        })
      : send('POST /finance/vouchers', { body: { ...body, requestId: requestId() } }),
  );
/** 凭证往前推一步（submit、approve、post），或作废（void） */
export const voucherStep = (voucher: Versioned, step: VoucherTransition) =>
  finWritten(
    send(`POST /finance/vouchers/:id/${step}`, {
      params: { id: voucher.id },
      body: { version: voucher.version, requestId: requestId() },
    }),
  );
/** 红字冲销：冲销日期、摘要 */
export const reverseVoucher = (voucher: Versioned, body: { date: string; description: string }) =>
  finWritten(
    send('POST /finance/vouchers/:id/reverse', {
      params: { id: voucher.id },
      body: { ...body, version: voucher.version, requestId: requestId() },
    }),
  );

/* ---------- 记账模板 ---------- */

export const saveTemplate = (body: { name: string; mapping: Record<string, string>; version: number }) =>
  finWritten(send('PUT /finance/templates', { body: { ...body, requestId: requestId() } }));

/** 撤回（withdraw）、红冲（reverse）来源页面生成的凭证只走这一个提交：服务端按凭证的来源决定能不能撤、撤了以后来源怎么回去。 */
export const sendSourceVoucher = (voucher: Versioned, kind: 'withdraw' | 'reverse', body: SubmitValues) =>
  finWritten(
    send(`POST /finance/source-vouchers/:id/${kind}`, {
      params: { id: voucher.id },
      body: { ...body, version: voucher.version, requestId: requestId() },
    }),
  );
