import { z } from 'zod';
import type { Store } from '../core/index.js';
import type { ImportManager } from '../import/index.js';
import type { Actor } from '../core/index.js';
import { requireLocalAdministrator } from '../core/index.js';
import { audit } from '../core/index.js';
import { AppError, failureMessage } from '../core/index.js';
import { operationRequest, replayRequest, saveRequest, updateRequestResult } from '../core/index.js';
import {
  WORKSPACE_REVISION_MISSING,
  workspaceCommandSchema,
  workspaceResponseSchema,
  type WorkspaceResponse,
} from '../../shared/admin/index.js';

type WorkspaceCommand = z.output<typeof workspaceCommandSchema>;
/**
 * 记下的执行回执：先占住时是“还在办”（pending，带着要办的文件和动作），办完补写成逐份的结果和那句说法。
 * 同一请求再来时按它判断：还在办的拒绝，办完的原样交回。
 */
const savedResult = z.union([z.object({ pending: z.literal(true) }), workspaceResponseSchema]);
/** 一份识别文件办得怎样：打开、复制、归档、恢复给办完以后的识别文件，删除给编号；没办成的写原因 */
type WorkspaceOutcome =
  | { id: string; success: true; result: ReturnType<ImportManager['get']> | { id: string; deleted: true } }
  | { id: string; success: false; message: string };
/** 办完的说法（给助手和页面看的结果，不露动作代码） */
const doneText: Record<WorkspaceCommand['action'], string> = {
  fork: '已复制为新识别任务',
  restore: '已恢复',
  delete: '已删除',
  archive: '已归档',
  open: '已打开',
};

/** 对一份识别文件办这条命令：打开、复制直接办；归档、恢复、删除调识别导入同一套服务，按看到时的版本 */
async function runOne(
  imports: ImportManager,
  action: WorkspaceCommand['action'],
  item: WorkspaceCommand['items'][number],
  actor: Actor,
): Promise<Extract<WorkspaceOutcome, { success: true }>['result']> {
  if (action === 'open') return imports.get(item.id);
  if (action === 'fork') return imports.forkWorkspace(item.id, actor);
  // 改状态的要带版本：命令结构已经拦过（refine），这里按同一句再说一次
  if (item.revision === undefined) throw new AppError(WORKSPACE_REVISION_MISSING);
  const one = { items: [{ id: item.id, version: item.revision }] };
  const [done] = (
    action === 'delete' ? await imports.deleteMany(one, actor) : imports.changeArchive({ action, ...one }, actor)
  ).results;
  if (!done.success) throw new AppError(done.message, 409);
  return action === 'delete' ? { id: item.id, deleted: true } : imports.get(item.id);
}

/**
 * 识别文件的命令（助手的 management.workspaces 用）：归档、恢复、删除调识别导入同一套服务
 * （changeArchive、deleteMany，和 AI 导入页同一条路）；执行回执防止同一请求重复复制。
 */
export async function manageWorkspaces(
  store: Store,
  imports: ImportManager,
  raw: unknown,
  who: Actor,
  binding: string,
): Promise<WorkspaceResponse> {
  const actor = requireLocalAdministrator(who),
    v = workspaceCommandSchema.parse(raw);
  if (!binding) throw new AppError('会话无效。', 403);
  if (new Set(v.items.map((r) => r.id)).size !== v.items.length)
    throw new AppError('重复选择文件。');
  const request = operationRequest('workspace-management', v.requestId, actor, v, binding);
  const saved = replayRequest(store, request, savedResult);
  if (saved !== undefined) {
    if ('pending' in saved)
      throw new AppError(
        '上次工作区操作仍在执行或结果待核对，请先查询实际任务；不能重复复制或清理。',
        409,
        'uncertain-operation',
      );
    return saved;
  }
  // 跨文件/数据库操作不能共用SQLite事务；先记录待核验状态，重启后禁止盲目重放。
  saveRequest(store, request, { pending: true, items: v.items, action: v.action });
  const results: WorkspaceOutcome[] = [];
  for (const item of v.items) {
    try {
      results.push({ id: item.id, success: true, result: await runOne(imports, v.action, item, actor) });
    } catch (e) {
      results.push({
        id: item.id,
        success: false,
        message: failureMessage(e, '识别记录批量管理 ' + v.action + ' ' + item.id, '操作失败'),
      });
    }
  }
  try {
    for (const row of results)
      audit(store, actor, {
        action: v.action,
        entity: 'ai-workspace',
        id: null,
        document: {
          id: row.id,
          success: row.success,
          resultId: row.success ? row.result.id : undefined,
          requestId: v.requestId,
        },
      });
  } catch {
    throw new AppError(
      '工作区文件可能已完成操作，但审计未保存，结果待核验；请查询实际任务，不能重复复制或清理。',
      409,
      'uncertain-operation',
    );
  }
  const response: WorkspaceResponse = {
    results,
    message: results.map((r) => r.id + '：' + (r.success ? doneText[v.action] : r.message)).join('；'),
  };
  updateRequestResult(store, request, response);
  return response;
}
