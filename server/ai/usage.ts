export type ProviderTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};
export function providerTokenUsage(raw: any): ProviderTokenUsage | undefined {
  const num = (v: unknown) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const inputTokens = num(raw?.input_tokens ?? raw?.prompt_tokens),
    outputTokens = num(raw?.output_tokens ?? raw?.completion_tokens),
    totalTokens = num(raw?.total_tokens);
  return inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
    ? undefined
    : { inputTokens, outputTokens, totalTokens };
}
