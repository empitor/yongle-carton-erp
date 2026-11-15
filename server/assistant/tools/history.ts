// 只管：记录的修改历史和关联记录（history.records）。按记录查和界面“关联记录与修改历史”窗口是同一个函数（recordContext），
// 按人、按时间段查用 auditTrail，只给超级管理员。返回的键都是中文，修改内容按修改历史那一套写成中文（historyView）。
import { z } from 'zod';
import type { Actor } from '../../core/index.js';
import { AppError } from '../../core/index.js';
import { auditTrail, recordContext } from '../../business/index.js';
import { DAY_MS, dateSchema } from '../../../shared/core/index.js';
import { dataManagementModules, flowStatusText, historyActionName, historyView, recordNames, type HistoryRefs } from '../../../shared/business/index.js';
import { clip, paging, positive, requireSuperAdmin, SHORT_TEXT_CHARS, type ToolContext, type ToolReader } from './context.js';

/** 两种查法：按记录，或按时间段（可加人） */
const HOW_TO_QUERY = '按记录查传 module 和 id；按人、按时间查传 from 和 to（YYYY-MM-DD），可加 person';

const historySchema = z
  .strictObject({
    module: z.enum(dataManagementModules).optional(),
    id: positive.optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    person: z.string().trim().min(1).max(SHORT_TEXT_CHARS).optional(),
    ...paging,
  })
  .refine((v) => (v.module ? !!v.id : !!v.from && !!v.to), HOW_TO_QUERY);

export const historyTools = [
  {
    name: 'history.records',
    risk: 'read',
    description:
      '查修改历史：谁什么时候改了什么。传 module 和 id 查一条记录的关联单据和修改历史；传 from/to（北京时间，含两头）、可加 person，按时间段查。',
    arguments: { module: 'orders', id: 1, from: '或改传 2026-11-01', to: '2026-11-13', person: '可省略', limit: 20, offset: 0 },
    schema: historySchema,
  },
] as const;

const flowModules = new Set(['arrival', 'task', 'production', 'delivery']);
const moduleName = (module: string) => recordNames[module] ?? module;
/** 单据的审计挂在 flow_<模块> 上 */
const FLOW_ENTITY = 'flow_';
const moduleOfEntity = (entity: string) => (entity.startsWith(FLOW_ENTITY) ? entity.slice(FLOW_ENTITY.length) : entity);
/** 每条修改最多给几个字；关联记录最多列几条 */
const CHANGE_CHARS = 200;
const RELATED_MAX = 50;
/** 北京时间那天零点的审计时间（审计存的是 UTC 的 ISO 时间） */
const dayStart = (date: string, plusDays = 0) =>
  new Date(Date.parse(date + 'T00:00:00+08:00') + plusDays * DAY_MS).toISOString();

type Entry = { at: unknown; actorName: unknown; action: unknown; sourceLabel: string; detail: unknown };
function historyText(h: Entry, module: string, refs: HistoryRefs, recordId?: number) {
  const view = historyView({ module, action: String(h.action), detail: h.detail, recordId }, refs);
  return {
    时间: String(h.at),
    谁: String(h.actorName),
    从哪改的: h.sourceLabel,
    动作: historyActionName(String(h.action)),
    改了什么: view.items.map((i) => clip(i.label + '：' + i.value, CHANGE_CHARS)),
    ...(view.note ? { 说明: view.note } : {}),
  };
}

function readHistory(ctx: ToolContext, raw: unknown, who: Actor | null | undefined) {
  const v = historySchema.parse(raw ?? {});
  const { module, id, from, to } = v;
  // 结构上的检查（refine）保证：传了 module 就有 id，没传 module 就有 from 和 to
  if (module && id) {
    // 权限跟着 recordContext：能看这条记录的人就能看它的修改历史，和界面那个窗口同一个判断
    const c = recordContext(ctx.store, module, id, who);
    return {
      记录: moduleName(module) + ' ' + id,
      关联记录: c.related.slice(0, RELATED_MAX).map((r) => ({
        类别: moduleName(r.module),
        编号: r.id,
        名称或单号: r.name ?? '',
        状态: flowModules.has(r.module) ? flowStatusText({ kind: r.module, status: r.status, ...r.view }) : (r.status ?? ''),
        ...(r.archived ? { 已归档: true } : {}),
      })),
      修改历史: {
        共: c.history.length,
        列表: c.history.slice(v.offset, v.offset + v.limit).map((h: Entry) => historyText(h, module, c.historyRefs, id)),
        还有更多: v.offset + v.limit < c.history.length,
      },
      归档和删除会怎样: c.archiveEffect,
    };
  }
  if (!from || !to) throw new AppError(HOW_TO_QUERY);
  requireSuperAdmin(who, '按人、按时间查的修改记录');
  const t = auditTrail(
    ctx.store,
    { from: dayStart(from), to: dayStart(to, 1), actorName: v.person },
    { limit: v.limit, offset: v.offset },
  );
  return {
    时间段: from + ' 到 ' + to + (v.person ? '，' + v.person + ' 改的' : ''),
    共: t.total,
    列表: t.history.map((h) => {
      const module = moduleOfEntity(h.entity);
      return {
        记录: moduleName(module) + (h.recordId ? ' ' + h.recordId : ''),
        ...historyText(h, module, t.historyRefs, h.recordId ?? undefined),
      };
    }),
    还有更多: v.offset + t.history.length < t.total,
  };
}

export const historyReaders: Record<string, ToolReader> = { 'history.records': readHistory };
