// 记一条业务审计（server/core/audit.ts 的 audit）：business_audit 的每一列照传入的写，明细按 JSON 存。内存库、虚构数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audit, viaEntry } from '../server/core/audit.js';
import { Store } from '../server/core/db.js';
import { AUDIT_SOURCE } from '../shared/core/audit-sources.js';
import { pageActor } from './actor-fixture.js';

const NOW = '2026-11-15T03:04:05.678Z';
const maker = pageActor({ id: 'audit-row-fixture', name: '虚构审计员', permissions: [] });

test('记审计：时间、账号、来源、动作、对象、编号照传入的写，明细按 JSON 存，不挂在记录上的编号为空', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const store = new Store(':memory:');
  try {
    const detail = { before: { name: '虚构甲' }, after: { name: '虚构乙' }, reason: '改名' };
    audit(store, maker, { action: 'update', entity: 'customers', id: 7, document: detail });
    audit(store, viaEntry(maker, AUDIT_SOURCE.assistant), { action: 'execute', entity: 'assistant_previews', id: null, document: {} });
    const rows = store.db
      .prepare('SELECT at,actor_id,actor_name,source,action,entity,record_id,document FROM business_audit WHERE actor_id=? ORDER BY rowid')
      .all(maker.id)
      .map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      {
        at: NOW,
        actor_id: maker.id,
        actor_name: maker.name,
        source: AUDIT_SOURCE.page,
        action: 'update',
        entity: 'customers',
        record_id: 7,
        document: JSON.stringify(detail),
      },
      {
        at: NOW,
        actor_id: maker.id,
        actor_name: maker.name,
        source: AUDIT_SOURCE.assistant,
        action: 'execute',
        entity: 'assistant_previews',
        record_id: null,
        document: '{}',
      },
    ]);
  } finally {
    store.close();
  }
});
