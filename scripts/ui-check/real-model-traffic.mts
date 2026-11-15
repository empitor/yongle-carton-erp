// 真实模型实例的上游记录（real-model.mts 用）：对话接口的每次请求记一笔摘要（发了多少字、点没点名工具、开没开思考、回来的用量），
// 测试入口 cut 要的“半路掐断”也在这里。不记正文，报错原文遮掉密钥。
import { z } from 'zod';

/** 一次对话请求的摘要（识别前后对比用）：发了多少字、点没点名工具、开没开思考，回来的用量 */
export type Traffic = {
  status: number;
  ms: number;
  systemChars: number;
  toolChars: number;
  toolChoice: unknown;
  thinking: unknown;
  usage: { input: number; cached: number; output: number; reasoning: number } | null;
  error?: string;
  /** 测试入口 cut 掐断的那次 */
  cut?: boolean;
};
/** 测试入口 cut：接下来 left 次流式对话请求，收到 afterBytes 字节后掐断（像网络中途断开），看程序能不能自动重发接上 */
export type Cuts = { left: number; afterBytes: number };
function cutOff(response: Response, source: ReadableStream<Uint8Array>, afterBytes: number) {
  const reader = source.getReader();
  let sent = 0;
  let broken = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // 先把收到的半截交出去，下一次读再报断开（同一次里报错会把半截一起丢掉）
      if (broken) return controller.error(new TypeError('terminated'));
      const { done, value } = await reader.read();
      if (done) return controller.close();
      if (sent + value.byteLength >= afterBytes) {
        broken = true;
        reader.cancel().catch(() => {});
        controller.enqueue(value.subarray(0, Math.max(1, afterBytes - sent)));
        return;
      }
      sent += value.byteLength;
      controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
/** DeepSeek 回复里的 usage（只取摘要要的几项） */
const usageSchema = z.object({
  prompt_tokens: z.number().nullish(),
  prompt_cache_hit_tokens: z.number().nullish(),
  completion_tokens: z.number().nullish(),
  completion_tokens_details: z.object({ reasoning_tokens: z.number().nullish() }).nullish(),
});
/** 回复正文里最后一份 usage（流式的在最后一块里） */
function lastUsage(text: string) {
  const raw = [...text.matchAll(/"usage"\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\})/g)].at(-1)?.[1];
  if (raw === undefined) return null;
  try {
    const parsed = usageSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const u = parsed.data;
    return { input: u.prompt_tokens ?? 0, cached: u.prompt_cache_hit_tokens ?? 0, output: u.completion_tokens ?? 0, reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0 };
  } catch {
    // 截出来的那段不是完整 JSON：这次不记用量
    return null;
  }
}
/** 对话请求体里摘要要看的几项 */
const chatRequestSchema = z.object({
  stream: z.unknown().optional(),
  messages: z.array(z.object({ role: z.unknown().optional(), content: z.unknown().optional() })).optional(),
  tools: z.unknown().optional(),
  tool_choice: z.unknown().optional(),
  thinking: z.unknown().optional(),
});
async function readChatRequest(request: Request): Promise<z.infer<typeof chatRequestSchema>> {
  try {
    const parsed = chatRequestSchema.safeParse(JSON.parse(await request.clone().text()));
    return parsed.success ? parsed.data : {};
  } catch {
    // 请求体不是 JSON：摘要里这几项按没有记
    return {};
  }
}
/** 上游报错正文里的 error.message；不是这个样子的用原文 */
const upstreamErrorSchema = z.object({ error: z.object({ message: z.unknown().optional() }).nullish() });
function upstreamMessage(text: string) {
  try {
    const parsed = upstreamErrorSchema.safeParse(JSON.parse(text));
    return parsed.success ? String(parsed.data.error?.message ?? text) : text;
  } catch {
    // 报错正文不是 JSON：用原文
    return text;
  }
}
/**
 * 对话接口的每次请求记一笔摘要（不记正文）；回了错误码时留下上游报错原文（遮掉密钥、截短），给探测和对比脚本看。
 * 程序本身不透传上游正文。
 */
export function watchUpstream(send: (request: Request) => Promise<Response>, seen: Traffic[], cuts: Cuts) {
  return async (request: Request) => {
    if (new URL(request.url).pathname !== '/chat/completions') return send(request);
    const key = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const body = await readChatRequest(request);
    const started = Date.now();
    let response = await send(request);
    const source = response.body;
    const cut = cuts.left > 0 && body.stream === true && response.ok && source !== null;
    if (cut) {
      cuts.left--;
      response = cutOff(response, source, cuts.afterBytes);
    }
    const entry: Traffic = {
      status: response.status,
      ms: 0,
      systemChars: (body.messages ?? []).filter((m) => m.role === 'system').reduce((n, m) => n + JSON.stringify(m.content ?? '').length, 0),
      toolChars: JSON.stringify(body.tools ?? []).length,
      toolChoice: body.tool_choice ?? null,
      thinking: body.thinking ?? null,
      usage: null,
      ...(cut ? { cut } : {}),
    };
    seen.push(entry);
    response
      .clone()
      .text()
      .then((text) => {
        entry.ms = Date.now() - started;
        entry.usage = lastUsage(text);
        if (response.status >= 400) {
          const message = upstreamMessage(text);
          entry.error = (key ? message.split(key).join('[密钥已遮掉]') : message).slice(0, 300);
        }
      })
      .catch(() => {});
    return response;
  };
}
