import type { z } from 'zod';
import { DEEPSEEK_BASE_URL } from '../../shared/ai/index.js';
import { SseParser, type SseEvent } from '../../shared/core/index.js';
import {
  AiConnectionError,
  badResponse,
  cancelledError,
  deepSeekError,
  networkError,
  timeoutError,
  type DeepSeekOperation,
} from './errors.js';

/**
 * 发给 DeepSeek 的唯一出口：标准 Request 进、标准 Response 出。正式运行用 Node 自带的 fetch，
 * 测试换成假 DeepSeek（tests/fake-deepseek.ts）。地址写死成官方地址，不跟随跳转、不记请求和响应正文。
 */
export type AiTransport = (request: Request) => Promise<Response>;
export const deepSeekTransport: AiTransport = (request) => fetch(request);
/** 小的 JSON 回答（报错正文、文件、余额）最多读 64 KB */
export const SMALL_JSON_BYTES = 65_536;

/**
 * 合并调用方的取消和本地超时，事后分得清是哪一个。正文读完之前都要用同一个 signal。
 * idle：按“这么久没有新内容”算，不按整次请求多长算。什么算新内容由调用方定、收到时调 touch：
 * 对话是正文、思考、工具调用的增量（chat-exchange.ts）；服务端排队时发的保活注释行不算，光来保活行到点照样断开。
 * firstMs：第一个新内容到之前单独的时限（排队时只有保活行，要等得比 idle 久）；第一次 touch 以后换成 timeoutMs。
 */
export class Deadline {
  readonly signal: AbortSignal;
  private controller = new AbortController();
  private timer!: ReturnType<typeof setTimeout>;
  private timedOut = false;
  /** 现在这一段的时限：还没收到内容时是 firstMs，之后是 timeoutMs */
  private current: number;
  constructor(
    readonly timeoutMs: number,
    private outer?: AbortSignal,
    private idle = false,
    firstMs?: number,
  ) {
    this.signal = this.controller.signal;
    this.current = idle && firstMs ? firstMs : timeoutMs;
    this.arm();
    if (outer?.aborted) this.controller.abort();
    outer?.addEventListener('abort', this.cancel, { once: true });
  }
  private cancel = () => this.controller.abort();
  private arm() {
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, this.current);
  }
  /** 收到了真正的新内容：空闲计时重新开始（不是空闲计时的不动） */
  touch() {
    if (!this.idle || this.timedOut) return;
    clearTimeout(this.timer);
    this.current = this.timeoutMs;
    this.arm();
  }
  /** 把读写过程中抛出的错换成给人看的错误。 */
  error(error: unknown): AiConnectionError {
    if (this.timedOut) return timeoutError(this.current, this.idle);
    if (this.outer?.aborted) return cancelledError();
    if (error instanceof AiConnectionError) return error;
    return networkError(error);
  }
  close() {
    clearTimeout(this.timer);
    this.outer?.removeEventListener('abort', this.cancel);
  }
}

export type DeepSeekCall = {
  op: DeepSeekOperation;
  path: string;
  method?: 'GET' | 'POST' | 'DELETE';
  key: string;
  json?: unknown;
  form?: FormData;
  accept?: string;
  timeoutMs: number;
  /** timeoutMs 按“这么久没有新内容”算（助手的流式对话） */
  idle?: boolean;
  /** 第一个新内容到之前的时限（只和 idle 一起用） */
  firstContentMs?: number;
  signal?: AbortSignal;
};

/**
 * 发出请求，拿到 2xx 的响应头就返回（正文由调用方按格式读）；不是 2xx 就读一点正文分类后抛出。
 * 返回的 deadline 要在正文读完后 close()。
 */
export async function openDeepSeek(transport: AiTransport, call: DeepSeekCall) {
  const deadline = new Deadline(call.timeoutMs, call.signal, call.idle, call.firstContentMs);
  try {
    deadline.signal.throwIfAborted();
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + call.key,
      Accept: call.accept || 'application/json',
    };
    if (call.json !== undefined) headers['Content-Type'] = 'application/json';
    const request = new Request(DEEPSEEK_BASE_URL + call.path, {
      method: call.method || (call.json !== undefined || call.form ? 'POST' : 'GET'),
      headers,
      body: call.json !== undefined ? JSON.stringify(call.json) : call.form,
      redirect: 'error',
      signal: deadline.signal,
    });
    const response = await transport(request);
    if (response.status < 200 || response.status >= 300) {
      const body = await readJson(response, SMALL_JSON_BYTES, deadline).catch(() => null);
      throw deepSeekError(response.status, body, call.op);
    }
    return { response, deadline };
  } catch (error) {
    const safe = deadline.error(error);
    deadline.close();
    throw safe;
  }
}

/** 读完正文后释放超时计时（成功、失败都释放）。 */
export async function closeAfter<T>(deadline: Deadline, job: () => Promise<T>) {
  try {
    return await job();
  } finally {
    deadline.close();
  }
}

/** 读完整正文，超过上限就停下并断开。 */
export async function readLimited(response: Response, maxBytes: number, deadline: Deadline): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AiConnectionError('response', 'DeepSeek 返回的内容过大，已停止接收。', 502);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    throw deadline.error(error);
  }
}

/** 读 JSON 正文。等待时服务端会先发空行保活，去掉首尾空白再解析；读不出 JSON 返回 null。 */
export async function readJson(response: Response, maxBytes: number, deadline: Deadline): Promise<unknown> {
  const text = (await readLimited(response, maxBytes, deadline)).toString('utf8').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 读 JSON 正文并按约定的结构核对，不合约定就按“返回的内容格式不对”报错 */
export async function readShaped<T>(
  response: Response,
  schema: z.ZodType<T>,
  maxBytes: number,
  deadline: Deadline,
): Promise<T> {
  const parsed = schema.safeParse(await readJson(response, maxBytes, deadline));
  if (!parsed.success) badResponse();
  return parsed.data;
}

/** 逐条交出 SSE 事件；`: keep-alive` 这种注释行由 SseParser 跳过。 */
export async function readSse(
  response: Response,
  onEvent: (event: SseEvent) => void,
  maxBytes: number,
  deadline: Deadline,
) {
  if (!response.body) throw new AiConnectionError('response', 'DeepSeek 没有返回内容。', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parser = new SseParser(onEvent);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new AiConnectionError('response', 'DeepSeek 返回的内容过大，已停止接收。', 502);
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.finish();
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof AiConnectionError) throw error;
    const safe = deadline.error(error);
    if (safe.code === 'network')
      throw new AiConnectionError('response', '和 DeepSeek 的连接中途断开，没有采用不完整的结果。', 502, { kind: 'incomplete' });
    throw safe;
  }
}
