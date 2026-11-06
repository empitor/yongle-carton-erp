import { createHash } from 'node:crypto';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { audit, requirePermission } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import type { FinancePermission } from '../../shared/finance.js';

export function financeError(message: string, status = 422): never {
  throw new ImportError(message, status);
}

export function financeActor(
  actor: Actor | null | undefined,
  permission: FinancePermission = 'finance:view',
) {
  const viewer = requirePermission(actor, 'finance:view');
  return requirePermission(viewer, permission);
}

export function checkVersion(record: { version?: unknown }, version: number) {
  if (record.version !== version) financeError('记录已更新，请刷新后重试。', 409);
}

export function financeWrite<T, Input extends { requestId: string }>(
  store: Store,
  actor: Actor,
  action: string,
  input: Input,
  work: () => T,
): T {
  const db = store.db;
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT finance_write' : 'BEGIN IMMEDIATE');
  try {
    const prior = db
      .prepare('SELECT * FROM fin_requests WHERE actor_id=? AND request_id=?')
      .get(actor.id, input.requestId);
    let result: T;
    if (prior) {
      if (prior.action !== action || prior.fingerprint !== hash)
        financeError('请求编号已被其他操作使用。', 409);
      result = JSON.parse(String(prior.response)) as T;
    } else {
      result = work();
      db.prepare('INSERT INTO fin_requests VALUES(?,?,?,?,?)').run(
        actor.id,
        input.requestId,
        action,
        hash,
        JSON.stringify(result),
      );
    }
    db.exec(nested ? 'RELEASE finance_write' : 'COMMIT');
    return result;
  } catch (error) {
    db.exec(nested ? 'ROLLBACK TO finance_write; RELEASE finance_write' : 'ROLLBACK');
    throw error;
  }
}

export function financeAudit(
  store: Store,
  actor: Actor,
  action: string,
  entity: string,
  id: number | null,
  before: unknown,
  after: unknown,
) {
  audit(store, actor, 'finance', action, entity, id, { before, after });
}
