import { z } from 'zod';
import { previewDigestSchema } from '../core/index.js';

/** 初始化的范围：业务数据、AI 识别工作区、两样都清 */
export const businessResetScope = ['business', 'ai-imports', 'all'] as const;
export type BusinessResetScope = (typeof businessResetScope)[number];
/** 初始化原因最多多少字 */
const RESET_REASON_MAX = 200;
export const businessResetSchema = z.strictObject({
  scope: z.enum(businessResetScope).default('all'),
  reason: z.string().trim().min(1).max(RESET_REASON_MAX).optional(),
});
/** 页面提交的初始化：范围，加上有已结账期间时预览里勾选的结果和摘要 */
export const resetRequestSchema = businessResetSchema.extend({
  clearClosedFinance: z.boolean().optional(),
  financeDigest: previewDigestSchema.optional(),
});
/** 初始化预览的查询参数：范围必填；clearClosedFinance=1 是勾选了“连已结账的一起清” */
export const resetPreviewQuerySchema = z.object({
  scope: z.enum(businessResetScope),
  clearClosedFinance: z.enum(['0', '1']).optional(),
});
/**
 * 初始化预览：各张表现有多少条；页面发起、清业务数据时另说财务（已结账的期间、能不能清、
 * 勾选了没有、范围摘要，提交时带回摘要）
 */
export type ResetPreview = {
  scope: BusinessResetScope;
  tables: Record<string, number>;
  finance?: {
    closed: { period: string; version: number }[];
    allowed: boolean;
    clearClosedFinance: boolean;
    digest: string;
  };
};
/** 初始化办完的结果：清了多少条、几份 AI 工作区、删了几份原件归档；原件归档等外层提交后再删的标 after-commit */
export type ResetResult = {
  scope: BusinessResetScope;
  count: number;
  aiImports?: number;
  archives?: number;
  archiveCleanup?: 'after-commit';
  warnings?: string[];
};
