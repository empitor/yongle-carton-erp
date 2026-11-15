// 一句话（一轮）的两条上限和用量记账：整轮超时、步数（最多问模型多少次、最多执行多少个命令，同一个数）。到了上限不由服务器拼话收尾：
// 步数到了，对话主流程再问模型一次、不许调工具，让它自己说明做到哪；超时了这一轮按出错结束。
// 用量（每次请求的输入、命中缓存、输出、思考 token）只记不限，存进运行记录给排查和测试看。
import { z } from 'zod';
import type { AgentBudgetView } from '../../shared/assistant/index.js';
import type { ProviderTokenUsage } from '../ai/index.js';

/** 整轮默认最长 2 小时；一句话默认最多 30 步 */
const DEFAULT_TIMEOUT_MS = 7_200_000;
const DEFAULT_MAX_STEPS = 30;
export const agentBudgetSchema = z.object({
  /** 整轮最长多久；0 是不限 */
  timeoutMs: z
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_TIMEOUT_MS),
  /** 一句话最多问模型多少次，也是最多执行多少个命令（防打转烧钱；超出的命令不执行） */
  maxSteps: z.number().int().min(1).default(DEFAULT_MAX_STEPS),
});
export type AgentBudgetLimits = z.infer<typeof agentBudgetSchema>;
export function agentBudgetConfig(overrides: Partial<AgentBudgetLimits> = {}) {
  const env = process.env.ERP_AGENT_TIMEOUT_MS;
  return Object.freeze(agentBudgetSchema.parse({ ...(env === undefined ? {} : { timeoutMs: Number(env) }), ...overrides }));
}

export class AgentExecutionBudget {
  private started = Date.now();
  private used = { modelCalls: 0, toolCalls: 0 };
  private usage: AgentBudgetView['providerUsage'] = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    calls: [],
  };
  constructor(
    readonly limits: AgentBudgetLimits,
    readonly requestId: string,
    private save: (v: AgentBudgetView) => void = () => {},
  ) {}
  view(): AgentBudgetView {
    return {
      requestId: this.requestId,
      limits: this.limits,
      used: { ...this.used },
      elapsedMs: Date.now() - this.started,
      providerUsage: { ...this.usage, calls: this.usage.calls.map((c) => ({ ...c })) },
    };
  }
  count(kind: keyof AgentExecutionBudget['used']) {
    this.used[kind]++;
    this.save(this.view());
  }
  providerUsage(v: ProviderTokenUsage) {
    this.usage.requests++;
    this.usage.inputTokens += v.inputTokens || 0;
    this.usage.outputTokens += v.outputTokens || 0;
    this.usage.totalTokens += v.totalTokens ?? (v.inputTokens || 0) + (v.outputTokens || 0);
    this.usage.cachedInputTokens += v.cachedInputTokens || 0;
    this.usage.reasoningTokens += v.reasoningTokens || 0;
    this.usage.calls.push({
      inputTokens: v.inputTokens,
      cachedInputTokens: v.cachedInputTokens,
      outputTokens: v.outputTokens,
      reasoningTokens: v.reasoningTokens,
    });
    this.save(this.view());
  }
}
