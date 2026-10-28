import { z } from 'zod';
export const taskPlanSchema = z.strictObject({
  goal: z.string().trim().min(1).max(1000),
  steps: z
    .array(
      z.strictObject({
        label: z.string().trim().min(1).max(160),
        tool: z.string().max(100),
        args: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1),
});
export const taskStates = {
  running: '正在执行',
  paused: '可继续',
  waiting: '等待用户确认',
  failed: '执行失败，可继续核对',
  completed: '已列步骤完成',
};
export type AgentExecutionState = 'working' | 'needs_input' | 'completed' | 'blocked';
export type AgentQuestion = {
  key: string;
  scope?: string;
  question: string;
  source?: 'user' | 'system';
  reason?: 'missing_fact' | 'ambiguity' | 'conflict';
};
export type TaskStepState =
  'planned' | 'running' | 'completed' | 'waiting' | 'failed' | 'uncertain' | 'superseded';
export type TaskDecision = {
  key: string;
  scope: string;
  value: unknown;
  status: 'confirmed' | 'inferred' | 'unknown' | 'conflict';
  source: { messageId?: string; quote: string; kind: 'user' | 'model' };
  previous?: unknown;
};
export type TaskMemory = {
  decisions: TaskDecision[];
  turns: { id: string; text: string }[];
  workspaceIds: string[];
  files?: { id: string; name: string }[];
};
export type BusinessTaskStep = {
  id: string;
  key?: string;
  tool: string;
  label: string;
  args?: Record<string, any>;
  scope?: any;
  state: TaskStepState;
  result?: any;
  previewId?: string;
  verification?: any;
  error?: string;
  updatedAt: string;
  async?: boolean;
  attemptedAt?: string;
  supersededBy?: string;
  completion?: { kind: 'draft' | 'business' | 'read' | 'interaction'; verified: boolean };
  pageOutcome?: {
    module: string;
    id: number;
    expected: Record<string, unknown>;
    beforeVersion: number;
    beforeValues?: Record<string, unknown>;
  };
};
export type AssistantBusinessTask = {
  id: string;
  goal: string;
  state: keyof typeof taskStates;
  stage: string;
  execution?: { state: AgentExecutionState; reason?: string; questions?: AgentQuestion[] };
  createdAt: string;
  updatedAt: string;
  steps: BusinessTaskStep[];
  lastResult?: string;
  requestId?: string;
  budget?: AgentBudgetView;
  memory?: TaskMemory;
};

export type AgentBudgetView = {
  requestId: string;
  limits: {
    modelCalls: number;
    toolCalls: number;
    businessWrites: number;
    pageInteractions: number;
    timeoutMs: number;
    noProgress: number;
    consecutiveFailures: number;
    sameFailure: number;
  };
  used: { modelCalls: number; toolCalls: number; businessWrites: number; pageInteractions: number };
  elapsedMs: number;
  readOperations: number;
  toolOutputChars: number;
  modelInputChars?: number;
  estimatedToolOutputTokens: number;
  estimateBasis: string;
  providerUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requests: number;
    inputReports?: number;
    outputReports?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    cachedReports?: number;
    reasoningReports?: number;
  };
  toolOutputs: { tool: string; chars: number }[];
  stopReason?: string;
};
