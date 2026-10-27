import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AiConnectionError } from '../ai/connection-error.js';
import { ImportError } from './errors.js';
export type FailureContext = {
  operation: 'analyze' | 'chat' | 'upload' | 'restart';
  stream?: boolean;
  stage?: string;
  startedAt?: number;
  actor?: { id: string; name: string } | null;
};
export function safeFailureText(value: string, max = 500) {
  return value
    .replace(/(?:Bearer\s+|sk[-_])[A-Za-z0-9_.-]+/gi, '[凭据已隐藏]')
    .replace(/[\x00-\x1f]/g, ' ')
    .slice(0, max);
}
export function failureRecord(error: unknown, w: any, context: FailureContext, profile?: any) {
  const known = error instanceof ImportError || error instanceof AiConnectionError;
  const detail = error instanceof AiConnectionError ? error.diagnostic : undefined;
  let endpoint: string | null = null;
  try {
    endpoint = new URL(profile?.endpoint || w?.consentProfile?.endpoint).origin;
  } catch {}
  return {
    id: randomUUID(),
    recordedAt: new Date().toISOString(),
    failedAt: context.operation === 'restart' ? null : new Date().toISOString(),
    workspaceId: typeof w?.id === 'string' ? w.id : null,
    fileName: safeFailureText(w?.fileName || '未知文件', 180),
    fileHash: w?.fileHash || null,
    format: w?.parsed?.format || null,
    size: w?.size || 0,
    revision: w?.revision ?? null,
    operation: context.operation,
    stage: context.stage || 'validation',
    stream: context.stream ?? null,
    durationMs: context.startedAt ? Math.max(0, Date.now() - context.startedAt) : null,
    operator: context.actor
      ? { id: context.actor.id, name: safeFailureText(context.actor.name, 100) }
      : null,
    provider: {
      endpoint,
      model: safeFailureText(profile?.model || w?.consentProfile?.model || '', 160),
      protocol: profile?.apiStyle || w?.consentProfile?.apiStyle || null,
    },
    code: known ? error.code : error instanceof ZodError ? 'schema' : 'internal',
    httpStatus: known ? error.status : null,
    upstreamStatus: error instanceof AiConnectionError ? (error.upstreamStatus ?? null) : null,
    message: known
      ? safeFailureText(error.message)
      : error instanceof ZodError
        ? 'AI响应字段未通过结构校验，未保存草稿。'
        : '处理失败；未保存不完整结果，请查看阶段与错误编号。',
    schemaIssues:
      error instanceof ZodError
        ? error.issues.slice(0, 30).map((i) => ({
            path: i.path
              .map((p) =>
                String(p)
                  .replace(/[^a-zA-Z0-9_-]/g, '')
                  .slice(0, 60),
              )
              .join('.'),
            code: i.code,
          }))
        : [],
    ...(detail ? { response: detail } : {}),
    historical: context.operation === 'restart',
  };
}
export type ImportFailureRecord = ReturnType<typeof failureRecord>;
