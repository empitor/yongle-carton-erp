import type { ImportWorkspaceView } from './order-draft.js';

type ImportTaskState = NonNullable<ImportWorkspaceView['task']>['state'];

/**
 * 识别文件（客户订单）到哪一步的叫法：AI 导入页文件列表、助手卡片共用，只在这里定义。
 * 键是识别任务的每个状态加“已正式导入”，少一个类型检查就报错。ready 是识别完、等人核对。
 */
export const importStateLabels: Record<ImportTaskState | 'imported', string> = {
  uploaded: '待识别',
  queued: '等待识别',
  backoff: '排队等待',
  running: 'AI 识别中',
  ready: '待核对',
  failed: '识别失败',
  cancelled: '已取消',
  imported: '已导入',
};

/** 一份订单识别文件现在的状态：在排队、识别中、失败、取消的看任务；其余有识别结果是待核对，没有是待识别。 */
export function importStateLabel(w: { imported?: unknown; hasDraft?: boolean; task?: { state: ImportTaskState } }) {
  if (w.imported) return importStateLabels.imported;
  const state = w.task?.state;
  if (state && state !== 'uploaded' && state !== 'ready') return importStateLabels[state];
  return w.hasDraft ? importStateLabels.ready : importStateLabels.uploaded;
}
