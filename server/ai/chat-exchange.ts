import { createHash } from 'node:crypto';
import { AI_REQUEST_TIMEOUT_MS, type DeepSeekThinking } from '../../shared/ai/index.js';
import { MIB } from '../../shared/core/index.js';
import { usageCollector, type ProviderTokenUsage } from './usage.js';
import { AiConnectionError, type AiResponseNote } from './errors.js';
import { openDeepSeek, readShaped, readSse, type AiTransport, type Deadline } from './transport.js';
import { ProtocolDiagnostics } from './protocol-diagnostics.js';
import { chatChunkSchema, chatReplySchema } from './chat-reply.js';
import { ChatReceiver, unrequestedTools, type ChatHandlers, type RawToolCall } from './chat-receiver.js';

/**
 * 对话接口（/chat/completions）的一次往返：发请求、收流或整包、拼正文/思考/工具调用、认结束原因、
 * 报用量和诊断、把各种失败换成给人看的错误。两种对话调用共用它：
 * 识别的“填表”和助手的原生工具调用（都在 chat-tools.ts），各自只管请求体和收尾。
 */
export type ChatTurn = {
  content: string;
  reasoning: string;
  toolCalls: RawToolCall[];
  finish: string;
  title: string;
};
type Exchange = ChatHandlers & {
  /** 哪些结束原因算正常结束 */
  okFinish: readonly string[];
  /** 不允许时收到工具调用直接按协议错误处理 */
  allowToolCalls: boolean;
  /** 给了就按“这么久没有新内容”断开（助手的流式对话）；不给是整次请求 AI_REQUEST_TIMEOUT_MS 的时限 */
  idleTimeoutMs?: number;
  /** 第一个新内容到之前最长等多久（只和 idleTimeoutMs 一起用，见 chat-retry.ts） */
  firstContentTimeoutMs?: number;
  /** 调用方的取消信号 */
  signal?: AbortSignal;
};

const MAX_NOTE_CHARS = 200_000;
/** 一次回答最多读多少 MB：流式整个、整包 */
const REPLY_MEGABYTES = { stream: 8, whole: 4 };
const STREAM_MAX_BYTES = REPLY_MEGABYTES.stream * MIB;
const WHOLE_REPLY_MAX_BYTES = REPLY_MEGABYTES.whole * MIB;
/** 发给 DeepSeek 的账号摘要取 sha256 的前 32 位十六进制 */
const USER_ID_HEX_CHARS = 32;
/** 上游的请求编号只有长得像编号才记进诊断 */
const REQUEST_ID = /^[a-zA-Z0-9_.-]{1,120}$/;

// 已接收文本只用于安全展示；含密钥或为空的片段一律不携带。
const noteText = (text: string, key: string): string | undefined =>
  !text.trim() || text.includes(key) ? undefined : text.slice(0, MAX_NOTE_CHARS);
export const note = (kind: AiResponseNote['kind'], text: string, key: string): AiResponseNote => {
  const safe = noteText(text, key);
  return safe ? { kind, text: safe } : { kind };
};
export const userIdFor = (userKey: string) =>
  'erp-' + createHash('sha256').update('zhixu-erp-user:' + userKey).digest('hex').slice(0, USER_ID_HEX_CHARS);
/**
 * 思考档位 → 请求字段。官方：thinking.type 优先于 reasoning_effort；不写默认开、档位 high；
 * reasoning_effort 只有 none/low/high/max 有实际区别（minimal 归 low，medium、xhigh 归 high，ultra 归 max）。
 */
export const thinkingFields = (level: DeepSeekThinking) =>
  level === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: level };

/** 没正常结束的原因 → 给人看的话。可能已经计费，都不自动重试。 */
function finishError(reason: string, received: string, key: string) {
  if (reason === 'length')
    return new AiConnectionError(
      'response',
      '回复太长被截断了，没有保存不完整的结果。请减少一次的内容后重试。',
      422,
      note('truncated', received, key),
    );
  if (reason === 'content_filter')
    return new AiConnectionError('content_filter', '内容被 DeepSeek 的安全审核拦下，没有生成结果。', 422, { kind: 'refusal' });
  if (reason === 'insufficient_system_resource')
    return new AiConnectionError('upstream', 'DeepSeek 资源紧张，生成中途停了，请稍后重试。', 502, note('incomplete', received, key));
  if (reason === 'aborted')
    return new AiConnectionError('upstream', 'DeepSeek 中断了生成，请重试。', 502, note('incomplete', received, key));
  if (reason === 'tool_calls') return unrequestedTools();
  return new AiConnectionError('response', 'DeepSeek 没有完成这次输出，没有采用为业务数据。', 422, note('incomplete', received, key));
}

