// 只管：管理后台的只读视图——账号列表（accounts.list）、登录记录（accounts.events）和各项设置现在的值（settings.view），都只给超级管理员。
// 数据来自装配时接上的现成对象（ToolServices），返回值逐项挑，不整个展开：不含密码、密钥、Secret、页面凭证，也不给机器人 ID。
import { z } from 'zod';
import type { Actor } from '../../core/index.js';
import { readLoginRecords } from '../../core/index.js';
import { accountLevelNames } from '../../../shared/core/index.js';
import { botStateLabels } from '../../../shared/import/index.js';
import { notConnected, paging, requireSuperAdmin, SHORT_TEXT_CHARS, timeText, type ToolContext, type ToolReader } from './context.js';

/** 事件叫法最多几个字 */
const EVENT_MAX_CHARS = 30;
const eventsSchema = z.strictObject({
  from: timeText.optional(),
  to: timeText.optional(),
  account: z.string().trim().min(1).max(SHORT_TEXT_CHARS).optional(),
  event: z.string().trim().min(1).max(EVENT_MAX_CHARS).optional(),
  ...paging,
});

export const adminViewTools = [
  {
    name: 'accounts.list',
    risk: 'read',
    description: '查账号：名字、级别、是否停用，不含密码。',
    arguments: {},
    schema: z.strictObject({}),
  },
  {
    name: 'accounts.events',
    risk: 'read',
    description:
      '查登录记录：登录成功、失败、被限流，进出超级管理员模式，改密码，账号申请的处理。可按时间、账号、事件叫法筛。',
    arguments: { from: '可省略，2026-11-13', account: '可省略', event: '可省略，如 登录失败', limit: 20 },
    schema: eventsSchema,
  },
  {
    name: 'settings.view',
    risk: 'read',
    description:
      '查各项设置：识别并发数、各家机器人（企业微信、飞书、钉钉）、部署方式和允许的域名、停用的插件和工具，不含密钥。模型和密钥用 ai.status，模板用 documents.templates，提示词用 prompts.get。',
    arguments: {},
    schema: z.strictObject({}),
  },
] as const;

/** 级别叫法和界面同一份（shared/core/accounts.ts） */
const levelNames: Record<string, string> = accountLevelNames;
const missing = '还没接上';

function listAccounts(ctx: ToolContext, _raw: unknown, who: Actor | null | undefined) {
  requireSuperAdmin(who, '账号');
  const rows = (ctx.services.accounts ?? notConnected('账号服务')).listAccounts();
  return {
    共: rows.length,
    列表: rows.map((a) => ({ 名字: a.name, 级别: levelNames[a.level] ?? a.level, 状态: a.disabled ? '已停用' : '正常', 账号编号: a.id })),
  };
}

function loginEvents(ctx: ToolContext, raw: unknown, who: Actor | null | undefined) {
  const db = ctx.services.accountsDb ?? notConnected('账号库');
  const r = readLoginRecords(db, who, eventsSchema.parse(raw ?? {}));
  return {
    共: r.total,
    列表: r.items.map((e) => ({ 时间: e.time, 账号: e.account, 事件: e.event, ...(e.target ? { 处理的账号: e.target } : {}) })),
    还有更多: r.more,
  };
}

function viewSettings(ctx: ToolContext, _raw: unknown, who: Actor | null | undefined) {
  const actor = requireSuperAdmin(who, '设置');
  const { ai, bots, deployment, registry } = ctx.services;
  const aiView = ai?.view(),
    botViews = bots?.views();
  const tools = registry?.view(actor).tools;
  return {
    同时识别几个文件: aiView ? aiView.recognitionConcurrency : missing,
    机器人: botViews
      ? Object.fromEntries(
          botViews.map((v) => [
            v.label,
            { 凭据: v.hasSecret ? '已填写' : '没填', 启用: v.enabled ? '已启用' : '没启用', 连接: botStateLabels[v.status.state] },
          ]),
        )
      : missing,
    部署:
      deployment === undefined
        ? missing
        : deployment
          ? { 方式: '服务器部署，从域名访问', 允许的域名: [...deployment.hosts], 备份另存一份: deployment.backupCopyDir ? '已设置' : '没设置' }
          : { 方式: '本机运行' },
    助手工具: tools
      ? {
          共: tools.length,
          停用的插件: [...new Set(tools.filter((t) => !t.pluginEnabled).map((t) => t.module))],
          停用的工具: tools.filter((t) => t.pluginEnabled && !t.toolEnabled).map((t) => t.name),
        }
      : missing,
  };
}

export const adminViewReaders: Record<string, ToolReader> = {
  'accounts.list': listAccounts,
  'accounts.events': loginEvents,
  'settings.view': viewSettings,
};
