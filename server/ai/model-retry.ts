import { ZodError } from 'zod';
import { AiConnectionError } from './errors.js';
import { AppError } from '../core/index.js';

/**
 * 模型偶尔会交回不合格的表（没调工具、参数不是 JSON、栏目不合格），这和文件内容无关，再调一次通常就好。
 * 只重试“模型输出不合格”，不重试网络、限流、配额和取消，这些有各自的处理。
 */
export function isBadModelOutput(error: unknown) {
  if (error instanceof ZodError) return true;
  if (error instanceof AppError) return error.code === 'model-schema';
  return error instanceof AiConnectionError && error.code === 'response' && error.responseNote?.kind === 'invalid-json';
}

export async function retryBadModelOutput<T>(
  job: () => Promise<T>,
  signal?: AbortSignal,
  attempts = 2,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await job();
    } catch (error) {
      if (attempt >= attempts || signal?.aborted || !isBadModelOutput(error)) throw error;
    }
  }
}
