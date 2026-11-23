/**
 * 假 DeepSeek：实现官方各地址的最小行为，测试里不发任何真实请求。
 * transport 就是 AI 接入模块的传输函数（Request 进、Response 出），不起网络服务。
 * 用法：const { settings, fake } = fakeAiSettings({ chat: (body) => ({ message: '…' }) })
 *
 * 对话只回原生格式（和生产一样，请求都带 tools）。测试给模型替身写回答有几种写法：
 * - 脚本回答 { speaker?, message?, toolCalls?: [{ name, args }], relay? }：这里翻成原生回复（tool_calls、说话人标记），
 *   测试里不用自己拼。这只是测试的写法，生产代码不认它。
 * - 识别“填表”（请求点名必须调某个工具）：直接写填好的表（普通对象），翻成调那个工具。
 * - replyNative({...})、replyText、replyFinish、replyCutOff：指定正文、思考、工具调用、结束原因（'' 表示流式发完就断）。
 * - httpError(状态码) 或 new FakeHttp(() => Response)：直接回一个 HTTP 响应。
 * 请求正文的结构和回答的编码在 fake-deepseek-wire.ts，对话以外的地址在 fake-deepseek-tools.ts。
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { z } from 'zod';
import { AiSettingsManager } from '../../server/ai/settings-manager.js';
import type { AiTransport } from '../../server/ai/transport.js';
import type { ToolChatResult } from '../../server/ai/chat-tools.js';
import {
  CHAT_PATH,
  chatResponse,
  isChatCall,
  jsonResponse,
  readCall,
  streamResponse,
  thinkingOn,
  wireCalls,
  type ChatBody,
  type ChatCall,
  type FakeBody,
  type FakeCall,
  type NativeToolCall,
  type ReplyParts,
  type WireMessage,
} from './fake-deepseek-wire.js';
import { toolResponse, type FakeFile, type FakeToolOptions } from './fake-deepseek-tools.js';

export const fakeKey = 'sk-fictional-deepseek-test-only';
const aes = randomBytes(32);
/** 测试用的加密：不走 Windows DPAPI 或 Linux 主密钥。 */
export const testProtector = {
  protect(s: string) {
    const iv = randomBytes(12),
      c = createCipheriv('aes-256-gcm', aes, iv),
      bytes = Buffer.concat([c.update(s), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), bytes]).toString('base64');
  },
  unprotect(s: string) {
    const b = Buffer.from(s, 'base64'),
      c = createDecipheriv('aes-256-gcm', aes, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString();
  },
};

// ---- 回复 ----

/** 一条原生回复；finish 默认有工具调用时是 tool_calls，否则 stop；'' 表示流式发完内容就断开、没有结束块 */
export class NativeReply {
  readonly content: string;
  readonly toolCalls: NativeToolCall[];
  constructor(readonly parts: ReplyParts = {}) {
    this.content = parts.content ?? '';
    this.toolCalls = parts.toolCalls ?? [];
  }
}
export const replyNative = (parts: ReplyParts) => new NativeReply(parts);
export const replyText = (content: string) => new NativeReply({ content });
export const replyFinish = (finish: string, content = '') => new NativeReply({ content, finish });
export const replyCutOff = (content: string) => new NativeReply({ content, finish: '' });
/** 直接回一个 HTTP 响应（错误码、中途断开等） */
export class FakeHttp {
  constructor(readonly response: () => Response) {}
}
export const httpError = (status: number, body: unknown = { error: { message: 'fictional upstream error' } }) =>
  new FakeHttp(() => jsonResponse(body, status));

/** 走命令目录时执行命令的通用工具（server/assistant/command-directory.ts 的 commandTools） */
const RUN_COMMAND = 'run_command';
/** 注册表工具名 → 原生函数名（和 server/assistant/chat/model-tools.ts 的 modelToolName 一样） */
const toolName = (name: string) => name.replace(/\./g, '__');
/** 正文里的说话人标记；不认识的说话人不加 */
const speakerLine = (speaker: unknown) => (speaker === 'le' ? '【小勒】\n' : speaker === 'yong' ? '【小甬】\n' : '');
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;
const isScript = (reply: unknown): reply is Record<string, unknown> => isPlain(reply) && ('toolCalls' in reply || 'message' in reply);
const listOf = (v: unknown): unknown[] => z.array(z.unknown()).catch([]).parse(v);
const field = (v: unknown, key: string): unknown => (isPlain(v) ? v[key] : undefined);

