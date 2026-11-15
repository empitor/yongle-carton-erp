// 只管：AI 接入的状况（ai.status）——密钥在不在、上次检查结果、现在的余额、最近的识别失败、最近七天助手的用量。
// 都用现成的：AI 设置的 view()/balance()（设置页同一份，不含密钥和页面凭证）、识别导入的失败记录（失败档案页同一个函数）。
import { z } from 'zod';
import type { Actor, Store } from '../../core/index.js';
import { canEnterSuperMode, many, requirePermission, rows } from '../../core/index.js';
import type { AiSettingsManager } from '../../ai/index.js';
import { BUSINESS_TIME_ZONE, DAY_MS, errorMessage } from '../../../shared/core/index.js';
import { REASON_CHARS, clip, notConnected, paging, uuid, type ToolContext, type ToolReader } from './context.js';

const aiStatusSchema = z.strictObject({ workspaceId: uuid.optional(), ...paging });

export const aiStatusTools = [
  {
    name: 'ai.status',
    risk: 'read',
    description:
      '查 AI 接入状况：模型、密钥保存没有、上次检查结果、余额、最近的识别失败（可按 workspaceId）、最近七天助手调用量。识别一直失败、连不上模型时先查它。',
    arguments: { workspaceId: '可省略，只看这份识别的失败', limit: 10, offset: 0 },
    schema: aiStatusSchema,
  },
] as const;

const checkNames: Record<string, string> = {
  missing: '还没填写密钥',
  saved: '保存后还没检查',
  ok: '可以使用',
  'low-balance': '余额不足',
  invalid: '密钥不对',
  failed: '连不上',
};
const operationNames: Record<string, string> = { analyze: '识别', chat: '对话', upload: '上传文件', restart: '程序重启时中断' };
/** 北京时间的日期 */
const beijingDay = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: BUSINESS_TIME_ZONE });

/** 看最近几天的用量；余额查询出错的说明最多给几个字 */
const USAGE_DAYS = 7;
const BALANCE_ERROR_CHARS = 200;
/** 一轮的用量：预算里 providerUsage 的三个累计数，早先没记预算的轮次是空 */
const usageToken = z.number().nullable();
const usageRow = rows.assistant_runs
  .pick({ created_at: true, state: true })
  .extend({ inputTokens: usageToken, outputTokens: usageToken, cachedInputTokens: usageToken });

/** 最近七天助手每天的调用：每一轮的用量记在 assistant_runs 的预算里（budget.providerUsage）。 */
function assistantUsage(store: Store) {
  const since = new Date(Date.now() - USAGE_DAYS * DAY_MS).toISOString();
  const days = new Map<string, { 轮数: number; 失败: number; 输入: number; 输出: number; 缓存命中: number }>();
  const runs = many(
    store.db,
    usageRow,
    "SELECT created_at,state,json_extract(document,'$.budget.providerUsage.inputTokens') AS inputTokens," +
      "json_extract(document,'$.budget.providerUsage.outputTokens') AS outputTokens," +
      "json_extract(document,'$.budget.providerUsage.cachedInputTokens') AS cachedInputTokens FROM assistant_runs WHERE created_at>=?",
    since,
  );
  for (const r of runs) {
    const day = beijingDay(r.created_at),
      d = days.get(day) ?? { 轮数: 0, 失败: 0, 输入: 0, 输出: 0, 缓存命中: 0 };
    d.轮数++;
    if (r.state === 'failed') d.失败++;
    d.输入 += r.inputTokens ?? 0;
    d.输出 += r.outputTokens ?? 0;
    d.缓存命中 += r.cachedInputTokens ?? 0;
    days.set(day, d);
  }
  return [...days].sort(([a], [b]) => b.localeCompare(a)).map(([日期, d]) => ({ 日期, ...d }));
}

async function balanceText(ai: AiSettingsManager) {
  try {
    const b = await ai.balance();
    return {
      够不够用: b.available ? '够用' : '余额不足',
      明细: b.balances.map((x) => ({ 币种: x.currency, 总余额: x.total, 赠送: x.granted, 充值: x.toppedUp })),
      查询时间: b.checkedAt,
    };
  } catch (error) {
    return { 查询失败: clip(errorMessage(error), BALANCE_ERROR_CHARS) };
  }
}

async function aiStatus(ctx: ToolContext, raw: unknown, who: Actor | null | undefined) {
  const actor = requirePermission(who, 'business:edit');
  const v = aiStatusSchema.parse(raw ?? {});
  const ai = ctx.services.ai ?? notConnected('AI 设置');
  // 余额和设置页“查余额”一样只给超级管理员：现查会对外发请求，还会改全员共用的“上次检查”。
  // 超级管理员先现查，查完“上次检查”就是这一次的结果；别的账号只看上次检查的结果
  const balance = !canEnterSuperMode(actor)
    ? '只有超级管理员能查余额；下面的“上次检查”是最近一次检查的结果'
    : ai.view().hasKey
      ? await balanceText(ai)
      : '没有密钥，查不了余额';
  const s = ai.view();
  const failures = ctx.imports?.failures(v.workspaceId, v.offset);
  return {
    模型: s.model,
    密钥: s.hasKey ? '已保存' + (s.keySavedAt ? '（' + s.keySavedAt + ' 保存）' : '') : '还没保存',
    ...(s.storageError ? { 密钥问题: s.storageError } : {}),
    上次检查: {
      结果: checkNames[s.check.state] ?? s.check.state,
      说明: s.check.message,
      时间: s.check.checkedAt ?? '还没检查过',
    },
    余额: balance,
    最近识别失败: failures
      ? {
          共: failures.total,
          列表: failures.items.slice(0, v.limit).map((f) => ({
            时间: f.recordedAt,
            文件: f.fileName,
            操作: operationNames[f.operation] ?? f.operation,
            哪一步: f.stage,
            错误码: f.code,
            原因: clip(f.message, REASON_CHARS),
            操作人: f.operator?.name ?? '没有记录',
          })),
          还有更多: v.offset + Math.min(v.limit, failures.items.length) < failures.total,
        }
      : '识别导入没有接上',
    最近七天助手用量: { 单位: '模型按 Token 计的用量', 按天: assistantUsage(ctx.store) },
  };
}

export const aiStatusReaders: Record<string, ToolReader> = { 'ai.status': aiStatus };
