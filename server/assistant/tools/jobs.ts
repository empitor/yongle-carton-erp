// 只管：后台在办的事（jobs.status）——识别排队和正在识别的文件、还没交付完的导出、自动备份最近有没有失败。
// 用现成的：AI 设置的排队统计、识别导入的工作区列表、单据导出的 listExports、基础模块的 autoBackupFailure。
import { z } from 'zod';
import type { Actor } from '../../core/index.js';
import { autoBackupFailure, canEnterSuperMode, requirePermission } from '../../core/index.js';
import { listExports } from '../../documents/index.js';
import { REASON_CHARS, clip, type ToolContext, type ToolReader } from './context.js';
import { exportText } from './documents-inbox.js';

export const jobsTools = [
  {
    name: 'jobs.status',
    risk: 'read',
    description:
      '查后台在办的事：识别排队和进行中的文件、没交付完的导出、最近自动备份有没有失败。',
    arguments: {},
    schema: z.strictObject({}),
  },
] as const;

/** 进行中的文件、没交付完的导出最多列几条 */
const LIST_LIMIT = 20;
const taskNames: Record<string, string> = { queued: '排队中', running: '识别中', backoff: '等一会儿重试' };

function jobsStatus(ctx: ToolContext, _raw: unknown, who: Actor | null | undefined) {
  const actor = requirePermission(who, 'business:edit');
  const queue = ctx.services.ai?.workQueue.stats();
  const working = ctx.imports
    ? ctx.imports
        .status()
        .workspaces.filter((w) => taskNames[w.task?.state])
        .slice(0, LIST_LIMIT)
        .map((w) => ({ 文件: w.fileName, 状态: taskNames[w.task.state], 开始时间: w.task.startedAt ?? '' }))
    : '识别导入没有接上';
  const exports = listExports(
    ctx.store,
    { pending: true, actorId: canEnterSuperMode(actor) ? undefined : actor.id },
    { limit: LIST_LIMIT, offset: 0 },
  );
  const backup = autoBackupFailure();
  return {
    识别: {
      排队: queue ? { 正在识别: queue.active, 排队: queue.waiting, 同时最多: queue.limit } : 'AI 设置还没接上',
      进行中的文件: working,
    },
    没交付完的导出: { 共: exports.total, 列表: exports.rows.map(exportText) },
    自动备份: backup ? { 最近一次失败: backup.at, 原因: clip(backup.message, REASON_CHARS) } : '最近没有失败',
  };
}

export const jobsReaders: Record<string, ToolReader> = { 'jobs.status': jobsStatus };
