import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { count, one, registerFinanceDeletionRules, rows } from '../core/index.js';
import { markSourceDeleted } from './event-status.js';
import { snapshotLines } from './source-snapshot.js';

function deletedFinanceSource(store: Store, actor: Actor, kind: string, sourceId: string) {
  const before = one(
    store.db,
    rows.fin_events,
    `SELECT e.* FROM fin_source_observations x JOIN fin_events e ON e.id=x.event_id
    WHERE x.source_kind=? AND x.source_id=? AND x.status<>'deleted' AND e.status<>'before_opening'`,
    kind,
    sourceId,
  );
  if (before) markSourceDeleted(store, actor, before);
}

function retainedFinanceReferences(store: Store, entity: string, ids: number[]) {
  if (!ids.length) return 0;
  const db = store.db,
    list = JSON.stringify(ids);
  if (entity === 'customers' || entity === 'suppliers') {
    return count(
      db,
      `SELECT count(*) FROM fin_entries WHERE auxiliary_kind=? AND
      auxiliary_id IN (SELECT cast(value AS TEXT) FROM json_each(?))`,
      entity === 'customers' ? 'customer' : 'supplier',
      list,
    );
  }
  if (entity === 'products' || entity === 'orders') {
    const key = entity === 'products' ? '$.productId' : '$.orderId';
    return count(
      db,
      `SELECT count(*) FROM fin_events e WHERE EXISTS(
      SELECT 1 FROM ${snapshotLines('e.snapshot')} l WHERE json_extract(l.value,?) IN (SELECT value FROM json_each(?)))`,
      key,
      list,
    );
  }
  return 0;
}

// 业务汇总的删除引擎经基础层的接口调这两个函数（见 server/core/deletion-rules.ts），财务加载时登记
registerFinanceDeletionRules({ retainedFinanceReferences, deletedFinanceSource });
