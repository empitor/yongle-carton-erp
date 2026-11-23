import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { DAY_MS } from '../../../shared/core/index.js';
import type { Store } from './db.js';
import { AppError } from '../http/errors.js';
import { inSavepoint } from './savepoint.js';
import { rows } from '../schema/rows.js';
import { exists, one, parseStoredJson } from './sqlite/sql.js';

/**
 * 防重复提交记录（operation_requests）：同一个请求号再提交时（网络断了重试、连点两下），返回上次的结果，不重复办。
 * 每个模块用自己的 kind 区分。表归基础，读写都调这里，不直接读写这张表。
 * digest 是请求内容的摘要（同一个请求号换了内容要拒绝），result 是已经转成 JSON 文字的结果，created_at 是记下的时间。
 * 这张表只做防重复：过了保留期的每天清掉（purgeOperationRequests），要长期留的东西不要放这里。
 * 请求号按账号分开（kind + 账号 + 请求号）：别的账号用同一个请求号是另一个请求，互不影响；
 * 同一个账号同一个请求号换了内容才拒绝。
 */

/** 一次带请求号的提交（operationRequest 生成）：摘要在生成时算好，之后请求内容再变也不影响 */
export type OperationRequest = {
  readonly kind: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly digest: string;
};

/** 同一个账号的同一个请求号换了内容（带会话的还有换了会话）时的说法，409 */
export const REQUEST_REUSED = '同一请求凭据已用于不同内容，请核对后重新打开操作窗口。';

/** 内容的摘要：sha256(JSON) */
const requestDigest = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

/**
 * 生成一次带请求号的提交。actor 是提交的账号（本机管理员就是它登录的超级管理员账号），摘要由请求内容算；
 * session 只给要超级管理员模式或本机管理员才能办的动作（数据管理编辑、识别工作区管理、删除），换了会话也算换了内容。
 */
export function operationRequest(
  kind: string,
  requestId: string,
  actor: { id: string },
  input: unknown,
  session?: string,
): OperationRequest {
  return { kind, actorId: actor.id, requestId, digest: requestDigest({ session, input }) };
}

/** 这个账号的这个请求号办过没有（不比内容） */
export function requestDone(store: Store, kind: string, actor: { id: string }, requestId: string) {
  return exists(store.db, 'SELECT 1 FROM operation_requests WHERE kind=? AND actor_id=? AND request_id=?', kind, actor.id, requestId);
}

/**
 * 查上次的结果：没办过返回 undefined；办过、内容一样返回上次的结果；内容不一样 409 拒绝。
 * 上次的结果在库里存成 JSON，按 result（结果的结构）校验后交出，不合结构抛 StoredDataError（回 500）。
 * 查和办分不开的才直接用它（办之前还要先做别的校验、失败要另记审计），一般用 onceByRequest。
 */
export function replayRequest<S extends z.ZodType>(store: Store, request: OperationRequest, result: S): z.output<S> | undefined {
  const prior = one(
    store.db,
    rows.operation_requests.pick({ digest: true, result: true }),
    'SELECT digest,result FROM operation_requests WHERE kind=? AND actor_id=? AND request_id=?',
    request.kind,
    request.actorId,
    request.requestId,
  );
  if (!prior) return undefined;
  if (prior.digest !== request.digest) throw new AppError(REQUEST_REUSED, 409);
  return parseStoredJson(result, prior.result, `operation_requests.result（${request.kind} 请求 ${request.requestId}）`);
}

/**
 * 带请求号的写入：办过就照 replayRequest 返回上次的结果（按 result 校验）或拒绝；没办过就在一个保存点里办 write、
 * 把结果和摘要记下来，write 出错整段回滚，不留请求记录。
 */
export function onceByRequest<S extends z.ZodType>(
  store: Store,
  request: OperationRequest,
  write: () => z.output<S>,
  result: S,
): z.output<S> {
  const prior = replayRequest(store, request, result);
  if (prior !== undefined) return prior;
  return inSavepoint(store.db, () => {
    const done = write();
    saveRequest(store, request, done);
    return done;
  });
}

/** 记下办完的结果：onceByRequest 自己会记；查和办分开的，在办的同一个事务里调它 */
export function saveRequest(store: Store, request: OperationRequest, result: unknown) {
  store.db
    .prepare('INSERT INTO operation_requests(kind,actor_id,request_id,digest,created_at,result) VALUES(?,?,?,?,?,?)')
    .run(request.kind, request.actorId, request.requestId, request.digest, new Date().toISOString(), JSON.stringify(result));
}

/** 先占住请求号、办完再写结果的（跨文件和数据库的操作）用它补写结果；只改摘要一致的那条 */
export function updateRequestResult(store: Store, request: OperationRequest, result: unknown) {
  store.db
    .prepare('UPDATE operation_requests SET result=? WHERE kind=? AND actor_id=? AND request_id=? AND digest=?')
    .run(JSON.stringify(result), request.kind, request.actorId, request.requestId, request.digest);
}

/** 防重复提交记录保留多少天：过了这么久，拿同一个请求号重试不再原样返回上次的结果 */
export const OPERATION_REQUEST_KEEP_DAYS = 90;

/** 清掉超过保留期的防重复记录，返回清了几条。 */
export function purgeOperationRequests(store: Store, keepDays = OPERATION_REQUEST_KEEP_DAYS, now = new Date()) {
  const cutoff = new Date(now.getTime() - keepDays * DAY_MS).toISOString();
  return Number(
    store.db.prepare('DELETE FROM operation_requests WHERE created_at<?').run(cutoff).changes,
  );
}
