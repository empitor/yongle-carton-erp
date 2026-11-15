import { z } from 'zod';
import { DEEPSEEK_MODEL } from '../../shared/ai/index.js';
import type { ChatReply, ReplyChoice } from './chat-reply.js';

/** 请求的形状：只有白名单参数和计数 */
type RequestShape = {
  stream: boolean;
  maxOutputTokens?: number;
  messageCount: number;
  roles: string[];
  toolCount?: number;
  toolChoice?: string;
  fileCount: number;
  thinking: boolean;
  reasoningEffort?: string;
};
/** 回答的形状：结束原因、有没有工具调用、命中缓存的 Token 数 */
type ResponseShape = { finishReasons?: string[]; toolCalls?: boolean; cacheHitTokens?: number };
export type ProviderDiagnostic = {
  stage: string;
  attempt: number;
  model: string;
  request: RequestShape;
  response?: ResponseShape;
  errorType?: string;
  at: string;
};

const finishReasons = ['stop', 'length', 'tool_calls', 'content_filter', 'insufficient_system_resource', 'aborted'];
const roles = ['system', 'user', 'assistant', 'tool', 'latest_reminder'];
const safeEnum = (v: unknown, allowed: string[]) => (typeof v === 'string' && allowed.includes(v) ? v : 'other');

/** 请求体里要数的几栏；别的（消息正文、文件、密钥）不读 */
const requestBodySchema = z.object({
  stream: z.unknown().optional(),
  max_tokens: z.number().optional().catch(undefined),
  messages: z
    .array(
      z
        .object({
          role: z.unknown().optional(),
          content: z.array(z.object({ type: z.unknown().optional() }).catch({})).optional().catch(undefined),
        })
        .catch({}),
    )
    .catch([]),
  tools: z.array(z.unknown()).optional().catch(undefined),
  tool_choice: z.unknown().optional(),
  thinking: z.object({ type: z.unknown().optional() }).optional().catch(undefined),
  reasoning_effort: z.unknown().optional(),
});
type RequestBody = z.output<typeof requestBodySchema>;
const cacheHitSchema = z.object({ prompt_cache_hit_tokens: z.number() });

function requestShape(body: RequestBody): RequestShape {
  const thinking = body.thinking?.type === 'enabled';
  return {
    stream: body.stream === true,
    maxOutputTokens: body.max_tokens,
    messageCount: body.messages.length,
    roles: body.messages.map((m) => safeEnum(m.role, roles)),
    ...(body.tools ? { toolCount: body.tools.length, toolChoice: safeEnum(body.tool_choice, ['auto', 'none']) } : {}),
    fileCount: body.messages.reduce((n, m) => n + (m.content ?? []).filter((p) => p.type === 'file').length, 0),
    thinking,
    ...(thinking ? { reasoningEffort: safeEnum(body.reasoning_effort, ['low', 'high', 'max']) } : {}),
  };
}

/** 只保留白名单参数、形状和计数；不序列化消息、文件、密钥、上游错误正文或思考。 */
export class ProtocolDiagnostics {
  private body: RequestBody = requestBodySchema.parse({});
  private attempt = 0;
  private response: ResponseShape | undefined;
  constructor(
    private key: string,
    private sink?: (v: ProviderDiagnostic) => void,
  ) {}
  request(body: Record<string, unknown>) {
    this.attempt++;
    this.body = requestBodySchema.parse(body);
    this.response = undefined;
    this.emit('request');
  }
  private choices(choices: ReplyChoice[], part: 'message' | 'delta') {
    const response = (this.response ||= {});
    const reasons = choices.filter((c) => c.finish_reason).map((c) => safeEnum(c.finish_reason, finishReasons));
    if (reasons.length) response.finishReasons = reasons;
    if (choices.some((c) => c[part]?.tool_calls?.length || c[part]?.function_call)) response.toolCalls = true;
    return response;
  }
  private reply(raw: ChatReply, part: 'message' | 'delta') {
    const response = this.choices(raw.choices, part);
    const usage = cacheHitSchema.safeParse(raw.usage);
    if (usage.success) response.cacheHitTokens = usage.data.prompt_cache_hit_tokens;
  }
  /** 整包回答 */
  result(raw: ChatReply) {
    this.reply(raw, 'message');
  }
  /** 流式的一块 */
  chunk(raw: ChatReply) {
    this.reply(raw, 'delta');
  }
  emit(stage: string, errorType?: string) {
    if (!this.sink) return;
    this.sink({
      stage,
      attempt: this.attempt,
      model: DEEPSEEK_MODEL,
      request: requestShape(this.body),
      response: this.response ? structuredClone(this.response) : undefined,
      errorType: errorType && !errorType.includes(this.key) ? errorType : errorType && '[redacted]',
      at: new Date().toISOString(),
    });
  }
}
