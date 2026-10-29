import { randomUUID } from 'node:crypto';
import type { OperationsService } from '../server/operations/service.js';
import type { Actor } from '../server/auth.js';
import { audit } from '../server/business/management.js';

/** 仅虚构测试库：把统一服务生成的数据重排为旧独立收货表示，验证真实历史兼容，数量/流水ID不变。 */
export function legacyReceiptFixture(
  ops: OperationsService,
  purchaseId: number,
  input: any,
  actor: Actor,
) {
  const before = ops.repo.purchases(true).find((p) => p.id === purchaseId)!;
  const result = ops.receive(purchaseId, input, actor),
    db = ops.store.db,
    id = randomUUID();
  const flowId = result.arrival.id;
  const items = result.arrival.lines.map((l: any) => ({
    lineId: l.purchaseLineId,
    stockId: l.stockId,
    quantity: l.quantity,
    item: l.item,
    unitPrice: l.unitPrice,
    priceBasis: l.priceBasis,
  }));
  db.prepare(
    'UPDATE stock_movements SET source_kind=?,source_id=? WHERE source_kind=? AND source_id=?',
  ).run('purchase_receipt', id, 'flow_arrival', String(flowId));
  db.prepare('UPDATE purchase_receipts SET id=?,reference=?,document=? WHERE id=?').run(
    id,
    input.reference,
    JSON.stringify({ items, notes: input.notes || '', movements: result.movements, version: 1 }),
    result.receiptId,
  );
  for (const table of ['flow_refs', 'flow_previews', 'flow_receipt_keys', 'flow_file_uses'])
    db.prepare('DELETE FROM ' + table + ' WHERE document_id=?').run(flowId);
  db.prepare('DELETE FROM flow_documents WHERE id=?').run(flowId);
  db.prepare('DELETE FROM operation_requests WHERE request_id=?').run(input.requestId);
  audit(ops.store, actor, 'purchase-receipt', 'receive', 'purchases', purchaseId, {
    before,
    receiptId: id,
  });
  return { ...result, receiptId: id };
}
