import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { audit, inSavepoint, onceByRequest, operationRequest, requirePermission } from '../../core/index.js';
import { AppError } from '../../core/index.js';
import type { FinancePermission } from '../../../shared/core/index.js';
import type { financeAuditActions, financeAuditEntities } from '../../../shared/finance/index.js';
import { financeFacts } from '../../flow/index.js';

/** 审计的动作、对象只能是中文名表里有的（修改记录页按表显示中文，类型检查保证每个取值都有名字） */
type FinanceAuditAction = keyof typeof financeAuditActions;
type FinanceAuditEntity = keyof typeof financeAuditEntities;

export function financeError(message: string, status = 422): never {
  throw new AppError(message, status);
}

export function financeActor(
  actor: Actor | null | undefined,
  permission: FinancePermission = 'finance:view',
) {
  const viewer = requirePermission(actor, 'finance:view');
  return requirePermission(viewer, permission);
}

/** 写往来、发票、票据、保证金、收付款时取一个往来单位的名称（业务的只读窗口），找不到报错 */
export function requirePartyName(db: DatabaseSync, kind: 'customer' | 'supplier', id: number | string): string {
  const name = financeFacts.parties.names(db, kind, [id]).get(id);
  if (name === undefined) financeError('往来单位不存在。', 404);
  return name;
}

export function checkVersion(record: { version?: unknown }, version: number) {
  if (record.version !== version) financeError('记录已更新，请刷新后重试。', 409);
}

/**
 * 财务的一次写入：action 是哪种操作，input 是校验过的提交内容（带请求号），
 * result 是结果的结构（同一个请求号再提交时按它读回上次的结果）。
 */
type FinanceWriteRequest<S extends z.ZodType> = {
  action: string;
  input: { requestId: string; [field: string]: unknown };
  result: S;
};

export function financeWrite<S extends z.ZodType>(
  store: Store,
  actor: Actor,
  request: FinanceWriteRequest<S>,
  work: () => z.output<S>,
): z.output<S> {
  const { action, input, result } = request;
  // 财务的写入都记成一种：同一个账号的同一个编号换了操作也算换了内容
  return financeTransaction(store.db, () =>
    onceByRequest(store, operationRequest('finance', input.requestId, actor, { action, input }), work, result),
  );
}

/**
 * 在一个写事务里办 work，出错整段回滚：已经在别的事务里就在其中开一个保存点；不在时用 BEGIN IMMEDIATE，一开始就拿写锁
 */
export function financeTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return inSavepoint(db, work);
  db.exec('BEGIN IMMEDIATE');
  try {
    const done = work();
    db.exec('COMMIT');
    return done;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 一条财务审计：动作、对象、编号，改之前和改之后 */
type FinanceAuditRecord = {
  action: FinanceAuditAction;
  entity: FinanceAuditEntity;
  id: number | null;
  before: unknown;
  after: unknown;
};

export function financeAudit(store: Store, actor: Actor, record: FinanceAuditRecord) {
  audit(store, actor, {
    action: record.action,
    entity: record.entity,
    id: record.id,
    document: { before: record.before, after: record.after },
  });
}
