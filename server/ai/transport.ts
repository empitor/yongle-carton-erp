import https from 'node:https';
import http from 'node:http';
import { resolvePublicAddress } from './endpoint.js';
import { AiConnectionError } from './connection-error.js';
import { SseParser, type SseEvent } from '../../shared/sse.js';
import type { IncomingMessage } from 'node:http';

export type WireRequest = {
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
  method?: 'GET' | 'POST';
  local: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  onSseEvent?: (event: SseEvent) => void;
};
export type WireResponse = { status: number; body: unknown; streamed?: boolean };
export type AiTransport = (request: WireRequest) => Promise<WireResponse>;

export async function consumeWireResponse(
  res: IncomingMessage,
  options: Pick<WireRequest, 'onSseEvent' | 'maxResponseBytes'>,
): Promise<WireResponse> {
  const status = res.statusCode || 502,
    streamed =
      status >= 200 &&
      status < 300 &&
      !!options.onSseEvent &&
      /text\/event-stream/i.test(String(res.headers['content-type'] || ''));
  const parser = streamed ? new SseParser(options.onSseEvent!) : null,
    decoder = new TextDecoder('utf-8', { fatal: true }),
    chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > (options.maxResponseBytes || 65536))
        throw new AiConnectionError('response', '服务响应过大，已停止请求。', 502);
      if (parser) parser.push(decoder.decode(bytes, { stream: true }));
      else chunks.push(bytes);
    }
    if (parser) {
      parser.push(decoder.decode());
      parser.finish();
      return { status, body: null, streamed: true };
    }
    let body: unknown = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {}
    return { status, body };
  } catch (error) {
    if (error instanceof AiConnectionError) throw error;
    throw new AiConnectionError(
      'response',
      '上游响应或SSE流提前中断、编码不合法或事件不完整，未采用结果。',
      502,
    );
  }
}

// 无重定向、无自动重试、无请求/响应正文日志。凭证不进入 URL。
export const secureTransport: AiTransport = async ({
  url,
  headers,
  body,
  local,
  method = 'POST',
  timeoutMs = 45_000,
  maxResponseBytes = 65536,
  signal,
  onSseEvent,
}) => {
  if (
    local
      ? url.origin !== 'http://127.0.0.1:11434'
      : url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')
  )
    throw new AiConnectionError('endpoint', '传输目标不符合安全规则，已阻止连接。');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const address = local
      ? '127.0.0.1'
      : await new Promise<string>((resolve, reject) => {
          const abort = () =>
            reject(new AiConnectionError('timeout', '解析或连接超时，请稍后重试。', 504));
          controller.signal.addEventListener('abort', abort, { once: true });
          resolvePublicAddress(url.hostname)
            .then(resolve, reject)
            .finally(() => controller.signal.removeEventListener('abort', abort));
        });
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return await new Promise<WireResponse>((resolve, reject) => {
      const req = (local ? http : https).request(
        {
          hostname: address,
          port: local ? 11434 : 443,
          path: url.pathname,
          servername: local ? undefined : url.hostname,
          method,
          agent: false,
          headers: {
            ...headers,
            Host: url.host,
            'Content-Type': 'application/json',
            ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
            Accept: onSseEvent ? 'text/event-stream, application/json' : 'application/json',
          },
          signal: controller.signal,
        },
        (res) => {
          consumeWireResponse(res, { onSseEvent, maxResponseBytes }).then(resolve, (error) => {
            req.destroy();
            reject(error);
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  } catch (error) {
    if (timedOut)
      throw new AiConnectionError(
        'timeout',
        `请求达到本地${timeoutMs / 1000}秒超时，未采用不完整结果。`,
        504,
      );
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    clearTimeout(timer);
  }
};
