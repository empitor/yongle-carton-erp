import { z } from 'zod';
import type { Actor, Store } from '../../core/index.js';
import { AppError, audit, inSavepoint, many, nextAutoId, one, onceByRequest, operationRequest, requirePermission, requireSuperModeFor, rows } from '../../core/index.js';
import { purchaseReturnSchema, purchaseReturnViewSchema, returnReversalSchema, type ReturnableLine } from '../../../shared/business/index.js';
import { MAX_STOCK_UNITS, UNITS_PER_QUANTITY, quantityString, quantityUnits, today } from '../../../shared/core/index.js';
import { OperationsService, stockLedger } from '../../operations/index.js';
import {
  arrivalPurchaseIds,
  effectiveReceiptUnits,
  receiptEvents,
  subtractReturnedUnits,
  syncReceivedUnits,
} from '../rules/receipt-events.js';
import { storedContent } from '../documents/read.js';
import { readReturnDocument, returnDocumentText, returnRow, returnViewOf, type ReturnDocument } from '../documents/return-document.js';

const { insertMovement, readPurchaseLineDocument, touchStockItems } = stockLedger;

/** 采购退货的业务校验不通过：默认 400，库存、版本这类冲突传 409 */
function fail(message: string, status = 400): never {
  throw new AppError(message, status);
}
/** 退货单号末尾的序号（就是编号）至少几位，不够前面补 0 */
const RETURN_SERIAL_DIGITS = 4;
/** 一张到货单下的退货单最多列这么多张（新的在前） */
const LISTED_RETURNS = 500;
/** 一笔退货（或撤销退货）记的库存流水：delta 是千分整数，退货为负、撤销为正 */
type ReturnMovement = { stockId: number; delta: number; sourceId: number; date: string; note: string; purchaseLineId: number | null };

/**
 * 采购退货：对已确认的到货单按明细退回。退货扣库存（流水 source_kind=purchase_return）、
 * 从采购明细的有效到货里扣除；金额以供应商到票或红字发票为准，退货单本身不记金额。
 */
export class PurchaseReturns {
  private ops: OperationsService;
  constructor(private store: Store) {
    this.ops = new OperationsService(store);
  }

  /** 按主键读一张退货单的行；没有是 undefined */
  private row(id: number) {
    return one(this.store.db, returnRow, 'SELECT * FROM purchase_returns WHERE id=?', id);
  }

  /** 按主键读一张退货单（接口和助手看到的样子）；没有按 404 报 */
  get(id: number) {
    const row = this.row(id);
    if (!row) return fail('退货单不存在。', 404);
    return returnViewOf(row);
  }

  /** 刚写过的退货单读回来（读不回来是程序出错） */
  private written(id: number) {
    const row = this.row(id);
    if (!row) throw new Error('退货单 ' + id + ' 写入后读不回来');
    return returnViewOf(row);
  }

  list(arrivalId?: number) {
    return many(
      this.store.db,
      returnRow,
      'SELECT * FROM purchase_returns WHERE (? IS NULL OR arrival_id=?) ORDER BY date DESC,id DESC LIMIT ?',
      arrivalId ?? null,
      arrivalId ?? null,
      LISTED_RETURNS,
    ).map((r) => returnViewOf(r));
  }

  /** 按主键读到货单（内容按库里的单据结构读），并用到货事件派生“实际入库数量”和现在还存在的采购明细。 */
  private arrival(arrivalId: number) {
    const row = one(this.store.db, rows.flow_documents, "SELECT * FROM flow_documents WHERE id=? AND kind='arrival'", arrivalId);
    if (!row) return fail('到货单不存在。', 404);
    const event = receiptEvents(this.store, undefined, { arrivalIds: [arrivalId] })[0];
    return { row, doc: storedContent('arrival', row), event };
  }

  /**
   * 到货单每行还能退多少：实际入库数量减去没冲销的退货。
   * 入库数量取到货单每行记的实际入库数量；没记的不能退，提示待核对，不拿申报数量顶替。
   */
  returnable(arrivalId: number) {
    const { row, doc, event } = this.arrival(arrivalId);
    const effective = row.status === 'confirmed' && !!event?.effective;
    const returned = new Map<number, number>();
    for (const r of this.list(arrivalId))
      if (r.status === 'confirmed')
        for (const l of r.lines)
          returned.set(l.lineIndex, (returned.get(l.lineIndex) || 0) + quantityUnits(l.quantity));
    return {
      arrival: row,
      doc,
      effective,
      lines: doc.lines.map((line, lineIndex): ReturnableLine => {
        const derived = event?.lines[lineIndex];
        const stockedText = derived?.stockedQuantity ?? null;
        const stocked = stockedText == null ? null : quantityUnits(stockedText);
        const back = returned.get(lineIndex) || 0;
        const stockId = line.stockId;
        const hint = !effective
          ? '到货单已撤销或被更正替代'
          : stockId == null
            ? '没有关联库存'
            : stocked == null
              ? '入库数量待核对'
              : '';
        return {
          lineIndex,
          stockId,
          name: line.item.name,
          unit: line.item.unit,
          // 以到货单现在这一行、且仍存在的采购明细为准。
          purchaseLineId: derived?.lineId ?? null,
          stocked: stocked == null ? null : quantityString(stocked),
          returned: quantityString(back),
          // 有提示的（含入库数量待核对）都不能退
          returnable: quantityString(hint || stocked == null ? 0 : Math.max(0, stocked - back)),
          hint,
        };
      }),
    };
  }

