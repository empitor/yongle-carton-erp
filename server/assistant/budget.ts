import { z } from 'zod';
import { ImportError } from '../import/errors.js';
import type { AgentBudgetView } from '../../shared/assistant-task.js';
export const agentBudgetSchema = z.object({
  modelCalls: z.number().int().min(1).max(40).default(15),
  toolCalls: z.number().int().min(1).max(120).default(40),
  businessWrites: z.number().int().min(1).max(8).default(8),
  pageInteractions: z.number().int().min(1).max(40).default(20),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(30 * 60 * 1000)
    .default(30 * 60 * 1000),
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
  private outputs: { tool: string; chars: number }[] = [];
  private usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
    inputReports: 0,
    outputReports: 0,
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
  take(kind: keyof AgentExecutionBudget['used']) {
    if (Date.now() - this.started >= this.limits.timeoutMs) this.stop('任务已超时');
    if (this.used[kind] >= this.limits[kind])
      this.stop(
        {
          modelCalls: '模型调用预算已耗尽',
          toolCalls: '工具调用预算已耗尽',
          businessWrites: '业务写入预算已耗尽',
          pageInteractions: '页面交互预算已耗尽',
        }[kind],
      );
    this.used[kind]++;
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
  providerUsage(v: { inputTokens?: number; outputTokens?: number; totalTokens?: number }) {
    this.usage.requests++;
    if (v.inputTokens !== undefined) this.usage.inputReports++;
    if (v.outputTokens !== undefined) this.usage.outputReports++;
    this.usage.inputTokens += v.inputTokens || 0;
    this.usage.outputTokens += v.outputTokens || 0;
    this.usage.totalTokens += v.totalTokens ?? (v.inputTokens || 0) + (v.outputTokens || 0);
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
