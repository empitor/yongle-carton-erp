import type { z } from 'zod';
import { quantityString, quantityUnits } from '../../../shared/core/index.js';
import { arrivalQuerySchema, type ArrivalRecord, type PurchaseView, type ReceiptEvent } from '../../../shared/business/index.js';
import { many, rows } from '../../core/index.js';
import { receiptEvents } from './receipt-events.js';
import type { FlowCommands } from '../documents/base.js';
import { StockViews } from '../stock/stock-views.js';

/* 到货记录的查询（回答的结构在 shared/business/flow-views.ts）。到货单本身的保存、核对、确认在 FlowService，登记到货在 register-arrival.ts。 */

type MovementRow = z.output<typeof rows.stock_movements>;
type ReceiptLine = ReceiptEvent['lines'][number];

/** 只要供应商名称时按主键批量读，不组装每家供应商的采购历史。 */
function supplierNames(flow: FlowCommands, ids: readonly number[]) {
  return new Map(
    many(flow.store.db, rows.suppliers.pick({ id: true, name: true }), 'SELECT id,name FROM suppliers WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify([...new Set(ids)]))
      .map((s) => [s.id, s.name]),
  );
}

/** 这批到货单的入库及冲销流水，一次批量取回，按到货单分组；同一张单仍按 rowid 排序。 */
function movementGroups(flow: FlowCommands, flowIds: readonly number[]) {
  const groups = new Map<string, MovementRow[]>();
  for (const m of many(
    flow.store.db,
    rows.stock_movements,
    "SELECT * FROM stock_movements WHERE source_kind IN ('flow_arrival','flow_reversal') AND source_id IN (SELECT value FROM json_each(?)) ORDER BY rowid",
    JSON.stringify([...new Set(flowIds.map(String))]),
  )) {
    const key = String(m.source_id);
    const group = groups.get(key);
    if (group) group.push(m);
    else groups.set(key, [m]);
  }
  return groups;
}

/**
 * 一行明细配上它的入库流水和实际入库数。同物料、同采购行的多条明细只能按流水顺序一一对应，不能各自重复拿总量；
 * 已记明入库 0 的行没有流水，不参与配对，否则同物料的另一行也会被误判成待核对。
 * 详情“入库流水”按行挂：每行只挂配给它的那一笔入库；配不上（笔数和行数不一样）时全挂在同物料、同采购行的第一行。
 * 撤销时的扣回流水按库存品合计、不记采购明细，挂在这个库存品的第一行（reversalLine）。同一笔流水只出现在一行里。
 */
function lineStock(e: ReceiptEvent, l: ReceiptLine, movements: MovementRow[], reversalLine: boolean) {
  const sameLine = (line: ReceiptLine) => line.stockId === l.stockId && line.lineId === l.lineId;
  const inbound = movements.filter(
    (m) =>
      m.item_id === l.stockId &&
      m.source_kind === 'flow_arrival' &&
      (m.purchase_line_id == null ? l.lineId == null : m.purchase_line_id === l.lineId),
  );
  const peers = e.lines.filter((line) => sameLine(line) && line.stockedQuantity !== '0');
  const balanced = inbound.length === peers.length;
  const assigned = balanced && l.stockedQuantity !== '0' ? inbound[peers.indexOf(l)] : undefined;
  const owner = e.lines.find(sameLine) === l;
  const own = new Set(balanced ? (assigned ? [assigned] : []) : owner ? inbound : []);
  return {
    stockedQuantity:
      e.status === 'draft' ? '0' : assigned ? quantityString(assigned.delta_units) : balanced && l.stockedQuantity === '0' ? '0' : null,
    movements: movements.filter((m) => own.has(m) || (reversalLine && m.source_kind === 'flow_reversal' && m.item_id === l.stockId)),
  };
}

/** 入库情况：待核对的、原单失效的、有行对不上的先说；否则按每行实际入库数看全入、部分入还是没入 */
function inventoryStatus(
  e: ReceiptEvent,
  lines: { quantity: string; stockedQuantity: string | null; inventoryMismatch: boolean }[],
): ArrivalRecord['inventoryStatus'] {
  if (e.status === 'draft') return '尚未入库';
  if (!e.effective) return '原单已失效';
  const stocked: number[] = [];
  for (const l of lines) {
    if (l.stockedQuantity == null || l.inventoryMismatch) return '入库待核对';
    stocked.push(quantityUnits(l.stockedQuantity));
  }
  if (stocked.every((n) => !n)) return '未入库';
  return lines.some((l, i) => stocked[i] < quantityUnits(l.quantity)) ? '部分入库' : '已入库';
}

/** 验收情况：确认过的到货每行都有验收数量；没验收就取消的到货单没有 */
function inspectionStatus(e: ReceiptEvent): ArrivalRecord['inspectionStatus'] {
  if (e.status === 'draft') return '待验收';
  if (e.lines.some((l) => l.acceptedQuantity == null || l.rejectedQuantity == null)) return '未验收';
  return e.lines.some((l) => l.rejectedQuantity != null && quantityUnits(l.rejectedQuantity) > 0) ? '含不合格品' : '全部合格';
}

/** 按查询条件取到货事件：给了 flowIds 只读这几张；按记录编号、采购单查也只读相关的 */
function sourceEvents(flow: FlowCommands, v: z.output<typeof arrivalQuerySchema>, scope?: { flowIds?: readonly number[] }) {
  if (scope?.flowIds) return receiptEvents(flow.store, undefined, { arrivalIds: scope.flowIds });
  if (v.receiptId) {
    const flowId = /^flow-(\d+)$/.exec(v.receiptId);
    return receiptEvents(flow.store, undefined, { arrivalIds: flowId ? [Number(flowId[1])] : [] });
  }
  return v.purchaseId ? receiptEvents(flow.store, [v.purchaseId]) : receiptEvents(flow.store);
}

/**
 * scope.flowIds：只组装这几张到货单（按主键），不给是全部；includeArchived 为真时已归档的也组装（点开一张已归档的详情）。按采购单或记录编号查询时也只读相关到货事件；
 * 采购单、供应商名称和库存流水都按事件里出现的主键批量读取，不全量加载后再查找。
 */
export function arrivalRecords(
  flow: FlowCommands,
  raw: unknown = {},
  scope?: { flowIds?: readonly number[]; includeArchived?: boolean },
): ArrivalRecord<MovementRow>[] {
  const v = arrivalQuerySchema.parse(raw);
  const archived = scope?.includeArchived ? null : flow.store.archivedIds('flow_arrival');
  const events = sourceEvents(flow, v, scope).filter((e) => (!v.receiptId || e.id === v.receiptId) && (!v.date || e.date === v.date) && (!v.supplierId || e.supplierId === v.supplierId) &&
    (!v.purchaseId || e.lines.some((l) => l.purchaseId === v.purchaseId)) && (v.includeInactive || e.effective) &&
    !archived?.has(e.flowId)).reverse();
  const purchases = new Map<number, PurchaseView>(
    new StockViews(flow.store).purchases(true, [...new Set(events.flatMap((e) => e.lines.map((l) => l.purchaseId)).filter((id): id is number => typeof id === 'number'))])
      .map((p) => [p.id, p]),
  );
  const suppliers = supplierNames(flow, events.map((e) => e.supplierId));
  const numbers = new Map(
    many(flow.store.db, rows.flow_documents.pick({ id: true, number: true }), 'SELECT id,number FROM flow_documents WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(events.map((e) => e.flowId)))
      .map((r) => [r.id, r.number]),
  );
  const groups = movementGroups(flow, events.map((e) => e.flowId));
  return events.map((e) => {
    const movements = [...(groups.get(String(e.flowId)) || [])];
    const firstOfStock = new Map<number | null, number>();
    e.lines.forEach((line, i) => {
      if (!firstOfStock.has(line.stockId)) firstOfStock.set(line.stockId, i);
    });
    const lines = e.lines.map((l, index): ArrivalRecord<MovementRow>['lines'][number] => {
      const purchase = l.purchaseId == null ? undefined : purchases.get(l.purchaseId),
        pl = purchase?.lines.find((p) => p.id === l.lineId),
        stock = lineStock(e, l, movements, firstOfStock.get(l.stockId) === index);
      return { ...l, stockedQuantity: stock.stockedQuantity, inventoryMismatch: e.status !== 'draft' && l.stockedQuantity != null && stock.stockedQuantity !== l.stockedQuantity, purchaseNumber: purchase?.number ?? '', orderedQuantity: pl?.quantity ?? null, receivedQuantity: pl?.receivedQuantity ?? null,
        remainingQuantity: pl?.remainingQuantity ?? null, arrivalStatus: pl?.arrivalStatus ?? null,
        movements: stock.movements,
      };
    });
    return { ...e, number: numbers.get(e.flowId), supplierName: e.document.supplierName || suppliers.get(e.supplierId) || '历史供应商',
      actualTime: e.document.actualTime ?? null, lines, movements,
      inspectionStatus: inspectionStatus(e),
      inventoryStatus: inventoryStatus(e, lines),
    };
  });
}