/** 请求点名必须调的函数（识别“填表”）；没点名返回 undefined */
export const forcedFunction = (body: FakeBody) =>
  typeof body.tool_choice === 'object' && body.tool_choice.type === 'function' ? String(body.tool_choice.function?.name) : undefined;
/** 这次请求点名必须调的工具和请求里有的函数名 */
type Asked = { forced: string; declared: ReadonlySet<string | undefined> };
const askedBy = (body: FakeBody): Asked => ({
  forced: forcedFunction(body) ?? '',
  declared: new Set((body.tools ?? []).map((t) => t.function?.name)),
});

/** 走命令目录的请求里只有三个通用工具：脚本里写的命令翻成 run_command（脚本直接写通用工具名的照原样） */
function scriptCalls(reply: Record<string, unknown>, declared: Asked['declared']): NativeToolCall[] {
  return listOf(reply.toolCalls).map((c) => {
    const name = String(field(c, 'name') ?? ''),
      args = field(c, 'args') ?? {};
    return declared.has(toolName(name)) || !declared.has(RUN_COMMAND)
      ? { name: toolName(name), arguments: args }
      : { name: RUN_COMMAND, arguments: { name, args } };
  });
}
/** 测试给的回答 → 原生回复：点名要填的表直接当参数，脚本回答翻成工具调用，字符串当正文，别的 JSON 化后当正文 */
function toNative(reply: unknown, asked: Asked): NativeReply {
  if (reply instanceof NativeReply) return reply;
  if (asked.forced && isPlain(reply) && !isScript(reply)) return new NativeReply({ toolCalls: [{ name: asked.forced, arguments: reply }] });
  if (!isScript(reply)) return new NativeReply({ content: typeof reply === 'string' ? reply : JSON.stringify(reply) });
  const toolCalls = scriptCalls(reply, asked.declared);
  const message = typeof reply.message === 'string' ? reply.message : '';
  // 接力：另起一段，以另一位的标记开头
  const relay = listOf(reply.relay)
    .map((r) => '\n\n' + speakerLine(field(r, 'speaker')) + String(field(r, 'message') ?? ''))
    .join('');
  return new NativeReply({ content: message ? speakerLine(reply.speaker) + message + relay : '', toolCalls });
}

/** completeChatTools 只交回这两种结束原因（别的生产代码在 chat-tools.ts 里先抛错） */
function chatFinish(native: NativeReply, calls: number): ToolChatResult['finishReason'] {
  const finish = native.parts.finish ?? (calls ? 'tool_calls' : 'stop');
  if (finish === 'stop' || finish === 'tool_calls') return finish;
  throw new Error('对话结束原因不在约定的两种里：' + finish);
}

/**
 * 测试直接替换 settings.completeChatTools 时用：把脚本回答（或 replyNative(...)）变成那个方法要返回的结果。
 * 不认识的回答（纯文字等）当成正文。
 */
