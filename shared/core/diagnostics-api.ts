import { z } from 'zod';
import { apiMethods } from './api-table.js';

/*
 * 出错记录的各栏上限和页面上报的接口表（服务端 server/core/diagnostics/：page-problems.ts 收上报，problem-log.ts 记的时候截断）。
 * 表的写法见 api-table.ts。
 */

/**
 * 出错记录每一栏最多存几个字（记的时候打码、截断，页面上报也按它收），堆栈最多留几行。
 * 账号名本来就不超过 60 字（account-input.ts），这里只是兜住记录的大小。
 */
export const PROBLEM_TEXT = {
  account: 60,
  method: 10,
  path: 300,
  operation: 60,
  message: 500,
  reason: 300,
  stackLine: 200,
  stackLines: 5,
  page: 200,
};

/** 状态码最大 599；一次最多报几条 */
const HTTP_STATUS_MAX = 599,
  REPORTS_MAX = 10;
const pageProblemSchema = z.strictObject({
  /** request：请求被拒或出错；network：连不上服务器；script：前端报错；notice：弹过的出错提示 */
  kind: z.enum(['request', 'network', 'script', 'notice']),
  message: z.string().max(PROBLEM_TEXT.message),
  status: z.number().int().min(0).max(HTTP_STATUS_MAX).optional(),
  method: z.enum(apiMethods).optional(),
  path: z.string().max(PROBLEM_TEXT.path).optional(),
  page: z.string().max(PROBLEM_TEXT.page).optional(),
});
/** 页面一次上报的正文：1 到 10 条 */
export const pageProblemsSchema = z.strictObject({ problems: z.array(pageProblemSchema).min(1).max(REPORTS_MAX) });

export type DiagnosticsApi = {
  /** 收下回 202；内容不对只回 { message }（不带 code）。上报的成败不影响页面 */
  'POST /diagnostics/page-problems': { body: z.input<typeof pageProblemsSchema>; response: { ok: true } };
};
