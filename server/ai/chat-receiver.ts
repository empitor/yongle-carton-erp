import type { AiProgress } from '../../shared/ai/index.js';
import { MIB } from '../../shared/core/index.js';
import { AiConnectionError } from './errors.js';
import type { ChatReply, ReplyChoice, ReplyPart, ToolCallChunk } from './chat-reply.js';
import type { ProtocolDiagnostics, ProviderDiagnostic } from './protocol-diagnostics.js';
import type { ProviderTokenUsage, usageCollector } from './usage.js';

/** 收一次对话回答：拼正文、思考、工具调用，记结束原因、请求编号、标题，边收边报进度。 */
export type ChatHandlers = {
  onUsage?: (usage: ProviderTokenUsage) => void;
  onDiagnostic?: (event: ProviderDiagnostic) => void;
  onProgress?: (event: AiProgress) => void;
  /** 正文增量（已扣住可能是密钥开头的尾巴） */
  onTextDelta?: (text: string) => void;
  /** 思考内容增量（同样扣住尾巴）；只有开了思考才有 */
  onReasoningDelta?: (text: string) => void;
};
/** 模型要调的一个工具：arguments 是模型生成的原文，可能不是合法 JSON，调用方先校验 */
export type RawToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export const MAX_CONTENT_CHARS = MIB;
const MAX_REASONING_CHARS = 2 * MIB;
const MAX_TOOL_CALLS = 128;
const TITLE_MAX_CHARS = 80;

export const unrequestedTools = () =>
  new AiConnectionError('response', 'DeepSeek 返回了没有请求的工具调用，没有执行。', 422, { kind: 'protocol' });
const unsafeOutput = () => new AiConnectionError('response', '模型输出不安全或过大，已拒绝。', 422);

/** 边收边交给回调的文字：超长、含密钥就拒绝；扣住可能是密钥开头的尾巴，最后再交。 */
function textSink(key: string, limit: number, emit?: (text: string) => void) {
  let all = '',
    pending = '';
  return {
    get text() {
      return all;
    },
    add(part: string) {
      all += part;
      pending += part;
      if (all.length > limit || pending.includes(key)) throw unsafeOutput();
      const safe = Math.max(0, pending.length - key.length + 1);
      if (safe) emit?.(pending.slice(0, safe));
      pending = pending.slice(safe);
    },
    flush() {
      if (pending) emit?.(pending);
      pending = '';
    },
  };
}

/** 流式的 tool_calls 按 index 拼：第一块带 id、type、name，后面的块只续 arguments；整包回复直接是完整的。 */
function toolCallSink() {
  /** 编号可能跳着来，没到的位置是空的，收完由 complete() 拦下 */
  const calls: (RawToolCall | undefined)[] = [];
  return {
    chars: () => calls.reduce((n, c) => n + (c?.function.arguments.length ?? 0), 0),
    add(chunk: ToolCallChunk) {
      const index = chunk.index !== undefined && Number.isSafeInteger(chunk.index) ? chunk.index : calls.length;
      if (index < 0 || index >= MAX_TOOL_CALLS)
        throw new AiConnectionError('response', 'DeepSeek 返回的工具调用太多或编号不对，没有执行。', 422, { kind: 'protocol' });
      const call = (calls[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (chunk.id) call.id = chunk.id;
      if (chunk.function.name !== undefined) call.function.name += chunk.function.name;
      if (chunk.function.arguments !== undefined) call.function.arguments += chunk.function.arguments;
    },
    /** 收完后核对每个调用都齐全、不含密钥、不超长，交出完整的调用 */
    complete(key: string): RawToolCall[] {
      const done: RawToolCall[] = [];
      for (const call of calls)
        if (!call || !call.id || !call.function.name)
          throw new AiConnectionError('response', 'DeepSeek 返回的工具调用不完整，没有执行。', 422, { kind: 'protocol' });
        else if (call.function.arguments.includes(key) || call.function.arguments.length > MAX_CONTENT_CHARS)
          throw unsafeOutput();
        else done.push(call);
      return done;
    },
  };
}

type Collector = ReturnType<typeof usageCollector>;
type ReceiverOptions = Pick<ChatHandlers, 'onProgress' | 'onTextDelta' | 'onReasoningDelta'> & { allowToolCalls: boolean };

export class ChatReceiver {
  readonly content: ReturnType<typeof textSink>;
  readonly reasoning: ReturnType<typeof textSink>;
  readonly tools = toolCallSink();
  /** 结束原因；还没收到是空 */
  finish = '';
  requestId: string | undefined;
  title = '';
  /** 收到了正文、思考或工具调用的增量：空闲计时重新开始（保活注释行不到这里，不算有动静） */
  alive = () => {};
  private readonly started = Date.now();
  constructor(
    key: string,
    private readonly options: ReceiverOptions,
    private readonly usage: Collector,
    private readonly diagnostics: ProtocolDiagnostics,
  ) {
    this.content = textSink(key, MAX_CONTENT_CHARS, options.onTextDelta);
    this.reasoning = textSink(key, MAX_REASONING_CHARS, options.onReasoningDelta);
  }
  progress(stage: AiProgress['stage']) {
    this.options.onProgress?.({
      stage,
      receivedChars: this.content.text.length + this.tools.chars(),
      ...(this.reasoning.text ? { reasoningChars: this.reasoning.text.length } : {}),
      elapsedMs: Date.now() - this.started,
    });
  }
  /** 一块（流式，每个 choice 都收）或整包回答（只收第一个 choice） */
  reply(reply: ChatReply, streaming: boolean) {
    this.requestId ||= reply.id;
    this.usage.capture(reply.usage);
    if (streaming) this.diagnostics.chunk(reply);
    else this.diagnostics.result(reply);
    for (const c of streaming ? reply.choices : reply.choices.slice(0, 1)) this.choice(c, streaming);
  }
  private choice(c: ReplyChoice, streaming: boolean) {
    const part = (streaming ? c.delta : c.message) ?? {};
    this.refuse(part);
    this.take(part);
    if (part.title !== undefined) this.title = part.title.slice(0, TITLE_MAX_CHARS);
    if (c.finish_reason) this.finish = String(c.finish_reason);
  }
  /** 没请求的工具调用、审核拦下的直接按失败报 */
  private refuse(part: ReplyPart) {
    if (part.function_call || (part.tool_calls?.length && !this.options.allowToolCalls)) throw unrequestedTools();
    if (part.refusal)
      throw new AiConnectionError('content_filter', '内容被 DeepSeek 的安全审核拦下，没有生成结果。', 422, { kind: 'refusal' });
  }
  private take(part: ReplyPart) {
    if (part.reasoning_content) {
      this.alive();
      this.reasoning.add(part.reasoning_content);
      this.progress('thinking');
    }
    if (part.content) {
      this.alive();
      this.content.add(part.content);
      this.progress('receiving');
    }
    if (part.tool_calls?.length) {
      this.alive();
      for (const t of part.tool_calls) this.tools.add(t);
      this.progress('receiving');
    }
  }
}
