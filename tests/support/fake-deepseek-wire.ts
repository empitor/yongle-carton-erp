/**
 * 假 DeepSeek 的线上格式：收到的请求正文是什么结构、回答怎么编码（JSON 或流式）。
 * 结构只写假服务和测试要读的几栏，别的键原样留着；生产代码发的请求都合这个结构，对不上说明请求发错了。
 */
import { z } from 'zod';

const wireCallSchema = z.looseObject({
  id: z.string().optional(),
  type: z.string().optional(),
  function: z.looseObject({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
});
const contentPartSchema = z.looseObject({
  type: z.string().optional(),
  text: z.string().optional(),
  file_id: z.string().optional(),
});
const messageSchema = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional(),
  /** 官方要求思考模式下回传；不是字符串时假服务按官方回 400，所以这里不限类型 */
  reasoning_content: z.unknown().optional(),
  tool_calls: z.array(wireCallSchema).optional(),
  tool_call_id: z.string().optional(),
});
const toolSchema = z.looseObject({
  type: z.string().optional(),
  function: z
    .looseObject({ name: z.string().optional(), parameters: z.record(z.string(), z.unknown()).optional() })
    .optional(),
});
const uploadSchema = z.object({ name: z.string(), type: z.string(), size: z.number(), bytes: z.instanceof(Buffer) });
/** 各地址的请求正文合在一个结构里：对话、上传（multipart 的字段）、语音、联网各用其中几栏 */
const fakeBodySchema = z.looseObject({
  model: z.string().optional(),
  stream: z.boolean().optional(),
  messages: z.array(messageSchema).optional(),
  tools: z.array(toolSchema).optional(),
  tool_choice: z
    .union([z.string(), z.looseObject({ type: z.string().optional(), function: z.looseObject({ name: z.string().optional() }).optional() })])
    .optional(),
  thinking: z.looseObject({ type: z.string().optional() }).optional(),
  reasoning_effort: z.string().optional(),
  max_tokens: z.number().optional(),
  file: uploadSchema.optional(),
  purpose: z.string().optional(),
  'expires_after[seconds]': z.string().optional(),
  text: z.string().optional(),
  voice_id: z.string().optional(),
  format: z.string().optional(),
  query: z.string().optional(),
  count: z.number().optional(),
  ori_question: z.string().optional(),
  url: z.string().optional(),
});

export type WireMessage = z.output<typeof messageSchema>;
/** 假服务记下的请求正文：JSON 正文，或 multipart 的 { 字段名: 值 }；没有正文时是 {} */
export type FakeBody = z.output<typeof fakeBodySchema>;
/** 对话请求的正文 */
export type ChatBody = FakeBody & { messages: WireMessage[] };

export type FakeCall = {
  path: string;
  method: string;
  url: URL;
  headers: Headers;
  body: FakeBody;
  /** multipart 字段的先后顺序 */
  fields?: string[];
};
export type ChatCall = FakeCall & { body: ChatBody };

export const CHAT_PATH = '/chat/completions';
export const isChatCall = (call: FakeCall): call is ChatCall => call.path === CHAT_PATH && call.body.messages !== undefined;

const isFakeBody = (raw: unknown): raw is FakeBody => fakeBodySchema.safeParse(raw).success;
/** 核对过就用原对象（不用 parse 出来的副本）：测试按原样比对发出去的正文 */
function checkedBody(raw: unknown, path: string): FakeBody {
  if (isFakeBody(raw)) return raw;
  throw new Error(`假 DeepSeek 收到的 ${path} 请求正文不合结构：${String(fakeBodySchema.safeParse(raw).error?.message)}`);
}

async function formBody(form: FormData) {
  const body: Record<string, unknown> = {};
  for (const [name, value] of form.entries())
    body[name] =
      typeof value === 'string'
        ? value
        : { name: value.name, type: value.type, size: value.size, bytes: Buffer.from(await value.arrayBuffer()) };
  return body;
}

/** 读出一次请求：地址、方法、请求头和按结构核对过的正文 */
export async function readCall(request: Request): Promise<FakeCall> {
  const url = new URL(request.url);
  const call = { path: url.pathname, method: request.method, url, headers: request.headers };
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const json: unknown = await request.json();
    return { ...call, body: checkedBody(json, call.path) };
  }
  if (!type.includes('multipart/form-data')) return { ...call, body: {} };
  const form = await request.formData();
  return { ...call, body: checkedBody(await formBody(form), call.path), fields: [...form.keys()] };
}

// ---- 回答的编码 ----

