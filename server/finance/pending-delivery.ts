import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { financeAudit } from './core.js';

export const activeCashAllocation = `a.reversal_of IS NULL AND original.status<>'void' AND NOT EXISTS(
  SELECT 1 FROM fin_allocations r JOIN fin_vouchers rv ON rv.id=r.voucher_id
  WHERE r.reversal_of=a.id AND rv.status='posted')`;
export const allocationReversalMessage = '送货单已冲销，请先撤销核销并记账相关红冲。';

export function refreshPendingDeliveryReversals(store: Store, actor: Actor, obligationId?: number) {
  const db = store.db;
  const candidates = db
    .prepare(
      `SELECT e.*,previous.id AS previous_id FROM fin_source_observations x
    JOIN fin_events e ON e.id=x.event_id
    JOIN fin_events previous ON previous.id=json_extract(e.snapshot,'$.previous.eventId')
    WHERE x.source_kind='delivery' AND x.status='reversed'
    AND e.event_type='delivery.reversed' AND e.status IN ('difference','awaiting_allocation_reversal')
    AND json_extract(e.snapshot,'$.previous.status')='info_pending' AND previous.voucher_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM fin_obligations o WHERE o.event_id=previous.id AND (
      o.voucher_id IS NOT NULL OR EXISTS(SELECT 1 FROM fin_invoice_links l WHERE l.obligation_id=o.id)
      OR EXISTS(SELECT 1 FROM fin_deposit_actions d WHERE d.obligation_id=o.id)))
    AND (? IS NULL OR previous.id=(SELECT event_id FROM fin_obligations WHERE id=?))`,
    )
    .all(obligationId ?? null, obligationId ?? null);
  for (const event of candidates) {
    const previous = db.prepare('SELECT * FROM fin_events WHERE id=?').get(event.previous_id)!;
    if (previous.status === 'info_pending') {
      db.prepare("UPDATE fin_events SET status='superseded',version=version+1 WHERE id=?").run(
        previous.id,
      );
      financeAudit(
        store,
        actor,
        'supersede',
        'fin_events',
        Number(previous.id),
        previous,
        db.prepare('SELECT * FROM fin_events WHERE id=?').get(previous.id),
      );
    }
    const pending = db
      .prepare(
        `SELECT 1 FROM fin_obligations o JOIN fin_allocations a ON a.obligation_id=o.id
      JOIN fin_vouchers original ON original.id=a.voucher_id WHERE o.event_id=? AND ${activeCashAllocation}`,
      )
      .get(previous.id);
    const status = pending ? 'awaiting_allocation_reversal' : 'corrected';
    const problem = pending ? allocationReversalMessage : null;
    if (event.status !== status) {
      db.prepare('UPDATE fin_events SET status=?,problem=?,version=version+1 WHERE id=?').run(
        status,
        problem,
        event.id,
      );
      financeAudit(
        store,
        actor,
        'delivery_reversal',
        'fin_events',
        Number(event.id),
        event,
        db.prepare('SELECT * FROM fin_events WHERE id=?').get(event.id),
      );
    }
    if (!pending) {
      const obligations = db
        .prepare("SELECT * FROM fin_obligations WHERE event_id=? AND tax_status<>'superseded'")
        .all(previous.id);
      for (const item of obligations) {
        db.prepare(
          "UPDATE fin_obligations SET tax_status='superseded',version=version+1 WHERE id=?",
        ).run(item.id);
        financeAudit(
          store,
          actor,
          'supersede',
          'fin_obligations',
          Number(item.id),
          item,
          db.prepare('SELECT * FROM fin_obligations WHERE id=?').get(item.id),
        );
      }
    }
  }
}