  private movement(m: ReturnMovement, actor: Actor) {
    const before = this.ops.balance(m.stockId),
      after = before + m.delta;
    if (after < 0) fail('库存不足，不能退这么多：退货会让库存变成负数。', 409);
    if (!Number.isSafeInteger(after) || after > MAX_STOCK_UNITS) fail('库存数量超出可保存范围。', 409);
    insertMovement(this.store, {
      stockId: m.stockId,
      action: m.delta < 0 ? 'out' : 'in',
      delta: m.delta,
      before,
      after,
      sourceKind: 'purchase_return',
      sourceId: String(m.sourceId),
      purchaseLineId: m.purchaseLineId,
      orderId: null,
      date: m.date,
      notes: m.note,
      actor,
    });
    touchStockItems(this.store, [m.stockId]);
  }

  /** 这次要退的几行：每行核对能退多少（只退整张），返回退货单里记的明细 */
  private chosenLines(lines: ReturnType<PurchaseReturns['returnable']>['lines'], input: z.output<typeof purchaseReturnSchema>['lines']) {
    if (new Set(input.map((l) => l.lineIndex)).size !== input.length) fail('同一行到货明细请合并成一行退货。');
    return input.map((l) => {
      const line = lines[l.lineIndex];
      if (!line || line.stockId == null) return fail('到货明细不存在或没有入库。');
      if (line.stocked == null) fail(line.name + ' 的入库数量待核对，核对前不能退货。', 409);
      const units = quantityUnits(l.quantity);
      // 到货明细只有“张”（单据保存服务归一并拒收别的单位）
      if (units % UNITS_PER_QUANTITY) fail('纸板退货按整张登记，不能填写小数张。');
      if (units > quantityUnits(line.returnable)) fail(line.name + ' 最多还能退 ' + line.returnable + ' ' + line.unit + '。');
      return {
        lineIndex: line.lineIndex,
        stockId: line.stockId,
        name: line.name,
        unit: line.unit,
        purchaseLineId: line.purchaseLineId,
        quantity: quantityString(units),
      };
    });
  }

  create(who: Actor | null | undefined, raw: unknown) {
    const actor = requirePermission(who, 'business:edit');
    const v = purchaseReturnSchema.parse(raw);
    return onceByRequest(this.store, operationRequest('purchase-return', v.requestId, actor, v), () => {
      const { arrival, doc, lines, effective } = this.returnable(v.arrivalId);
      if (!effective) fail('只有已入库、没撤销的到货单可以退货。', 409);
      if (v.date < arrival.date) fail('退货日期不能早于到货日期。');
      if (v.date > today()) fail('退货日期不能晚于今天。');
      const chosen = this.chosenLines(lines, v.lines);
      // 编号用不会重用的主键（AUTOINCREMENT）：到货单连同退货被删除后，新退货也不会撞号。
      const id = nextAutoId(this.store.db, 'purchase_returns');
      const number = 'TH-' + v.date.replaceAll('-', '') + '-' + String(id).padStart(RETURN_SERIAL_DIGITS, '0');
      const now = new Date().toISOString();
      const document: ReturnDocument = {
        requestId: v.requestId,
        reason: v.reason,
        arrivalNumber: arrival.number,
        supplierId: doc.supplierId,
        supplierName: doc.supplierName ?? '',
        lines: chosen,
      };
      this.store.db
        .prepare(
          `INSERT INTO purchase_returns(id,number,arrival_id,date,status,document,actor_id,actor_name,created_at,updated_at)
          VALUES(?,?,?,?,'confirmed',?,?,?,?,?)`,
        )
        .run(id, number, v.arrivalId, v.date, returnDocumentText(document, '新退货单 ' + number), actor.id, actor.name, now, now);
      for (const l of chosen)
        this.movement(
          { stockId: l.stockId, delta: -quantityUnits(l.quantity), sourceId: id, date: v.date, note: number + ' · 采购退货：' + v.reason, purchaseLineId: l.purchaseLineId },
          actor,
        );
      // 退货只改变这张到货关联的采购单的已到货。
      syncReceivedUnits(this.store, true, arrivalPurchaseIds(this.store, [v.arrivalId]));
      const after = this.written(id);
      audit(this.store, actor, { action: 'create', entity: 'purchase_returns', id, document: { after } });
      return after;
    }, purchaseReturnViewSchema);
  }

