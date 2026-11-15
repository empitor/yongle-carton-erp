import type { AuditSource } from '../../shared/core/index.js';
import type { Actor } from './actor.js';
import type { Store } from './db.js';

/** 一条审计记什么：动作、哪种记录、哪一条（不挂在某条记录上的写 null）、改前改后等明细 */
interface AuditEntry {
  action: string;
  entity: string;
  id: number | null;
  document: unknown;
}

/**
 * 业务审计（business_audit）：各模块的写操作办完都记一条，修改历史、财务操作记录按它展示。
 * 来源照账号上入口标的记（Actor.source），服务不自己写来源。
 */
export function audit(store: Store, actor: Actor, { action, entity, id, document }: AuditEntry) {
  store.db
    .prepare(
      'INSERT INTO business_audit(at,actor_id,actor_name,source,action,entity,record_id,document) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      new Date().toISOString(),
      actor.id,
      actor.name,
      actor.source,
      action,
      entity,
      id,
      JSON.stringify(document),
    );
}

/** 入口给账号标上来源（助手、数据管理），服务拿这个账号办事，审计就记成这个来源。没登录的原样返回。 */
export function viaEntry<T extends Actor | null | undefined>(actor: T, source: AuditSource): T {
  return actor ? { ...actor, source } : actor;
}

/** 永久删除留的墓碑：谁、什么时候删了什么，给审计和“已永久删除”提示用；编号不复用由 AUTOINCREMENT 保证，不靠这张表。 */
export function rememberDeletedRecord(
  store: Store,
  actor: Actor,
  entity: string,
  row: { id: number; number?: string; name?: string },
  at = new Date().toISOString(),
) {
  store.db
    .prepare('INSERT OR REPLACE INTO permanent_record_deletions(entity,record_id,deleted_at,actor_id,label) VALUES(?,?,?,?,?)')
    .run(
      entity,
      row.id,
      at,
      actor.id,
      row.number || row.name || String(row.id),
    );
}
