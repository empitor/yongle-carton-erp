import { DEEPSEEK_MODEL, type DeepSeekThinking } from '../../shared/ai/index.js';
import type { AiTransport } from './transport.js';
import type { ChatMessage } from './chat.js';
import { AiConnectionError } from './errors.js';
import { exchangeChat, note, thinkingFields, userIdFor } from './chat-exchange.js';
import type { ChatHandlers, RawToolCall } from './chat-receiver.js';

/**
 * 原生工具调用的对话（助手用）：请求带 tools、tool_choice 和思考档位，回复是整条助手消息
 * （正文、思考内容、要调的工具）。“模型要调工具”（finish_reason=tool_calls）是正常结束。
 * 工具名映射、参数校验、执行都在调用方；这里不解析 arguments，原样交回。
 *
 * 官方规则（思考模式、工具调用两页和对话接口参数，2026-11 读）：
 * - 请求带 tools 时，以后每次请求都要把历史里每条助手消息的 reasoning_content 原样带上（哪怕那一轮没调工具），
 *   漏了返回 400；不带 tools 的请求里 reasoning_content 会被忽略。最省事的做法是把 assistantMessage 整条追加回去。
 * - 思考模式下 tool_choice 只能 auto 或 none，required 和点名某个函数返回 400，所以这里只给这两种。
 * - 函数名只能用字母、数字、下划线、连字符，最长 128，不能重名。
 * - function.arguments 可能不是合法 JSON，也可能带没定义的参数，执行前必须校验。
 * - 对话中间不能插我们伪造的工具调用消息，可以插 system 消息。
 * - 每个工具调用都要回一条 role:'tool' 的结果（tool_call_id 对上），再请求下一次。
 */
export type ChatTool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
/** 回传给模型的助手消息：原样保留思考内容和工具调用 */
type AssistantToolMessage = {
  role: 'assistant';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: RawToolCall[];
};
export type ToolResultMessage = { role: 'tool'; tool_call_id: string; content: string };
export type ToolChatMessage = ChatMessage | AssistantToolMessage | ToolResultMessage;
export type ToolChatOptions = ChatHandlers & {
  /** 默认 'high'（官方默认）；'off' 关思考 */
  thinking?: DeepSeekThinking;
  /** 默认 auto；none 表示这次不许调工具 */
  toolChoice?: 'auto' | 'none';
  /** 不给就不传 max_tokens，用官方默认；给了夹在 1000～384K（官方上限 393216） */
  maxOutputTokens?: number;
  /** 流式回复这么久没有新内容就断开（助手对话用，见 chat-retry.ts） */
  idleTimeoutMs?: number;
  /** 第一个新内容到之前最长等多久（排队时只有保活行） */
  firstContentTimeoutMs?: number;
  /** 默认 true */
  stream?: boolean;
  userKey?: string;
  title?: boolean;
  onTitle?: (title: string) => void;
};
export type ToolChatResult = {
  /** 原样追加回 messages 的那条助手消息 */
  assistantMessage: AssistantToolMessage;
  /** stop：答完了；tool_calls：要调工具 */
  finishReason: 'stop' | 'tool_calls';
  content: string;
  reasoning: string;
  toolCalls: RawToolCall[];
};

const MAX_OUTPUT_TOKENS = 393_216;
/** 识别的表不用很长的输出：默认上限 16000 */
const FORM_MAX_OUTPUT_TOKENS = 16_000;
/** 调用方的取消信号和别的选项一起传 */
type WithSignal<T> = T & { signal?: AbortSignal };
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
/** 请求前就能看出来的错（工具名不合官方规则、重名）直接抛，免得白花一次请求 */
function checkTools(tools: ChatTool[]) {
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = tool?.function?.name;
    if (tool?.type !== 'function' || typeof name !== 'string' || !NAME.test(name))
      throw new Error(`工具名“${String(name)}”不合 DeepSeek 的规则（字母、数字、下划线、连字符，最长 128）`);
    if (seen.has(name)) throw new Error(`工具名“${name}”重复`);
    seen.add(name);
  }
}