export function scriptedResult(reply: unknown, tools: readonly { function: { name: string } }[]): ToolChatResult {
  const asked = { forced: '', declared: new Set(tools.map((t) => t.function.name)) };
  const native = reply instanceof NativeReply || isScript(reply) ? toNative(reply, asked) : new NativeReply({ content: typeof reply === 'string' ? reply : '' });
  const toolCalls = wireCalls(native.toolCalls);
  const reasoning = native.parts.reasoning ?? '';
  return {
    assistantMessage: {
      role: 'assistant',
      content: native.content || (toolCalls.length ? null : ''),
      reasoning_content: reasoning,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    finishReason: chatFinish(native, toolCalls.length),
    content: native.content,
    reasoning,
    toolCalls,
  };
}

// ---- 读请求的小工具（模型替身按请求内容回答时用） ----

/** 一条消息里的文字：字符串，或内容块里的第一段文字（带附件的用户消息） */
export const messageText = (m: { content?: WireMessage['content'] } | undefined): string =>
  typeof m?.content === 'string' ? m.content : (m?.content?.find((p) => p.type === 'text')?.text ?? '');
/** 一条消息的内容块（带附件的用户消息）；内容是纯文字时是空的 */
export const contentParts = (m: { content?: WireMessage['content'] } | undefined) => (Array.isArray(m?.content) ? m.content : []);
type WithMessages = { messages: readonly WireMessage[] };
/**
 * 模型替身按“这一轮刚开始还是已经调过工具”分别回答时用：这次请求是这一轮第一次问模型
 * （用户这句话和服务器上下文之后还没有助手消息）就返回用户这句话，否则返回 null。
 */
export function freshUserText(body: WithMessages): string | null {
  const list = body.messages;
  const context = list.findLastIndex((m) => m.role === 'user');
  if (context < 0 || list.slice(context).some((m) => m.role === 'assistant')) return null;
  return messageText(list[context]).startsWith('服务器当前上下文') ? messageText(list[context - 1]) : messageText(list[context]);
}
const failedResultSchema = z.looseObject({ ok: z.literal(false), message: z.unknown() });
/**
 * 这一轮里最近一次调用没做成时，服务器交给模型的原因（最后一条工具结果是 ok:false 的 message，或者之后服务器说明有调用没有执行的那句）；
 * 做成了返回 null。模型替身拿它当回答（真模型会用自己的话转述），测试借此核对原因确实交到了模型手里。
 */
export function turnFailure(body: WithMessages): string | null {
  const list = body.messages;
  const outcome = list
    .slice(list.findLastIndex((m) => m.role === 'user') + 1)
    .findLast((m) => m.role === 'tool' || (m.role === 'system' && messageText(m).startsWith('服务器：这几个调用没有执行')));
  if (!outcome) return null;
  if (outcome.role === 'system') return messageText(outcome);
  try {
    const result = failedResultSchema.safeParse(JSON.parse(messageText(outcome)));
    return result.success ? String(result.data.message) : null;
  } catch {
    // 工具结果不是 JSON：不算“没做成”
    return null;
  }
}
const commandName = (args: string | undefined) => field(JSON.parse(args || '{}'), 'name');
/** 一组消息里某个工具最近一次的结果（JSON 解析后的值）；没有返回 undefined */
function resultIn(messages: readonly WireMessage[], name: string): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    // 调用编号在各条助手消息之间会重复：取这条结果前面最近的那条助手消息里的调用
    const asked = messages
      .slice(0, i)
      .flatMap((x) => x.tool_calls ?? [])
      .findLast((c) => c.id === m.tool_call_id);
    const called = asked?.function?.name === RUN_COMMAND ? commandName(asked.function.arguments) : asked?.function?.name;
    if (called === name || called === toolName(name)) return JSON.parse(messageText(m));
  }
  return undefined;
}
/** 助手发给模型的请求里，某个工具最近一次的结果（就是模型看到的那一份，JSON 解析后的值）。calls 是假 DeepSeek 记下的请求。 */
export function toolResultSent(calls: readonly { body: { messages?: readonly WireMessage[] } }[], name: string): unknown {
  for (const call of [...calls].reverse()) {
    const found = resultIn(call.body.messages ?? [], name);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ---- 官方规则 ----

const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const builtin = ['deepseek_web_search', 'deepseek_read_url'];
/** 请求里的函数名；不合规或重名时返回官方的错误 */
function functionNames(body: ChatBody): Set<string> | string {
  const names = new Set<string>();
  for (const tool of body.tools ?? []) {
    if (builtin.includes(tool.type ?? '')) continue;
    const name = tool.function?.name;
    if (tool.type !== 'function' || name === undefined || !NAME.test(name)) return 'Invalid function name';
    if (names.has(name)) return 'Duplicate function name';
    names.add(name);
  }
  return names;
}
function choiceError(body: ChatBody, names: Set<string>): string | null {
  const choice = body.tool_choice;
  if (thinkingOn(body) && choice !== undefined && choice !== 'auto' && choice !== 'none')
    return 'tool_choice must be auto or none in thinking mode';
  if (typeof choice === 'object' && (choice.type !== 'function' || !names.has(choice.function?.name ?? '')))
    return 'tool_choice names a function that is not in tools';
  return null;
}
function messagesError(body: ChatBody, names: Set<string>): string | null {
  const open = new Set<string>();
  let afterToolCall = false;
  for (const m of body.messages) {
    if (m.role === 'tool') {
      if (!open.delete(m.tool_call_id ?? '')) return 'tool message without a matching tool_call_id';
      continue;
    }
    if (open.size) return 'tool messages missing for previous tool_calls';
    if (m.role !== 'assistant') continue;
    const calls = m.tool_calls ?? [];
    if (calls.length) afterToolCall = true;
    // 官方：带 tools 时历史助手消息都要回传 reasoning_content；假服务从第一次工具调用起检查（更严的情形由探测脚本核对）
    if (afterToolCall && thinkingOn(body) && typeof m.reasoning_content !== 'string')
      return 'The reasoning_content in the thinking mode must be passed back to the API.';
    for (const c of calls) {
      if (!c.id || c.type !== 'function' || !names.has(c.function?.name ?? '')) return 'Invalid tool_calls in assistant message';
      open.add(c.id);
    }
  }
  return null;
}
/** 官方会 400 的几种请求：工具名不合规或重名、思考模式下 tool_choice 不是 auto/none、tool 消息对不上、思考内容没回传 */
export function nativeRequestError(body: ChatBody): string | null {
  const names = functionNames(body);
  if (typeof names === 'string') return names;
  return choiceError(body, names) ?? messagesError(body, names);
}

// ---- 假服务 ----

export type FakeChat = (body: ChatBody, call: ChatCall) => unknown | Promise<unknown>;
type FakeOptions = FakeToolOptions & { key?: string; chat?: FakeChat };

const missingFile = (body: ChatBody, files: Map<string, FakeFile>) =>
  body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'file' && !files.has(p.file_id ?? '')));

