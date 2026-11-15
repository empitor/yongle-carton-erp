import { z } from 'zod';
import { call, uploadFile } from '../../ui/index';
import {
  ALL_CASH_ACCOUNTS,
  exportHref,
  finRead,
  finWritten,
  requestId,
  uploadFailure,
  uploadQuery,
  type FinanceWrites,
  type FinQuery,
} from '../fin-api';
import type { SubmitValues } from '../form-values';

/*
 * 资金发票的读写：资金账户、收付款和核销、发票、票据、银行流水。列表的读法给 FinList，详情、日报这类单次读在页面里用 useFinRead。
 * 写都带防重复的请求号，写完让财务页面重读。
 */

const send = call<FinanceWrites>();
/** 带版本号的一条记录：写入时带上版本，别人改过就被拒。 */
type Versioned = { id: number; version: number };
/** 上传不在接口表里，回答按结构校验：发票原件存好后的编号（server/finance/attachments.ts 的 save） */
const savedAttachment = z.object({ id: z.number() });
/** 银行流水导入了几笔、跳过重复几笔（server/finance/bank.ts 的 upload） */
const bankImported = z.object({ imported: z.number(), duplicates: z.number() });
/** 上传的回答对不上结构时报中文（不把英文的校验说明给人看） */
function uploadedAs<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const checked = schema.safeParse(value);
  if (!checked.success) throw new Error(what + '已上传，但读不出结果，请刷新后查看。');
  return checked.data;
}

/* ---------- 列表（FinList 按它们翻页） ---------- */

export const listCashDocuments = (query: FinQuery<'GET /finance/cash/documents'>) =>
  finRead('GET /finance/cash/documents', { query });
export const listNotes = (query: FinQuery<'GET /finance/notes'>) => finRead('GET /finance/notes', { query });
export const listBankRows = (query: FinQuery<'GET /finance/bank/rows'>) => finRead('GET /finance/bank/rows', { query });
export const listInvoices = (query: FinQuery<'GET /finance/invoices'>) => finRead('GET /finance/invoices', { query });
export const listInvoiceMatching = (query: FinQuery<'GET /finance/invoice-matching'>) =>
  finRead('GET /finance/invoice-matching', { query });

/* ---------- 资金账户 ---------- */
/** 新建（不带 id）或编辑资金账户；编辑时先取最新版本号，账户列表里的那份可能是旧的。 */
export async function saveCashAccount(values: SubmitValues, id?: number) {
  if (!id) {
    const { enabled: _enabled, ...rest } = values;
    return finWritten(send('PUT /finance/cash/accounts', { body: { ...rest, requestId: requestId() } }));
  }
  const { rows } = await finRead(...ALL_CASH_ACCOUNTS);
  const current = rows.find((a) => a.id === id);
  if (!current) throw new Error('这个资金账户已经不在了，请刷新后再试。');
  return finWritten(
    send('PUT /finance/cash/accounts', { body: { ...values, id, version: current.version, requestId: requestId() } }),
  );
}

/* ---------- 收付款 ---------- */
/** 核销一笔往来：核销多少（含优惠）、优惠多少，约定以外的优惠写原因 */
type AllocationLine = { obligationId: number; version: number; amount: number; discount: number; reason?: string };

export const saveCashDocument = (values: SubmitValues, editing?: Versioned) =>
  finWritten(
    send('PUT /finance/cash/documents', {
      body: {
        ...values,
        ...(editing ? { id: editing.id, version: editing.version } : {}),
        requestId: requestId(),
      },
    }),
  );
/** 确认收付款；往来类的可以同时核销（allocations）。 */
export const confirmCashDocument = (doc: Versioned, allocations?: AllocationLine[]) =>
  finWritten(
    send('POST /finance/cash/documents/:id/confirm', {
      params: { id: doc.id },
      body: { version: doc.version, ...(allocations ? { allocations } : {}), requestId: requestId() },
    }),
  );
export const allocateCashDocument = (doc: Versioned, body: { date: string; allocations: AllocationLine[] }) =>
  finWritten(
    send('POST /finance/cash/documents/:id/allocate', {
      params: { id: doc.id },
      body: { version: doc.version, ...body, requestId: requestId() },
    }),
  );
/** 撤销收付款：撤销日期、原因 */
export const cancelCashDocument = (doc: Versioned, body: SubmitValues) =>
  finWritten(
    send('POST /finance/cash/documents/:id/cancel', {
      params: { id: doc.id },
      body: { ...body, version: doc.version, requestId: requestId() },
    }),
  );
