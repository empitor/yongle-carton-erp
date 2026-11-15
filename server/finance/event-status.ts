import { z } from 'zod';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { exists, many, one, rows } from '../core/index.js';
import { financeAudit } from './core.js';
import { activeCashAllocation, allocationReversalMessage } from './obligation-sql.js';
import { hasBookedObligations, hasPendingObligations, releaseProvisionalObligations } from './event-source-obligations.js';
import { readEvent, type FinanceEvent } from './event-shared.js';
import { row } from './query.js';

/** 财务事件由同一张单据的新事件接手：标成已替代，写审计。 */
export function supersedeEvent(store: Store, actor: Actor, before: FinanceEvent) {
  store.db.prepare("UPDATE fin_events SET status='superseded',version=version+1 WHERE id=?").run(before.id);
  financeAudit(store, actor, {
    action: 'supersede',
    entity: 'fin_events',
    id: before.id,
    before,
    after: readEvent(store.db, before.id),
  });
}

/**
 * 启用前的单据启用后又变了（被冲销、更正替代，或改了单价、数量这些财务看的内容）：仍不进账，
 * 但期初往来可能要跟着调，在事件上记一句提醒（problem），结账检查里列出来、不拦结账。
 * 指纹跟着更新到这一版：核对无误（events/:id/acknowledge）清掉提醒后，只有再变才会再提醒。
 */
export function flagBeforeOpeningChange(store: Store, actor: Actor, before: FinanceEvent, hash: string, inactive: boolean) {
  if (before.source_hash === hash) return;
  const problem = inactive
    ? '启用前的单据启用后被冲销或更正，请核对期初往来。'
    : '启用前的单据启用后改过单价、数量等，请核对期初往来。';
  store.db
    .prepare('UPDATE fin_events SET source_hash=?,problem=?,version=version+1 WHERE id=?')
    .run(hash, problem, before.id);
  financeAudit(store, actor, {
    action: 'before_opening_changed',
    entity: 'fin_events',
    id: before.id,
    before,
    after: { ...before, source_hash: hash, problem, version: before.version + 1 },
  });
}

/** 已经处理完的事件：来源再被删也不用人管 */
const settledStatuses = ['corrected', 'superseded', 'costed', 'no_amount'];

/**
 * 来源单据被删（删除记录时和同步兜底都走这里）：观察记录标成已删除，只处理一次。
 * 已处理完的事件不动；名下没有要人处理的往来的（盘点、完工单本来就没有凭证，成本由月末成本计算按流水算；
 * 送货、到货还没入过账），系统挂的暂估往来作废、直接记“已更正”；送货、到货名下还有凭证、核销、发票这些的，
 * 才记“来源已删除”，由人红字冲销或核对后保留原凭证。
 */
export function markSourceDeleted(store: Store, actor: Actor, before: FinanceEvent) {
  const db = store.db,
    id = before.id,
    kind = before.source_kind,
    sourceId = before.source_id;
  db.prepare("UPDATE fin_source_observations SET status='deleted' WHERE source_kind=? AND source_id=?").run(
    kind,
    sourceId,
  );
  if (settledStatuses.includes(before.status)) return;
  const booked = ['delivery', 'arrival'].includes(kind);
  const live = booked && hasPendingObligations(db, kind, [sourceId]);
  if (booked && !live) releaseProvisionalObligations(store, actor, kind, [sourceId]);
  const [status, problem] = live
    ? [
        'source_deleted',
        hasBookedObligations(db, kind, [sourceId])
          ? '单据已被删除，原凭证还在：核对后点“红字冲销”；收入、成本是真的就“核对无误，保留凭证”。'
          : '单据已被删除，名下没有还算数的凭证：点“红字冲销”；挂着收付款核销或没冲掉的发票的，先撤销核销或红冲发票。',
      ]
    : booked
      ? ['corrected', '单据已删除，还没入过账，不用处理。']
      : ['corrected', '单据已删除，库存数量和成本由月末成本计算按流水算，不用处理。'];
  db.prepare('UPDATE fin_events SET status=?,problem=?,version=version+1 WHERE id=?').run(status, problem, id);
  financeAudit(store, actor, { action: 'source_deleted', entity: 'fin_events', id, before, after: readEvent(db, id) });
}

/** 已撤销的送货单的冲销事件，带它接手的那条（还在资料待补、没出过凭证的）的编号 */
const reversalCandidate = rows.fin_events.extend({ previous_id: z.number() });

/**
 * 已撤销的送货单原来那条还在资料待补、没出过凭证：原来的暂估往来上还挂着收付款核销的，等撤销核销记账（“待撤销核销”）；
 * 没有的（或撤销核销已记账）冲销事件记成已更正，原来那条和它的往来都标成已替代。obligationId 给了只看那笔往来的。
 */
export function refreshPendingDeliveryReversals(store: Store, actor: Actor, obligationId?: number) {
  const db = store.db;
  const candidates = many(
    db,
    reversalCandidate,
    `SELECT e.*,previous.id AS previous_id FROM fin_source_observations x
    JOIN fin_events e ON e.id=x.event_id
    JOIN fin_events previous ON previous.id=json_extract(e.snapshot,'$.previous.eventId')
    WHERE x.source_kind='delivery' AND x.status='reversed'
    AND e.event_type='delivery.reversed' AND e.status IN ('difference','awaiting_allocation_reversal')
    AND json_extract(e.snapshot,'$.previous.status')='info_pending' AND previous.voucher_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM fin_obligations o WHERE o.event_id=previous.id AND (
      o.voucher_id IS NOT NULL OR EXISTS(SELECT 1 FROM fin_invoice_links l WHERE l.obligation_id=o.id)
      OR EXISTS(SELECT 1 FROM fin_deposit_actions d WHERE d.obligation_id=o.id)
      OR EXISTS(SELECT 1 FROM fin_bad_debts b WHERE b.obligation_id=o.id)))
    AND (? IS NULL OR previous.id=(SELECT event_id FROM fin_obligations WHERE id=?))`,
    obligationId ?? null,
    obligationId ?? null,
  );
  for (const event of candidates) refreshReversal(store, actor, event);
}

