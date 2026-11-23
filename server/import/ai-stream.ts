import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, openEventStream, watchDisconnect } from '../core/index.js';
import { AiConnectionError } from '../ai/index.js';
import { AI_HTTP_TIMEOUT_MS, type AiProgress } from '../../shared/ai/index.js';

/**
 * 调模型的请求怎么回：stream=false 等结果回 JSON；stream=true 用事件流（写法在 server/core/http/stream.ts），
 * 先推一条“连接中”，进度按阶段节流，最后推 result 或 error。连接断了（页面关掉、取消）调 abort 停掉模型调用。
 * 识别导入的几条识别地址都用它。
 */
export type AiReply<T> = {
  stream: boolean;
  run: (progress?: (p: AiProgress) => void) => Promise<T>;
  /** 推送里 error 事件的内容（给人看的话、错误码、错误档案编号） */
  failure: (error: unknown) => Record<string, unknown>;
  /** 不推送时出错：记错误档案后照常抛出 */
  onError?: (error: unknown) => void;
  abort?: () => void;
  timeoutMs?: number;
};

/** 给人看的失败说明：自己的错误和接口错误原样说，结构不对说 schemaText，别的说 fallback */
export function aiFailureMessage(error: unknown, schemaText: string, fallback: string) {
  return error instanceof AppError || error instanceof AiConnectionError
    ? error.message
    : error instanceof ZodError
      ? schemaText
      : fallback;
}

export async function replyAi<T>(req: Request, res: Response, reply: AiReply<T>) {
  const timeoutMs = reply.timeoutMs ?? AI_HTTP_TIMEOUT_MS;
  const abort = () => reply.abort?.();
  if (!reply.stream) {
    req.setTimeout(timeoutMs);
    res.setTimeout(timeoutMs);
    const release = watchDisconnect(res, abort);
    try {
      res.json(await reply.run());
    } catch (error) {
      reply.onError?.(error);
      throw error;
    } finally {
      release();
    }
    return;
  }
  const stream = openEventStream(req, res, { timeoutMs, onLost: abort, latest: { progress: (p: AiProgress) => p.stage } });
  const started = Date.now();
  stream.send('progress', { stage: 'connecting', receivedChars: 0, elapsedMs: 0 });
  try {
    stream.end('result', await reply.run((p) => stream.send('progress', { ...p, elapsedMs: Date.now() - started })));
  } catch (error) {
    stream.end('error', reply.failure(error));
  }
}
