import { z } from 'zod';
import { ImportError } from '../import/errors.js';
import type { AgentBudgetView } from '../../shared/assistant-task.js';
import type { ProviderTokenUsage } from '../ai/usage.js';
export const agentBudgetSchema = z.object({
  // 0表示持续执行；非零是运维可配置资源上限，而非AI权限限制。
  modelCalls: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  businessWrites: z.number().int().nonnegative().default(0),
  pageInteractions: z.number().int().nonnegative().default(0),
  timeoutMs: z
    .number()
    .int()
    .nonnegative()
    .default(2 * 60 * 60 * 1000),
  protocolRecoveries: z.number().int().nonnegative().default(2),
  noProgress: z.number().int().min(2).max(8).default(3),
  consecutiveFailures: z.number().int().min(2).max(8).default(3),
  sameFailure: z.number().int().min(1).max(4).default(2),
});
export type AgentBudgetLimits = z.infer<typeof agentBudgetSchema>;
export function agentBudgetConfig(overrides: Partial<AgentBudgetLimits> = {}) {
  const env: Record<string, number> = {};
  for (const [key, name] of Object.entries({
    modelCalls: 'ERP_AGENT_MODEL_CALLS',
    toolCalls: 'ERP_AGENT_TOOL_CALLS',
    businessWrites: 'ERP_AGENT_BUSINESS_WRITES',
    pageInteractions: 'ERP_AGENT_PAGE_INTERACTIONS',
    timeoutMs: 'ERP_AGENT_TIMEOUT_MS',
    protocolRecoveries: 'ERP_AGENT_PROTOCOL_RECOVERIES',
    noProgress: 'ERP_AGENT_NO_PROGRESS',
    consecutiveFailures: 'ERP_AGENT_CONSECUTIVE_FAILURES',
    sameFailure: 'ERP_AGENT_SAME_FAILURE',
  }))
    if (process.env[name] !== undefined) env[key] = Number(process.env[name]);
  return Object.freeze(agentBudgetSchema.parse({ ...env, ...overrides }));
}
export class AgentBudgetExceeded extends ImportError {
  constructor(message: string) {
    super(message + '；进度已保存，核验后可继续。', 409, 'agent-budget');
  }
}
export class AgentExecutionBudget {
  private started = Date.now();
  private failureStreak = 0;
  private sameResult = '';
  private repeat = 0;
  private used = { modelCalls: 0, toolCalls: 0, businessWrites: 0, pageInteractions: 0 };
  private reads = 0;
  private outputChars = 0;
  private inputChars = 0;
  private outputs: { tool: string; chars: number }[] = [];
  private usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
    inputReports: 0,
    outputReports: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    cachedReports: 0,
    reasoningReports: 0,
  };
  stopReason?: string;
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
      readOperations: this.reads,
      toolOutputChars: this.outputChars,
      modelInputChars: this.inputChars,
      estimatedToolOutputTokens: Math.ceil(this.outputChars / 3),
      estimateBasis: '工具输出字符数÷3，仅为估算，不是Provider真实Token',
      providerUsage: { ...this.usage },
      toolOutputs: [...this.outputs],
      stopReason: this.stopReason,
    };
  }
  pause(message: string) {
    this.stopReason = message;
    this.save(this.view());
  }
  private stop(message: string): never {
    this.stopReason = message;
    this.save(this.view());
    throw new AgentBudgetExceeded(message);
  }
  take(kind: keyof AgentExecutionBudget['used'], amount = 1) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new ImportError('资源计数非法。');
    if (!amount) return;
    if (this.limits.timeoutMs > 0 && Date.now() - this.started >= this.limits.timeoutMs)
      this.stop('任务已超时');
    if (this.limits[kind] > 0 && this.used[kind] + amount > this.limits[kind])
      this.stop(
        {
          modelCalls: '模型调用预算已耗尽',
          toolCalls: '工具调用预算已耗尽',
          businessWrites: '业务写入预算已耗尽',
          pageInteractions: '页面交互预算已耗尽',
        }[kind],
      );
    this.used[kind] += amount;
    this.save(this.view());
  }
  readOperation() {
    this.reads++;
    this.save(this.view());
  }
  output(tool: string, result: unknown) {
    const chars = JSON.stringify(result)?.length || 0;
    this.outputChars += chars;
    this.outputs.push({ tool, chars });
    this.save(this.view());
  }
  input(chars: number) {
    this.inputChars += chars;
    this.save(this.view());
  }
  providerUsage(v: ProviderTokenUsage) {
    this.usage.requests++;
    if (v.inputTokens !== undefined) this.usage.inputReports++;
    if (v.outputTokens !== undefined) this.usage.outputReports++;
    this.usage.inputTokens += v.inputTokens || 0;
    this.usage.outputTokens += v.outputTokens || 0;
    this.usage.totalTokens += v.totalTokens ?? (v.inputTokens || 0) + (v.outputTokens || 0);
    this.usage.cachedInputTokens += v.cachedInputTokens || 0;
    this.usage.reasoningTokens += v.reasoningTokens || 0;
    if (v.cachedInputTokens !== undefined) this.usage.cachedReports++;
    if (v.reasoningTokens !== undefined) this.usage.reasoningReports++;
    this.save(this.view());
  }
  progress(signature: string, failed: boolean) {
    this.failureStreak = failed ? this.failureStreak + 1 : 0;
    this.repeat = signature === this.sameResult ? this.repeat + 1 : 0;
    this.sameResult = signature;
    if (this.failureStreak >= this.limits.consecutiveFailures)
      this.stop('连续工具失败，已停止无效重试');
    if (this.repeat >= this.limits.noProgress) this.stop('重复调用没有产生进展，已停止循环');
  }
}
