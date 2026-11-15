import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AiConnectionError } from '../ai/index.js';
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL } from '../../shared/ai/index.js';
import { AppError, FILE_NAME_MAX } from '../core/index.js';
import type { ImportFailureRecord } from '../../shared/import/index.js';
export type { ImportFailureRecord };
export type FailureContext = {
  operation: 'analyze' | 'chat' | 'upload' | 'restart';
  stream?: boolean;
  stage?: string;
  startedAt?: number;
  actor?: { id: string; name: string } | null;
};
/** 失败记录里要用的工作区几项：工作区可能已经删掉、缺字段，都可以没有 */
export type FailureSubject = {
  id?: string;
  fileName?: string;
  fileHash?: string;
  parsed?: { format?: string };
  size?: number;
  revision?: number;
};
/** 操作人名、出错说明、结构问题记几处、问题路径每段多长（文件名和上传时同一个上限 FILE_NAME_MAX） */
const OPERATOR_NAME_MAX = 100;
const SCHEMA_ISSUES_MAX = 30;
const ISSUE_SEGMENT_MAX = 60;
export function safeFailureText(value: string, max = 500) {
  return value
    .replace(/(?:Bearer\s+|sk[-_])[A-Za-z0-9_.-]+/gi, '[凭据已隐藏]')
    .replace(/[\x00-\x1f]/g, ' ')
    .slice(0, max);
}
/** 出错的种类、状态码和给人看的说明 */
function errorFacts(error: unknown) {
  const known = error instanceof AppError || error instanceof AiConnectionError ? error : null;
  const schema = error instanceof ZodError ? error : null;
  return {
    code: known ? known.code : schema ? 'schema' : 'internal',
    httpStatus: known ? known.status : null,
    upstreamStatus: error instanceof AiConnectionError ? (error.upstreamStatus ?? null) : null,
    message: known
      ? safeFailureText(known.message)
      : schema
        ? 'AI响应字段未通过结构校验，未保存识别结果。'
        : '处理失败；未保存不完整结果，请查看阶段与错误编号。',
    schemaIssues: schema
      ? schema.issues.slice(0, SCHEMA_ISSUES_MAX).map((i) => ({
          path: i.path
            .map((p) =>
              String(p)
                .replace(/[^a-zA-Z0-9_-]/g, '')
                .slice(0, ISSUE_SEGMENT_MAX),
            )
            .join('.'),
          code: i.code,
        }))
      : [],
  };
}
/** 哪份文件、什么格式、多大、第几版 */
function subjectFacts(w: FailureSubject) {
  return {
    workspaceId: typeof w.id === 'string' ? w.id : null,
    fileName: safeFailureText(w.fileName || '未知文件', FILE_NAME_MAX),
    fileHash: w.fileHash || null,
    format: w.parsed?.format || null,
    size: w.size || 0,
    revision: w.revision ?? null,
  };
}
export function failureRecord(error: unknown, w: FailureSubject, context: FailureContext): ImportFailureRecord {
  const detail = error instanceof AiConnectionError ? error.diagnostic : undefined;
  const facts = errorFacts(error);
  return {
    id: randomUUID(),
    recordedAt: new Date().toISOString(),
    failedAt: context.operation === 'restart' ? null : new Date().toISOString(),
    ...subjectFacts(w),
    operation: context.operation,
    stage: context.stage || 'validation',
    stream: context.stream ?? null,
    durationMs: context.startedAt ? Math.max(0, Date.now() - context.startedAt) : null,
    operator: context.actor
      ? { id: context.actor.id, name: safeFailureText(context.actor.name, OPERATOR_NAME_MAX) }
      : null,
    // 只接 DeepSeek 官方接口：记录形状不变，写固定值
    provider: { endpoint: DEEPSEEK_BASE_URL, model: DEEPSEEK_MODEL, protocol: 'chat-completions' },
    code: facts.code,
    httpStatus: facts.httpStatus,
    upstreamStatus: facts.upstreamStatus,
    message: facts.message,
    schemaIssues: facts.schemaIssues,
    ...(detail ? { response: detail } : {}),
    historical: context.operation === 'restart',
  };
}