async function answerChat(call: FakeCall, options: FakeOptions, files: Map<string, FakeFile>, id: () => number) {
  if (call.body.model !== 'deepseek-flash') return jsonResponse({ error: { message: 'Model Not Exist' } }, 400);
  if (!isChatCall(call)) return jsonResponse({ error: { message: 'messages is required' } }, 400);
  const body = call.body;
  if (missingFile(body, files)) return jsonResponse({ error: { message: 'file not found' } }, 400);
  const invalid = body.tools ? nativeRequestError(body) : null;
  if (invalid) return jsonResponse({ error: { message: invalid, type: 'invalid_request_error' } }, 400);
  const reply = options.chat ? await options.chat(body, call) : { message: '已查询到服务器实际结果。', toolCalls: [] };
  if (reply instanceof FakeHttp) return reply.response();
  // { cutOff: '半句' }：流式发完这半句就断，和 replyCutOff 一样（预览实例经 JSON 排回复时用）
  const cutOff = field(reply, 'cutOff');
  return chatResponse(typeof cutOff === 'string' ? replyCutOff(cutOff) : toNative(reply, askedBy(body)), body, 'chatcmpl-fake-' + id());
}

export function fakeDeepSeek(options: FakeOptions = {}) {
  const key = options.key ?? fakeKey;
  const calls: FakeCall[] = [];
  const files = new Map<string, FakeFile>();
  const queued = new Map<string, (Response | (() => Response))[]>();
  let seq = 0;
  const state = { files, nextId: () => ++seq };
  /** 给某个地址排一次指定的返回（错误码、中途断开、保活空行等） */
  const next = (path: string, response: Response | (() => Response)) => {
    queued.set(path, [...(queued.get(path) ?? []), response]);
  };
  const transport: AiTransport = async (request) => {
    const call = await readCall(request);
    calls.push(call);
    if (call.url.origin !== 'https://api.deepseek.com') return jsonResponse({ error: { message: 'wrong host' } }, 404);
    if (key !== '*' && request.headers.get('authorization') !== 'Bearer ' + key)
      return jsonResponse({ error: { message: 'Authentication Fails', type: 'authentication_error' } }, 401);
    const waiting = queued.get(call.path) ?? (call.path.startsWith('/files/') ? queued.get('/files/:id') : undefined);
    const planned = waiting?.shift();
    if (planned) return typeof planned === 'function' ? planned() : planned;
    if (call.path === CHAT_PATH && call.method === 'POST') return answerChat(call, options, files, state.nextId);
    return toolResponse(call, options, state);
  };
  return {
    key,
    transport,
    calls,
    files,
    next,
    chatCalls: () => calls.filter(isChatCall),
    /** 吐一半就断的流 */
    brokenStream: (chunks: string[], keep: number) => () => streamResponse(chunks, 'text/event-stream', keep),
  };
}

/** 存好假密钥的设置管理器，配上假 DeepSeek；wrap 在假 DeepSeek 前面插一层（拦住、改写、记下取消） */
export function fakeAiSettings(options: FakeOptions & { file?: string; saveKey?: boolean; wrap?: (t: AiTransport) => AiTransport } = {}) {
  const fake = fakeDeepSeek(options);
  const transport = options.wrap ? options.wrap(fake.transport) : fake.transport;
  // 助手对话自动重发前的等待（server/ai/chat-retry.ts）在测试里不等
  const settings = new AiSettingsManager({ protector: testProtector, transport, file: options.file, retryDelay: async () => {} });
  if (options.saveKey !== false && !settings.view().hasKey)
    settings.saveKey({ apiKey: fake.key, expectedRevision: settings.view().revision });
  return { settings, fake };
}
