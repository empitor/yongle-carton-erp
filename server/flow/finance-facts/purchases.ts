/**
 * 窗口的采购一组：采购明细（开票匹配的三单对比）和采购退货（到票、退货冲暂估、成本计算给退货计价）。
 * 采购单、采购明细是采购库存的表，退货单是单据流转的表；内容都按业务自己的严格结构读
 * （采购明细经采购库存的 readPurchaseLineDocument，退货单经 return-document.ts 的 readReturnDocument），读不出来抛 StoredDataError。
 * 退货单分两步交出：returnRows（按编号）、returnsOfArrivals（按到货单）按批读出表头和内容原文，
 * returnLines 是把一行原文解析成财务口径的纯函数（不碰库），
 * 财务补扫时用 server/finance/unreadable.ts 的 readOrSkip 包住它，读不出来的逐张跳过。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { purchaseLineAmount, purchaseReturnStatuses } from '../../../shared/business/index.js';
import { quantityString } from '../../../shared/core/index.js';
import { exists, many, rows } from '../../core/index.js';
import { stockLedger } from '../../operations/index.js';
import { readReturnDocument } from '../documents/return-document.js';

const lineRow = z.object({
  id: rows.purchase_lines.shape.id,
  purchase_id: rows.purchases.shape.id,
  number: rows.purchases.shape.number,
  quantity_units: rows.purchase_lines.shape.quantity_units,
  document: rows.purchase_lines.shape.document,
});

/**
 * 一批采购明细，一次查完：明细编号 → 采购单编号和单号、数量（千分之一的整数）、解析好的明细内容 item
 * （名称、单位、纸板尺寸、计价方式、单价等），和按单价、计价方式算出的金额文字 amount（按面积的用纸板尺寸算；没写单价算不出是 null）。
 * 找不到的（明细删了）不在结果里。
 */
function lines(db: DatabaseSync, lineIds: readonly number[]) {
  const found = many(
    db,
    lineRow,
    `SELECT pl.id,p.id AS purchase_id,p.number,pl.quantity_units,pl.document
      FROM purchase_lines pl JOIN purchases p ON p.id=pl.purchase_id WHERE pl.id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(lineIds),
  );
  return new Map(
    found.map((l) => {
      const item = stockLedger.readPurchaseLineDocument(l.document, l.id);
      const amount = purchaseLineAmount({ ...item, quantity: quantityString(l.quantity_units) });
      return [l.id, { purchaseId: l.purchase_id, purchaseNumber: l.number, quantityUnits: l.quantity_units, item, amount }];
    }),
  );
}

const returnRow = rows.purchase_returns
  .pick({ id: true, number: true, arrival_id: true, date: true, updated_at: true, document: true })
  .extend({ status: z.enum(purchaseReturnStatuses) });
/** 采购退货单交给财务的样子：编号、单号、到货单、状态、退货日期、更新时间（撤销按它记）和内容原文 document */
const returnView = (r: z.output<typeof returnRow>) => ({
  id: r.id,
  number: r.number,
  arrivalId: r.arrival_id,
  status: r.status,
  date: r.date,
  updatedAt: r.updated_at,
  document: r.document,
});
/** 读采购退货单，按编号排：column 的值在 ids 里的（按编号或按到货单圈） */
const returnsWhere = (db: DatabaseSync, column: 'id' | 'arrival_id', ids: readonly number[]) =>
  many(
    db,
    returnRow,
    `SELECT id,number,arrival_id,status,date,updated_at,document FROM purchase_returns
      WHERE ${column} IN (SELECT value FROM json_each(?)) ORDER BY id`,
    JSON.stringify(ids),
  ).map(returnView);

/**
 * 这几张到货单的采购退货单（已确认、已撤销，样子同 returnRows），按编号排：财务补扫只看还挂着暂估的到货的退货，
 * 一次按到货单圈出来，不把全部退货读出来再筛（读出来的张数随还挂着暂估的到货走，不随历史退货涨）。
 */
function returnsOfArrivals(db: DatabaseSync, arrivalIds: readonly number[]) {
  return returnsWhere(db, 'arrival_id', arrivalIds);
}

/**
 * 几张采购退货单：编号、单号、到货单、状态、退货日期、更新时间（撤销按它记）和内容原文 document，按编号排。
 * 内容不在这里解析，财务逐张用 returnLines 读。
 */
function returnRows(db: DatabaseSync, ids: readonly number[]) {
  return returnsWhere(db, 'id', ids);
}

/** 一张退货单退了到货单哪几行、各退多少（数量文字）：按严格的退货单结构读，读不出来抛 StoredDataError。纯函数，不碰库 */
function returnLines(row: { id: number; number: string; document: string }) {
  return readReturnDocument(row).lines.map((l) => ({ lineIndex: l.lineIndex, quantity: l.quantity }));
}

/**
 * 这张到货单有没有已确认的采购退货（到票时按退后数量开票不用填对应暂估）。
 * 已撤销、被更正替代的到货在关联、确认发票时就被财务拦下，问到这里的都还有效，不另看到货状态。
 */
function hasConfirmedReturn(db: DatabaseSync, arrivalId: number) {
  const confirmed: (typeof purchaseReturnStatuses)[number] = 'confirmed';
  return exists(db, 'SELECT 1 FROM purchase_returns WHERE arrival_id=? AND status=? LIMIT 1', arrivalId, confirmed);
}

export const purchases = { lines, returnsOfArrivals, returnRows, returnLines, hasConfirmedReturn };
