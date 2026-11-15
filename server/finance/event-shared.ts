/**
 * 财务事件的几个共用小步骤：取事件、事件对应的往来单位和到期日、挂暂估往来和分期、收入确认口径、核对来源还是不是当时那一版。
 * 同步、处理、生成凭证都用。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { exists, one, rows } from '../core/index.js';
import { financeAudit, financeError } from './core.js';
import { sourceContent, sourceRow, sourcesCte } from './business-source.js';
import { row } from './query.js';
import { sourceHash } from './source-fingerprint.js';
import { documentNumber, type FinanceSourceDocument } from './source-snapshot.js';
import {
  dueDate,
  installments,
  readTermsSnapshot,
  rescaleInstallments,
  termsSnapshotText,
  type TermsSnapshot,
} from './terms.js';

/** 一条财务事件（fin_events 一行） */
export type FinanceEvent = z.output<typeof rows.fin_events>;

/** 按编号取一条财务事件，没有就报“找不到”。 */
export function readEvent(db: DatabaseSync, id: number): FinanceEvent {
  const found = one(db, rows.fin_events, 'SELECT * FROM fin_events WHERE id=?', id);
  if (!found) financeError('找不到这张单据的财务记录。', 404);
  return found;
}

/** 挂往来时记下的账期那几列（到期日、分期按它算） */
const partyTerms = rows.fin_party_terms.pick({
  term_type: true,
  term_days: true,
  term_months: true,
  payment_day: true,
  cutoff_day: true,
  version: true,
  options: true,
});

/** 事件对应的往来单位、应收还是应付、按账期算的到期日和账期快照。 */
export function partyOf(db: DatabaseSync, event: FinanceEvent, doc: FinanceSourceDocument, date: string) {
  const ar = event.source_kind === 'delivery';
  const id = String(ar ? (doc.customerId ?? '') : (doc.supplierId ?? ''));
  const name = ar ? (doc.customerName ?? '') : (doc.supplierName ?? '');
  const kind = ar ? 'receivable' : 'payable',
    auxiliary = ar ? 'customer' : 'supplier';
  const terms = one(
    db,
    partyTerms,
    `SELECT term_type,term_days,term_months,payment_day,cutoff_day,version,options
    FROM fin_party_terms WHERE kind=? AND party_id=?`,
    auxiliary,
    id,
  );
  return {
    id,
    name,
    kind,
    auxiliary,
    due: dueDate(date, terms),
    terms,
    snapshot: termsSnapshotText(terms),
  };
}

/** 资料待补、待开票的事件先挂一笔暂估往来（已经挂过的按新金额更新），分期按账期。 */
export function provisionalObligation(store: Store, user: Actor, event: FinanceEvent, doc: FinanceSourceDocument) {
  const date = event.date,
    party = partyOf(store.db, event, doc, date);
  if (!party.id || !party.name) return;
  const before = one(
    store.db,
    rows.fin_obligations,
    `SELECT * FROM fin_obligations
    WHERE event_id=? AND voucher_id IS NULL AND amount_cents>0 AND tax_status<>'superseded' ORDER BY id DESC LIMIT 1`,
    event.id,
  );
  const status = event.status === 'info_pending' ? 'pending' : 'known';
  let key = Number(before?.id);
  if (before)
    store.db
      .prepare('UPDATE fin_obligations SET amount_cents=?,tax_status=?,version=version+1 WHERE id=?')
      .run(event.amount_cents, status, key);
  else
    key = Number(
      store.db
        .prepare(
          `INSERT INTO fin_obligations(kind,party_id,party_name,date,due_date,
    amount_cents,description,event_id,tax_status,terms_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          party.kind,
          party.id,
          party.name,
          date,
          party.due,
          event.amount_cents,
          (party.kind === 'receivable' ? '送货确认 ' : '到货确认 ') +
            String(documentNumber(doc, event.source_id)) +
            redoMark(store.db, event.id),
          event.id,
          status,
          party.snapshot,
        ).lastInsertRowid,
    );
  const terms = before
    ? readTermsSnapshot(before.terms_snapshot, `fin_obligations.terms_snapshot（往来 ${before.id}）`)
    : party.terms;
  saveInstallments(store.db, key, Number(event.amount_cents), date, terms);
  financeAudit(store, user, {
    action: 'provisional',
    entity: 'fin_obligations',
    id: key,
    before: before ?? null,
    after: row(store.db, 'fin_obligations', key),
  });
}

/** 往来的分期：已经分过期的按原比例重算（到期日可能改过，保留）；还没有的按账期约定新建。 */
export function saveInstallments(
  db: DatabaseSync,
  key: number,
  amount: number,
  date: string,
  terms: Pick<TermsSnapshot, 'options'> | null | undefined,
) {
  // 已经分过期的按原比例重算（到期日可能改过，保留）；还没有的按账期约定新建。
  if (exists(db, 'SELECT 1 FROM fin_installments WHERE obligation_id=? LIMIT 1', key)) {
    rescaleInstallments(db, key, amount);
    return;
  }
  const statement = db.prepare(
    'INSERT INTO fin_installments(obligation_id,position,due_date,amount_cents) VALUES(?,?,?,?)',
  );
  for (const item of installments(amount, date, terms))
    statement.run(key, item.position, item.due, item.amount);
}

/** 这条事件名下已经有红字冲销（单据改过，冲掉旧的再按新内容记）：新记的往来摘要后面写“（更正后重记）” */
export function redoMark(db: DatabaseSync, eventId: number) {
  return exists(
    db,
    "SELECT 1 FROM fin_obligations r JOIN fin_vouchers rv ON rv.id=r.voucher_id WHERE r.event_id=? AND r.reversal_of IS NOT NULL AND rv.status<>'void'",
    eventId,
  )
    ? '（更正后重记）'
    : '';
}

const policyRow = z.object({ policy: rows.fin_settings_history.shape.revenue_recognition });
/** 某个时间点按什么口径确认收入：不晚于这个时间的最后一次财务设置变更（fin_settings_history）；一次都没改过按送货确认。 */
export function revenuePolicy(db: DatabaseSync, at: string) {
  const found = one(
    db,
    policyRow,
    `SELECT revenue_recognition AS policy FROM fin_settings_history
    WHERE changed_at<=? ORDER BY changed_at DESC,id DESC LIMIT 1`,
    at,
  );
  return found?.policy === 'invoice' ? 'invoice' : 'delivery';
}

/** 一张来源单据现在的那一行（sourcesCte 的列）；没有（被删了）是 undefined */
export function currentSource(db: DatabaseSync, kind: string, id: string) {
  return one(db, sourceRow, `${sourcesCte} SELECT * FROM sources WHERE kind=? AND id=?`, kind, id);
}

/** 事件对应的来源单据还是当时看到的那一版，改过或删了就报错让人刷新。 */
export function assertSourceCurrent(db: DatabaseSync, before: FinanceEvent) {
  const source = one(
    db,
    sourceRow,
    `${sourcesCte} SELECT s.* FROM sources s
    JOIN fin_source_observations o ON o.source_kind=s.kind AND o.source_id=s.id
    WHERE s.kind=? AND s.id=? AND o.event_id=? AND o.source_version=s.version AND o.status=s.status`,
    before.source_kind,
    before.source_id,
    before.id,
  );
  if (!source || before.source_hash !== sourceHash(source, sourceContent(source)))
    financeError('单据已经改过或删除了，请刷新后再处理。', 409);
}