/** 流式回答：逐块交给 receiver；连接断在结束原因之前按不完整报 */
async function readStream(response: Response, deadline: Deadline, receiver: ChatReceiver, key: string) {
  await readSse(
    response,
    ({ data }) => {
      if (data.trim() === '[DONE]') return;
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        throw new AiConnectionError('response', 'DeepSeek 返回的流格式不对，没有采用。', 502);
      }
      const event = chatChunkSchema.parse(raw);
      if (event.error) throw new AiConnectionError('upstream', 'DeepSeek 生成过程中出错，请稍后重试。', 502);
      receiver.reply(event, true);
    },
    STREAM_MAX_BYTES,
    deadline,
  );
  if (!receiver.finish)
    throw new AiConnectionError('response', '和 DeepSeek 的连接中途断开，没有采用不完整的结果。', 502, note('incomplete', receiver.content.text, key));
}

/** 收完后核对结束原因和工具调用，交出这一轮 */
function finishTurn(receiver: ChatReceiver, okFinish: readonly string[], key: string): ChatTurn {
  const { finish, content, reasoning } = receiver;
  if (!finish || !okFinish.includes(finish)) throw finishError(finish, content.text, key);
  const toolCalls = receiver.tools.complete(key);
  if (finish === 'tool_calls' && !toolCalls.length)
    throw new AiConnectionError('response', 'DeepSeek 说要调工具，却没有给出工具调用，没有执行。', 422, { kind: 'protocol' });
  receiver.progress('validating');
  content.flush();
  reasoning.flush();
  return { content: content.text, reasoning: reasoning.text, toolCalls, finish, title: receiver.title };
}

/** 发出请求、收完回答（流式或整包），交出这一轮 */
async function receive(transport: AiTransport, key: string, body: Record<string, unknown>, options: Exchange, receiver: ChatReceiver) {
  const stream = body.stream === true;
  receiver.progress('connecting');
  const { response, deadline } = await openDeepSeek(transport, {
    op: 'chat',
    path: '/chat/completions',
    key,
    json: body,
    accept: stream ? 'text/event-stream, application/json' : 'application/json',
    timeoutMs: options.idleTimeoutMs ?? AI_REQUEST_TIMEOUT_MS,
    idle: options.idleTimeoutMs !== undefined,
    firstContentMs: options.firstContentTimeoutMs,
    signal: options.signal,
  });
  receiver.alive = () => deadline.touch();
  try {
    receiver.progress('processing');
    if (stream && /text\/event-stream/i.test(response.headers.get('content-type') || ''))
      await readStream(response, deadline, receiver, key);
    else receiver.reply(await readShaped(response, chatReplySchema, WHOLE_REPLY_MAX_BYTES, deadline), false);
  } finally {
    deadline.close();
  }
  return finishTurn(receiver, options.okFinish, key);
}

/** 处理中抛的错换成给人看的错误，带上结束诊断 */
function failure(error: unknown, receiver: ChatReceiver, tokens: ProviderTokenUsage | undefined) {
  const safe =
    error instanceof AiConnectionError ? error : new AiConnectionError('response', 'DeepSeek 返回的内容处理失败，没有采用。', 502);
  if (safe.code === 'response' || safe.code === 'upstream' || safe.code === 'content_filter') {
    const requestId = receiver.requestId;
    safe.diagnostic ||= {
      event: 'finish',
      reason: receiver.finish || safe.responseNote?.kind || 'unknown',
      ...(requestId && REQUEST_ID.test(requestId) ? { requestId } : {}),
      ...(tokens?.outputTokens !== undefined ? { outputTokens: tokens.outputTokens } : {}),
      ...(tokens?.reasoningTokens !== undefined ? { reasoningTokens: tokens.reasoningTokens } : {}),
      receivedChars: receiver.content.text.length,
    };
  }
  return safe;
}

/** 响应处理失败或未完整结束时，把已安全接收的文字交给调用方决定是否展示 */
function keepReceived(safe: AiConnectionError, received: string, key: string) {
  if (safe.responseNote || !received.trim() || !['response', 'timeout', 'upstream'].includes(safe.code)) return;
  const text = noteText(received, key);
  if (text) safe.responseNote = { kind: 'incomplete', text };
}

/** 发一次对话并收完。finish 不在 okFinish 里就按原因报错；finalize 在同一个错误处理里做收尾（解析等）。 */
export async function exchangeChat<T>(
  key: string,
  body: Record<string, unknown>,
  transport: AiTransport,
  options: Exchange,
  finalize: (turn: ChatTurn, done: () => void) => T,
): Promise<T> {
  const diagnostics = new ProtocolDiagnostics(key, options.onDiagnostic);
  const usage = usageCollector(options.onUsage);
  const receiver = new ChatReceiver(key, options, usage, diagnostics);
  try {
    diagnostics.request(body);
    const turn = await receive(transport, key, body, options, receiver);
    return finalize(turn, () => diagnostics.emit('complete'));
  } catch (error) {
    const safe = failure(error, receiver, usage.peek());
    diagnostics.emit('error', safe.responseNote?.kind ? safe.code + ':' + safe.responseNote.kind : safe.code);
    keepReceived(safe, receiver.content.text, key);
    throw safe;
  } finally {
    usage.report();
  }
}
