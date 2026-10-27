import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './db.js';
import type { ImportManager } from './import/manager.js';
import type { Actor } from './auth.js';
import { requireDeveloper, isLocalAdministrator } from './developer-capability.js';
import { audit } from './business/management.js';
import { ImportError } from './import/errors.js';
export const workspaceCommandSchema = z.strictObject({
  requestId: z.string().uuid(),
  action: z.enum(['fork', 'remove', 'restore', 'purge', 'delete', 'archive', 'open']),
  items: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        revision: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(200),
});
/** 工作区和正式导入归档共用原存储；执行回执防止同一请求重复复制。 */
export async function manageWorkspaces(
  store: Store,
  imports: ImportManager,
  raw: unknown,
  who: Actor,
  binding: string,
) {
  const actor = requireDeveloper(who),
    v = workspaceCommandSchema.parse(raw);
  if (!binding) throw new ImportError('会话无效。', 403);
  if (new Set(v.items.map((r) => r.id)).size !== v.items.length)
    throw new ImportError('重复选择文件。');
  const digest = createHash('sha256')
    .update(JSON.stringify({ actor: actor.id, binding, ...v }))
    .digest('hex');
  const prior = store.db
    .prepare(
      "SELECT digest,result FROM operation_requests WHERE kind='workspace-management' AND request_id=?",
    )
    .get(v.requestId);
  if (prior) {
    if (prior.digest !== digest) throw new ImportError('请求编号已用于其他内容。', 409);
    const saved = JSON.parse(String(prior.result));
    if (saved.pending)
      throw new ImportError(
        '上次工作区操作仍在执行或结果待核对，请先查询实际任务；不能重复复制或清理。',
        409,
        'uncertain-operation',
      );
    return saved;
  }
  // 跨文件/数据库操作不能共用SQLite事务；先记录待核验状态，重启后禁止盲目重放。
  store.db
    .prepare('INSERT INTO operation_requests VALUES(?,?,?,?)')
    .run(
      'workspace-management',
      v.requestId,
      digest,
      JSON.stringify({ pending: true, items: v.items, action: v.action }),
    );
  const results = [];
  for (const item of v.items) {
    try {
      const result =
        v.action === 'open'
          ? await imports.openArchivedWorkspace(item.id, actor)
          : v.action === 'delete'
            ? await imports.deleteWorkspace(item.id, item.revision, actor)
            : v.action === 'archive'
              ? imports.archiveWorkspace(
                  item.id,
                  item.revision ?? imports.get(item.id).revision,
                  actor,
                )
              : v.action === 'fork'
                ? await imports.developerFork(item.id, actor)
                : v.action === 'restore'
                  ? isLocalAdministrator(actor)
                    ? await imports.restoreWorkspace(item.id, actor)
                    : await imports.restore(item.id)
                  : v.action === 'purge'
                    ? await imports.developerPurge(item.id, actor)
                    : await imports.remove(item.id, {
                        expectedRevision: item.revision,
                        acknowledged: true,
                      });
      results.push({ id: item.id, success: true, result });
    } catch (e) {
      results.push({
        id: item.id,
        success: false,
        message: e instanceof Error ? e.message : '操作失败',
      });
    }
  }
  try {
    for (const row of results)
      audit(store, actor, 'local-administrator', v.action, 'ai-workspace', null, {
        id: row.id,
        success: row.success,
        resultId: (row as any).result?.id,
        requestId: v.requestId,
      });
  } catch {
    throw new ImportError(
      '工作区文件可能已完成操作，但审计未保存，结果待核验；请查询实际任务，不能重复复制或清理。',
      409,
      'uncertain-operation',
    );
  }
  const response = {
    results,
    message: results.map((r) => r.id + '：' + (r.success ? '已' + v.action : r.message)).join('；'),
  };
  store.db
    .prepare(
      "UPDATE operation_requests SET result=? WHERE kind='workspace-management' AND request_id=? AND digest=?",
    )
    .run(JSON.stringify(response), v.requestId, digest);
  return response;
}
