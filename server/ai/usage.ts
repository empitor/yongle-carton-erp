import { z } from 'zod';

export type ProviderTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** 命中上下文硬盘缓存的输入 Token（prompt_cache_hit_tokens） */
  cachedInputTokens?: number;
  reasoningTokens?: number;
};
/**
 * 上游给的 usage：各字段先原样收下（缺了也行），下面逐个认是不是 Token 数；两个明细不是对象的当作没有。
 * zod 4 里 z.unknown() 的栏缺了也报错，所以每栏都写 optional。
 */
const usageSchema = z.object({
  prompt_tokens: z.unknown().optional(),
  completion_tokens: z.unknown().optional(),
  total_tokens: z.unknown().optional(),
  prompt_cache_hit_tokens: z.unknown().optional(),
  prompt_tokens_details: z.object({ cached_tokens: z.unknown().optional() }).catch({}),
  completion_tokens_details: z.object({ reasoning_tokens: z.unknown().optional() }).catch({}),
});
const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
/** DeepSeek Chat Completions 的 usage。 */
export function providerTokenUsage(input: unknown): ProviderTokenUsage | undefined {
  const parsed = usageSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const raw = parsed.data;
  const inputTokens = num(raw.prompt_tokens),
    outputTokens = num(raw.completion_tokens),
    totalTokens = num(raw.total_tokens),
    cachedInputTokens = num(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details.cached_tokens),
    reasoningTokens = num(raw.completion_tokens_details.reasoning_tokens);
  return inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
    ? undefined
    : {
        inputTokens,
        outputTokens,
        totalTokens,
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      };
}

/** 流式时每块都可能带 usage（只有最后一块非空），合并后最终只报一次；失败也保留实际已返回用量。 */
export function usageCollector(onUsage?: (usage: ProviderTokenUsage) => void) {
  let usage: ProviderTokenUsage | undefined;
  let reported = false;
  return {
    capture(raw: unknown) {
      const next = providerTokenUsage(raw);
      if (next)
        usage = {
          ...usage,
          ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)),
        };
    },
    peek: () => usage,
    report() {
      if (usage && !reported) {
        reported = true;
        onUsage?.(usage);
      }
    },
  };
}