/** 一条已撤销送货单的冲销事件：按原来那条名下还有没有收付款核销，记成“待撤销核销”或“已更正” */
function refreshReversal(store: Store, actor: Actor, event: z.output<typeof reversalCandidate>) {
  const db = store.db;
  const previous = readEvent(db, event.previous_id);
  if (previous.status === 'info_pending') supersedeEvent(store, actor, previous);
  const pending = exists(
    db,
    `SELECT 1 FROM fin_obligations o JOIN fin_allocations a ON a.obligation_id=o.id
      JOIN fin_vouchers original ON original.id=a.voucher_id WHERE o.event_id=? AND ${activeCashAllocation}`,
    previous.id,
  );
  const status = pending ? 'awaiting_allocation_reversal' : 'corrected';
  const problem = pending ? allocationReversalMessage : null;
  if (event.status !== status) {
    db.prepare('UPDATE fin_events SET status=?,problem=?,version=version+1 WHERE id=?').run(status, problem, event.id);
    financeAudit(store, actor, {
      action: 'delivery_reversal',
      entity: 'fin_events',
      id: event.id,
      before: event,
      after: readEvent(db, event.id),
    });
  }
  if (pending) return;
  const obligations = many(
    db,
    rows.fin_obligations,
    "SELECT * FROM fin_obligations WHERE event_id=? AND tax_status<>'superseded'",
    previous.id,
  );
  for (const item of obligations) {
    db.prepare("UPDATE fin_obligations SET tax_status='superseded',version=version+1 WHERE id=?").run(item.id);
    financeAudit(store, actor, {
      action: 'supersede',
      entity: 'fin_obligations',
      id: item.id,
      before: item,
      after: row(db, 'fin_obligations', item.id),
    });
  }
}

/**
 * 凭证作废时：生成这张凭证的财务事件回到“可记账”，往来跟着清掉凭证号。重新生成时接着用这一条往来，
 * 收付款核销、发票关联、多付转抵都挂在它上面，不能另起一条把它们丢掉。只处理还在观察中的、已生成凭证的事件。
 */
export function releaseEventOnVoid(store: Store, actor: Actor, eventId: number, id: number) {
  const db = store.db;
  const event = one(db, rows.fin_events, 'SELECT * FROM fin_events WHERE id=?', eventId);
  const active = exists(db, 'SELECT 1 FROM fin_source_observations WHERE event_id=?', eventId);
  if (!active || event?.status !== 'generated') return;
  db.prepare("UPDATE fin_events SET voucher_id=NULL,status='ready',version=version+1 WHERE id=?").run(eventId);
  // 往来跟着凭证一起回到“待生成凭证”：清掉凭证号，重新生成时接着用这一条，
  // 收付款核销、发票关联、多付转抵都挂在它上面，不能另起一条把它们丢掉。
  const linkedObligations = many(
    db,
    rows.fin_obligations,
    'SELECT * FROM fin_obligations WHERE event_id=? AND voucher_id=? AND reversal_of IS NULL',
    eventId,
    id,
  );
  for (const obligation of linkedObligations) {
    db.prepare('UPDATE fin_obligations SET voucher_id=NULL,version=version+1 WHERE id=?').run(obligation.id);
    financeAudit(store, actor, {
      action: 'voucher_void',
      entity: 'fin_obligations',
      id: obligation.id,
      before: obligation,
      after: row(db, 'fin_obligations', obligation.id),
    });
  }
  financeAudit(store, actor, {
    action: 'voucher_void',
    entity: 'fin_events',
    id: eventId,
    before: event,
    after: readEvent(db, eventId),
  });
}

const reversedAllocation = z.object({ obligation_id: rows.fin_allocations.shape.obligation_id });

/** 撤销核销的红字凭证记账后：反向核销对应的原核销记成已撤销，被冲销送货单的事件跟着刷新。 */
export function finishAllocationReversal(store: Store, actor: Actor, voucherId: number) {
  const db = store.db;
  const revoked = many(
    db,
    rows.fin_allocations,
    `SELECT * FROM fin_allocations WHERE status='reversing' AND id IN
    (SELECT reversal_of FROM fin_allocations WHERE voucher_id=?)`,
    voucherId,
  );
  for (const allocation of revoked) {
    db.prepare("UPDATE fin_allocations SET status='revoked',version=version+1 WHERE id=?").run(allocation.id);
    financeAudit(store, actor, {
      action: 'revoke_post',
      entity: 'fin_allocations',
      id: allocation.id,
      before: allocation,
      after: row(db, 'fin_allocations', allocation.id),
    });
  }
  const allocation = one(
    db,
    reversedAllocation,
    'SELECT obligation_id FROM fin_allocations WHERE voucher_id=? AND reversal_of IS NOT NULL',
    voucherId,
  );
  if (allocation) refreshPendingDeliveryReversals(store, actor, allocation.obligation_id);
}
