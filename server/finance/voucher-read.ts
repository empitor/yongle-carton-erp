/** 凭证的读：凭证和分录、凭证详情（来源单据、红冲关系、来源记录的叫法）、凭证列表、分录转回输入格式。 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { auxiliaryKinds, periodSchema, type FinanceEntry } from '../../shared/finance/index.js';
import { clampPage, count, many, one, parsePaging, rows } from '../core/index.js';
import { financeError } from './core.js';
import { snapshotNumber } from './source-snapshot.js';
import { voucherStatuses } from './stored-values.js';

const statusSchema = z.enum(voucherStatuses);
/** 凭证头一行（状态收窄成存进库的那几种） */
const voucherHeader = rows.fin_vouchers.extend({ status: statusSchema });
/** 分录一行（辅助项种类收窄成科目辅助项那几种） */
const voucherLine = rows.fin_entries.extend({ auxiliary_kind: z.enum(auxiliaryKinds).nullable() });
/** 凭证头和分录：读凭证、各处生成凭证的写入结果都是它 */
export const voucherRecordSchema = z.object({ header: voucherHeader, entries: z.array(voucherLine) });
export type VoucherRecord = z.output<typeof voucherRecordSchema>;

/** 凭证头和分录 */
export function voucherRecord(db: DatabaseSync, id: number): VoucherRecord {
  const header = one(db, voucherHeader, 'SELECT * FROM fin_vouchers WHERE id=?', id);
  if (!header) financeError('凭证不存在。', 404);
  const entries = many(db, voucherLine, 'SELECT * FROM fin_entries WHERE voucher_id=? ORDER BY position', id);
  return { header, entries };
}

/** 凭证来源里没有单号的记录：种类（收付款类型、保证金的哪一笔；利息没有）、日期、金额（分） */
const moduleRecordRow = z.object({ kind: z.string().nullable(), date: z.string(), amount: z.number() });

/**
 * 凭证“来源”里没有单号的记录（收付款、保证金、压款利息）：界面写“收客户款 11-12 100.00”，不露内部编号。
 * 保证金的退回、转抵凭证也挂在保证金上（module_id 是保证金），按凭证找到那次退回、转抵，取它自己的日期和金额，
 * kind 写 deposit_refund、deposit_apply（叫法见 financeRecordNames）；保证金本身那张 kind 写 deposit。
 * 收付款的 kind 是收付款类型。
 */
function moduleRecord(db: DatabaseSync, module: string, moduleId: number | null, voucherId: number) {
  if (moduleId == null) return null;
  if (module === 'deposit') {
    const action = one(
      db,
      moduleRecordRow,
      `SELECT CASE WHEN kind='refund' THEN 'deposit_refund' ELSE 'deposit_apply' END AS kind,date,amount_cents AS amount
        FROM fin_deposit_actions WHERE deposit_id=? AND voucher_id=?`,
      moduleId,
      voucherId,
    );
    if (action) return action;
    return one(db, moduleRecordRow, "SELECT 'deposit' AS kind,date,amount_cents AS amount FROM fin_deposits WHERE id=?", moduleId) ?? null;
  }
  const sql =
    module === 'cash'
      ? 'SELECT kind,date,amount_cents AS amount FROM fin_cash_documents WHERE id=?'
      : module === 'interest'
        ? 'SELECT NULL AS kind,date,amount_cents AS amount FROM fin_interest WHERE id=?'
        : null;
  return sql ? (one(db, moduleRecordRow, sql, moduleId) ?? null) : null;
}

/** 凭证的来源事件：种类、编号、事件类型、状态和单号 */
const sourceEvent = rows.fin_events
  .pick({ id: true, source_kind: true, source_id: true, event_type: true, status: true })
  .extend({ number: z.string().nullable() });
/** 冲销关系里指到的凭证：期间、号；冲掉它的那张还带状态 */
const voucherRef = rows.fin_vouchers.pick({ id: true, period: true, number: true });
const reversingRef = rows.fin_vouchers.pick({ id: true, period: true, number: true, status: true });

/** 凭证详情：凭证和分录，加上来源单据（或来源功能的记录）、它冲的那张、冲掉它的那张 */
export function voucherDetail(db: DatabaseSync, id: number) {
  const record = voucherRecord(db, id);
  const { header } = record;
  // 来源单据：种类、编号和单号（单号取事件快照里的单据号，没有的退成供应商送货单号）
  const eventOf = (eventId: number | null) =>
    eventId == null
      ? null
      : (one(
          db,
          sourceEvent,
          `SELECT id,source_kind,source_id,event_type,status,${snapshotNumber()} AS number FROM fin_events WHERE id=?`,
          eventId,
        ) ?? null);
  const event = eventOf(header.event_id);
  // 红字凭证冲的那张：界面写“2026-01 第 3 号”并能点开，不露内部编号
  const original =
    header.reversal_of == null
      ? null
      : (one(db, voucherRef, 'SELECT id,period,number FROM fin_vouchers WHERE id=?', header.reversal_of) ?? null);
  // 冲掉这张的红字凭证（没作废的那张）：原凭证上写明“已被 2026-01 第 5 号红字冲销”并能点开
  const reversedBy =
    one(
      db,
      reversingRef,
      "SELECT id,period,number,status FROM fin_vouchers WHERE reversal_of=? AND status<>'void' ORDER BY id DESC LIMIT 1",
      header.id,
    ) ?? null;
  return {
    ...record,
    original,
    reversedBy,
    source:
      event ??
      (header.module_source
        ? {
            module: header.module_source,
            id: header.module_id,
            // 业务单据凭证的红冲，module_id 是原来那条财务事件
            event: header.module_source === 'event_reversal' ? eventOf(header.module_id) : null,
            record: moduleRecord(db, header.module_source, header.module_id, header.id),
          }
        : null),
  };
}

/** 凭证列表，可按期间、状态筛 */
export function voucherList(db: DatabaseSync, query: unknown) {
  const paging = parsePaging(query);
  const filters = z
    .object({
      period: periodSchema.optional(),
      status: statusSchema.optional(),
    })
    .parse(query);
  const params = [
    filters.period ?? null,
    filters.period ?? null,
    filters.status ?? null,
    filters.status ?? null,
  ];
  const where = 'WHERE (? IS NULL OR period=?) AND (? IS NULL OR status=?)';
  const total = count(db, `SELECT count(*) FROM fin_vouchers ${where}`, ...params);
  const page = clampPage(paging.page ?? 1, paging.pageSize, total);
  return {
    rows: many(
      db,
      voucherHeader,
      `SELECT * FROM fin_vouchers ${where} ORDER BY period DESC,number DESC LIMIT ? OFFSET ?`,
      ...params,
      paging.pageSize,
      (page - 1) * paging.pageSize,
    ),
    page,
    pageSize: paging.pageSize,
    filteredRecords: total,
  };
}

/** 库里的分录转回凭证输入的格式（复制、红冲、校验用） */
export function voucherEntries(entries: VoucherRecord['entries']): FinanceEntry[] {
  return entries.map((entry) => ({
    accountCode: entry.account_code,
    description: entry.description,
    debit: entry.debit,
    credit: entry.credit,
    auxiliary: entry.auxiliary_kind
      ? {
          kind: entry.auxiliary_kind,
          id: String(entry.auxiliary_id),
          name: String(entry.auxiliary_name),
        }
      : null,
    cashFlow: entry.cash_flow,
  }));
}