export function toolChatBody(messages: ToolChatMessage[], tools: ChatTool[], options: ToolChatOptions = {}) {
  checkTools(tools);
  const stream = options.stream !== false;
  return {
    model: DEEPSEEK_MODEL,
    messages,
    ...(tools.length ? { tools, tool_choice: options.toolChoice ?? 'auto' } : {}),
    ...thinkingFields(options.thinking ?? 'high'),
    ...(options.maxOutputTokens ? { max_tokens: Math.max(1000, Math.min(MAX_OUTPUT_TOKENS, options.maxOutputTokens)) } : {}),
    ...(options.userKey ? { user_id: userIdFor(options.userKey) } : {}),
    ...(options.title ? { title: { enabled: true } } : {}),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

export async function completeChatTools(
  key: string,
  messages: ToolChatMessage[],
  tools: ChatTool[],
  transport: AiTransport,
  { signal, ...options }: WithSignal<ToolChatOptions> = {},
): Promise<ToolChatResult> {
  const body = toolChatBody(messages, tools, options);
  return exchangeChat(
    key,
    body,
    transport,
    { ...options, signal, okFinish: ['stop', 'tool_calls'], allowToolCalls: tools.length > 0 },
    (turn, done) => {
      if (turn.title) options.onTitle?.(turn.title);
      // 既没有正文也没有工具调用：空回复，按可以重发的失败报（chat-retry.ts）
      if (!turn.content.trim() && !turn.toolCalls.length)
        throw new AiConnectionError('response', 'DeepSeek 返回了空的回复。', 502, { kind: 'empty' });
      const assistantMessage: AssistantToolMessage = {
        role: 'assistant',
        content: turn.content || (turn.toolCalls.length ? null : ''),
        // 开了思考就总带上这个字段（空的也带），回传时不会因为缺字段被 400
        ...(turn.reasoning || (options.thinking ?? 'high') !== 'off' ? { reasoning_content: turn.reasoning } : {}),
        ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {}),
      };
      // 只收 stop、tool_calls 两种结束（上面的 okFinish），别的在交换那一层已经按失败报了
      const finishReason = turn.finish;
      if (finishReason !== 'stop' && finishReason !== 'tool_calls') throw new Error('对话结束原因不在约定的两种里：' + finishReason);
      done();
      return {
        assistantMessage,
        finishReason,
        content: turn.content,
        reasoning: turn.reasoning,
        toolCalls: turn.toolCalls,
      };
    },
  );
}

/** 识别用的“表”：一个工具，参数就是要填的栏目 */
export type FormTool = ChatTool['function'];
export type FormOptions = ChatHandlers & { stream?: boolean; maxOutputTokens?: number };
/**
 * 识别“填表”：只给这一个工具、指定必须调它、不开思考（思考模式下不能指定工具），
 * 交回来的参数解析成对象原样返回，合不合格由调用方按表的 Zod 定义校验。
 * 没调工具或参数不是 JSON 都按“模型输出不合格”报（invalid-json），调用方可以再试一次。
 */
export async function completeChatForm(
  key: string,
  messages: ChatMessage[],
  form: FormTool,
  transport: AiTransport,
  { signal, ...options }: WithSignal<FormOptions> = {},
): Promise<unknown> {
  const body = {
    ...toolChatBody(messages, [{ type: 'function', function: form }], {
      ...options,
      thinking: 'off',
      maxOutputTokens: options.maxOutputTokens ?? FORM_MAX_OUTPUT_TOKENS,
    }),
    tool_choice: { type: 'function', function: { name: form.name } },
  };
  return exchangeChat(
    key,
    body,
    transport,
    { ...options, signal, okFinish: ['stop', 'tool_calls'], allowToolCalls: true },
    (turn, done) => {
      const call = turn.toolCalls.find((c) => c.function.name === form.name);
      if (!call) throw new AiConnectionError('response', '模型没有按表交回识别结果，没有采用。', 422, note('invalid-json', turn.content, key));
      let filled: unknown;
      try {
        filled = JSON.parse(call.function.arguments);
      } catch {
        throw new AiConnectionError('response', '模型交回的表不完整，没有采用。', 422, note('invalid-json', call.function.arguments, key));
      }
      done();
      return filled;
    },
  );
}