export const jsonResponse = (body: unknown, status = 200, leading = '') =>
  new Response(leading + JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** 分块发的回答；failAfter 给了就只发前几块，然后中途断开 */
export const streamResponse = (chunks: (string | Uint8Array)[], contentType: string, failAfter?: number) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        chunks.forEach((c, i) => {
          if (failAfter !== undefined && i >= failAfter) return;
          controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
        });
        if (failAfter !== undefined) controller.error(new TypeError('terminated'));
        else controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': contentType } },
  );

/** 回复里的一个工具调用；arguments 是字符串就原样发（可以故意给坏 JSON），否则 JSON 化 */
export type NativeToolCall = { name: string; arguments: unknown; id?: string };
export type ReplyParts = {
  content?: string;
  reasoning?: string;
  toolCalls?: NativeToolCall[];
  finish?: string;
  refusal?: string;
  title?: string;
};
export const wireCalls = (calls: NativeToolCall[]) =>
  calls.map((c, i) => ({
    id: c.id ?? `call_fake_${i + 1}`,
    type: 'function' as const,
    function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments) },
  }));
type WireReply = ReturnType<typeof wireCalls>[number];

export const thinkingOn = (body: FakeBody) =>
  body.thinking?.type === 'enabled' || (body.thinking?.type !== 'disabled' && body.reasoning_effort !== 'none');

const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 56 };
type Encoded = {
  parts: ReplyParts;
  content: string;
  reasoning: string;
  calls: WireReply[];
  finish: string;
  model: string | undefined;
  id: string;
  usage: typeof usage & { completion_tokens_details: { reasoning_tokens: number } };
};

function wholeResponse(r: Encoded, thinking: boolean) {
  const { refusal, title } = r.parts;
  const message = {
    role: 'assistant',
    content: r.content || (r.calls.length ? null : ''),
    ...(thinking ? { reasoning_content: r.reasoning } : {}),
    ...(r.calls.length ? { tool_calls: r.calls } : {}),
    ...(refusal ? { refusal } : {}),
    ...(title ? { title } : {}),
  };
  const choice = { index: 0, message, finish_reason: r.finish || null };
  return jsonResponse({ id: r.id, object: 'chat.completion', model: r.model, choices: [choice], usage: r.usage }, 200, '\n\n');
}

const halves = (s: string) => [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))].filter(Boolean);

function streamedResponse(r: Encoded) {
  const { refusal, title } = r.parts;
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null, last = false) =>
    'data: ' +
    JSON.stringify({
      id: r.id,
      object: 'chat.completion.chunk',
      model: r.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage: last ? r.usage : null,
    }) +
    '\n\n';
  const events = [': keep-alive\n\n', chunk({ role: 'assistant', content: '' })];
  for (const part of halves(r.reasoning)) events.push(chunk({ reasoning_content: part }));
  for (const part of halves(r.content)) events.push(chunk({ content: part }));
  r.calls.forEach((c, index) => {
    const [head = '', tail = ''] = halves(c.function.arguments);
    events.push(chunk({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.function.name, arguments: head } }] }));
    if (tail) events.push(chunk({ tool_calls: [{ index, function: { arguments: tail } }] }));
  });
  if (refusal) events.push(chunk({ refusal }));
  if (r.finish) {
    events.push(chunk({ content: '', ...(title ? { title } : {}) }, r.finish, true));
    events.push('data: [DONE]\n\n');
  }
  return streamResponse(events, 'text/event-stream; charset=utf-8');
}

/** 原生回复的返回：非流式一个 JSON；流式时思考、正文各拆两块，每个工具调用第一块带 id/type/name 和半截参数，第二块续另一半 */
export function chatResponse(reply: { content: string; toolCalls: NativeToolCall[]; parts: ReplyParts }, body: FakeBody, id: string) {
  const thinking = thinkingOn(body);
  const reasoning = reply.parts.reasoning ?? (thinking ? '虚构思考：先看清用户要什么，再决定查什么。' : '');
  const calls = wireCalls(reply.toolCalls);
  const encoded: Encoded = {
    parts: reply.parts,
    content: reply.content,
    reasoning,
    calls,
    finish: reply.parts.finish ?? (calls.length ? 'tool_calls' : 'stop'),
    model: body.model,
    id,
    usage: { ...usage, completion_tokens_details: { reasoning_tokens: thinking ? Math.max(1, Math.ceil(reasoning.length / 2)) : 0 } },
  };
  return body.stream ? streamedResponse(encoded) : wholeResponse(encoded, thinking);
}