  /**
   * 冲销退货会把数量加回采购已到货。供应商已经补过货时，加回去可能超过订购数量，
   * 这种情况拦下，请先核对补货到货。
   */
  private assertReceiptRoom(returnId: number, lines: { purchaseLineId: number | null }[]) {
    const lineIds = [...new Set(lines.flatMap((l) => (l.purchaseLineId == null ? [] : [l.purchaseLineId])))];
    if (!lineIds.length) return;
    const ordered = many(
      this.store.db,
      rows.purchase_lines.pick({ id: true, purchase_id: true, quantity_units: true, document: true }),
      'SELECT id,purchase_id,quantity_units,document FROM purchase_lines WHERE id IN (SELECT value FROM json_each(?))',
      JSON.stringify(lineIds),
    );
    const events = receiptEvents(this.store, [...new Set(ordered.map((l) => l.purchase_id))]);
    const now = subtractReturnedUnits(this.store, effectiveReceiptUnits(events), events),
      after = subtractReturnedUnits(this.store, effectiveReceiptUnits(events), events, returnId);
    for (const l of ordered) {
      const next = after.get(l.id) || 0;
      if (next > (now.get(l.id) || 0) && next > l.quantity_units) this.overReceived(l, next);
    }
  }

  /** 撤销退货后这条采购明细累计到货超过采购数量：按明细的名称、单位说清楚 */
  private overReceived(l: { id: number; quantity_units: number; document: string }, next: number): never {
    const line = readPurchaseLineDocument(l.document, l.id),
      unit = line.unit || '';
    return fail(
      (line.name || '采购明细') +
        ' 撤销退货后累计到货 ' + quantityString(next) + ' ' + unit +
        '，超过采购数量 ' + quantityString(l.quantity_units) + ' ' + unit +
        '。供应商已经补过货，请先核对补货的到货单，再决定是否撤销这张退货。',
      409,
    );
  }

  /** 撤销时要加回的几行：库存品还在，采购明细以到货单现在这一行为准 */
  private reversalLines(current: ReturnType<typeof returnViewOf>, event: { lines: { lineId: number | null }[] }) {
    const existing = new Set(
      many(
        this.store.db,
        rows.stock_items.pick({ id: true }),
        'SELECT id FROM stock_items WHERE id IN (SELECT value FROM json_each(?))',
        JSON.stringify(current.lines.flatMap((l) => (l.stockId == null ? [] : [l.stockId]))),
      ).map((r) => r.id),
    );
    // 采购明细以到货单现在这一行为准：退货单里存的旧编号可能已被解除或被新明细重用。
    return current.lines.map((l) => {
      if (l.stockId == null || !existing.has(l.stockId))
        return fail(l.name + ' 这个库存品已不存在，不能自动撤销这张退货，请先核对库存记录。', 409);
      return { ...l, stockId: l.stockId, purchaseLineId: event.lines[l.lineIndex]?.lineId ?? null };
    });
  }

  reverse(who: Actor | null | undefined, rawId: unknown, raw: unknown) {
    // 撤销退货要超级管理员模式：进不了模式的账号直接说没有权限，没进的超级管理员提示去“系统维护”（server/core/http/permissions.ts）
    const actor = requireSuperModeFor(requirePermission(who, 'business:edit'), '撤销采购退货');
    const id = z.coerce.number().int().positive().parse(rawId);
    const v = returnReversalSchema.parse(raw);
    return inSavepoint(this.store.db, () => {
      const row = this.row(id);
      if (!row) return fail('退货单不存在。', 404);
      const stored = readReturnDocument(row),
        current = returnViewOf(row, stored);
      if (current.status === 'reversed') return current;
      if (current.version !== v.version) fail('退货单已变化，请刷新。', 409);
      const { row: arrival, event } = this.arrival(current.arrivalId);
      if (arrival.status !== 'confirmed' || !event?.effective)
        return fail('原到货单已撤销或被更正替代，这张退货不能再撤销，请先核对到货和库存记录。', 409);
      const lines = this.reversalLines(current, event);
      this.assertReceiptRoom(id, lines);
      const date = today();
      for (const l of lines)
        this.movement(
          { stockId: l.stockId, delta: quantityUnits(l.quantity), sourceId: id, date, note: current.number + ' · 撤销采购退货：' + v.reason, purchaseLineId: l.purchaseLineId },
          actor,
        );
      const at = new Date().toISOString();
      this.store.db
        .prepare("UPDATE purchase_returns SET status='reversed',version=version+1,updated_at=?,document=? WHERE id=?")
        .run(at, returnDocumentText({ ...stored, reversal: { reason: v.reason, by: actor.name, at } }, '退货单 ' + row.number), id);
      syncReceivedUnits(this.store, true, arrivalPurchaseIds(this.store, [current.arrivalId]));
      const after = this.written(id);
      audit(this.store, actor, {
        action: 'reverse',
        entity: 'purchase_returns',
        id,
        document: { before: current, after },
      });
      return after;
    });
  }
}
