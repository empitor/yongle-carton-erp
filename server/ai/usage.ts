export type ProviderTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
};
export function providerTokenUsage(raw: any): ProviderTokenUsage | undefined {
  const num = (v: unknown) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const inputTokens = num(raw?.input_tokens ?? raw?.prompt_tokens),
    outputTokens = num(raw?.output_tokens ?? raw?.completion_tokens),
    totalTokens = num(raw?.total_tokens);
  const cachedInputTokens = num(
      raw?.input_tokens_details?.cached_tokens ??
        raw?.prompt_tokens_details?.cached_tokens ??
        raw?.prompt_cache_hit_tokens,
    ),
    reasoningTokens = num(
      raw?.output_tokens_details?.reasoning_tokens ??
        raw?.completion_tokens_details?.reasoning_tokens,
    );
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

/** 流式usage为该次请求累计快照，合并字段并最终只报一次；失败也保留实际已返回用量。 */
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
    report() {
      if (usage && !reported) {
        reported = true;
        onUsage?.(usage);
      }
    },
  };
}
