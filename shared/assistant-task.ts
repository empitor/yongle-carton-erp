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
    .min(1)
    .max(40),
});
export const taskStates = {
  running: '正在执行',
  paused: '可继续',
  waiting: '等待用户确认',
  failed: '执行失败，可继续核对',
  completed: '已列步骤完成',
};
export type TaskStepState =
  'planned' | 'running' | 'completed' | 'waiting' | 'failed' | 'uncertain';
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
};
export type AssistantBusinessTask = {
  id: string;
  goal: string;
  state: keyof typeof taskStates;
  stage: string;
  createdAt: string;
  updatedAt: string;
  steps: BusinessTaskStep[];
  lastResult?: string;
  requestId?: string;
};
