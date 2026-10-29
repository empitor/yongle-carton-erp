import type { AssistantBusinessTask } from './assistant-task.js';
export function currentOrderCard(workflow: any, businessTask?: AssistantBusinessTask | null) {
  const task = workflow?.tasks?.find((t: any) => t.id === workflow.activeId);
  if (!task) return null;
  if (!businessTask) return task;
  const workspaceIds = new Set([
    ...(businessTask.memory?.workspaceIds || []),
    ...businessTask.steps.flatMap((s) => s.scope?.workspaceIds || []),
  ]);
  return workspaceIds.has(task.workspaceId) ? task : null;
}
