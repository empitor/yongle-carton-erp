import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { financeAudit } from './core.js';

export function deletedFinanceSource(store: Store, actor: Actor, kind: string, sourceId: string) {
  const db = store.db;
  const find =
    db.prepare(`SELECT e.* FROM fin_source_observations x JOIN fin_events e ON e.id=x.event_id
    WHERE x.source_kind=? AND x.source_id=? AND e.status NOT IN ('source_deleted','before_opening')`);
  const before = find.get(kind, sourceId);
  if (!before) return;
  db.prepare(
    "UPDATE fin_events SET status='source_deleted',problem='原业务来源已删除，凭证和名称快照保留。',version=version+1 WHERE id=?",
  ).run(before.id);
  financeAudit(
    store,
    actor,
    'source_deleted',
    'fin_events',
    Number(before.id),
    before,
    db.prepare('SELECT * FROM fin_events WHERE id=?').get(before.id),
  );
}

export function retainedFinanceReferences(store: Store, entity: string, ids: number[]) {
  if (!ids.length) return 0;
  const db = store.db,
    list = JSON.stringify(ids);
  if (entity === 'customers' || entity === 'suppliers') {
    return Number(
      db
        .prepare(
          `SELECT count(*) AS n FROM fin_entries WHERE auxiliary_kind=? AND
      auxiliary_id IN (SELECT cast(value AS TEXT) FROM json_each(?))`,
        )
        .get(entity === 'customers' ? 'customer' : 'supplier', list)?.n,
    );
  }
  if (entity === 'products' || entity === 'orders') {
    const key = entity === 'products' ? '$.productId' : '$.orderId';
    return Number(
      db
        .prepare(
          `SELECT count(*) AS n FROM fin_events e WHERE EXISTS(
      SELECT 1 FROM json_each(e.snapshot,'$.doc.lines') l WHERE json_extract(l.value,?) IN (SELECT value FROM json_each(?)))`,
        )
        .get(key, list)?.n,
    );
  }
  return 0;
}