/** 系统按到期先后给的核销建议 */
export const readCashSuggestions = (id: number) =>
  finRead('GET /finance/cash/documents/:id/suggestions', { params: { id } });
/** 撤销核销：撤销日期、原因 */
export const revokeAllocation = (row: Versioned, body: SubmitValues) =>
  finWritten(
    send('POST /finance/allocations/:id/revoke', {
      params: { id: row.id },
      body: { ...body, version: row.version, requestId: requestId() },
    }),
  );

/* ---------- 发票 ---------- */
/** 新建发票；带了原件先上传，再把原件编号写进发票。 */
export async function saveInvoice(values: SubmitValues, file?: File) {
  const attachment = file
    ? uploadedAs(
        savedAttachment,
        await finWritten(
          uploadFile('/api/finance/attachments/upload' + uploadQuery({ filename: file.name }), file, uploadFailure(file)),
        ),
        '发票原件',
      )
    : null;
  return finWritten(
    send('POST /finance/invoices', {
      body: { ...values, ...(attachment ? { attachmentId: attachment.id } : {}), requestId: requestId() },
    }),
  );
}
export const invoiceAttachmentHref = (attachmentId: number) => exportHref('/attachments/' + attachmentId);
export const confirmInvoice = (inv: Versioned, counterAccount?: string) =>
  finWritten(
    send('POST /finance/invoices/:id/confirm', {
      params: { id: inv.id },
      body: { version: inv.version, ...(counterAccount ? { counterAccount } : {}), requestId: requestId() },
    }),
  );
/** 发票关联的全部往来（已有的原样带上，加这一条）：往来编号、本票金额、对应暂估、数量和单位 */
export const saveInvoiceLinks = (inv: Versioned, links: readonly SubmitValues[]) =>
  finWritten(
    send('PUT /finance/invoices/:id/links', {
      params: { id: inv.id },
      body: { version: inv.version, links, requestId: requestId() },
    }),
  );
/** 变更发票状态：变更为、日期、转出科目、原因 */
export const changeInvoiceStatus = (inv: Versioned, body: SubmitValues) =>
  finWritten(
    send('POST /finance/invoices/:id/status', {
      params: { id: inv.id },
      body: { ...body, version: inv.version, requestId: requestId() },
    }),
  );

/* ---------- 票据 ---------- */
export const saveNote = (values: SubmitValues) =>
  finWritten(send('POST /finance/notes', { body: { ...values, requestId: requestId() } }));
export const allocateNote = (note: Versioned, date: string) =>
  finWritten(
    send('POST /finance/notes/:id/allocate', {
      params: { id: note.id },
      body: { version: note.version, date, requestId: requestId() },
    }),
  );
/** 变更票据状态：变更为、日期、资金账户、实收、背书给谁、对方科目、原因 */
export const changeNoteStatus = (note: Versioned, body: SubmitValues) =>
  finWritten(
    send('POST /finance/notes/:id/status', {
      params: { id: note.id },
      body: { ...body, version: note.version, requestId: requestId() },
    }),
  );

/* ---------- 银行流水 ---------- */
/** 导入到哪个银行账户、文件格式、各项在第几列（JSON 文字）、第一行是不是表头 */
type BankUpload = { accountId: string; format: 'csv' | 'xlsx'; mapping: string; skipHeader: 0 | 1 };
export const uploadBankStatement = (query: BankUpload, file: File) =>
  finWritten(uploadFile('/api/finance/bank/upload' + uploadQuery(query), file, uploadFailure(file))).then((r) =>
    uploadedAs(bankImported, r, '银行流水'),
  );
export const readBankReconcile = (query: FinQuery<'GET /finance/bank/reconcile'>) =>
  finRead('GET /finance/bank/reconcile', { query });
/** 匹配凭证分录：一组分录（entries）或单行（voucherId、position）；voucherId 为 null 是解除匹配。 */
export type BankMatch =
  | { entries: readonly { voucherId: number; position: number }[] }
  | { voucherId: number | null; position?: number };
export const matchBankRow = (row: Versioned, match: BankMatch) =>
  finWritten(
    send('PUT /finance/bank/rows/:id/match', {
      params: { id: row.id },
      body: { version: row.version, ...match, requestId: requestId() },
    }),
  );
