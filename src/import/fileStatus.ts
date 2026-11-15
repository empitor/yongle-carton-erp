import type { Tone } from '../ui/index';
import {
  importStateLabel,
  importStateLabels,
  type ImportWorkspaceView as Workspace,
} from '../../shared/import/index';

/** 文件列表里的一份文件（工作区列表接口返回的摘要）。 */
export type FileItem = {
  id: string;
  fileName: string;
  createdAt: string;
  task?: Workspace['task'];
  hasDraft?: boolean;
  mode?: 'order' | 'arrival';
  arrivalDocId?: number | null;
  arrivalSourceId?: string | null;
  arrivalStatus?: string;
  arrivalNumber?: string | null;
  imported?: Workspace['imported'];
  historyImport?: Workspace['imported'];
};

export type FileMode = 'order' | 'arrival';
export const modeLabels: Record<FileMode, string> = { order: '客户订单', arrival: '到货单' };
export const fileMode = (f: Pick<FileItem, 'mode'>): FileMode => f.mode || 'order';
/** 订单识别任务还在排队或进行中。 */
export const taskRunning = (f: FileItem) =>
  ['running', 'queued', 'backoff'].includes(f.task?.state || '');
/**
 * 刷新列表时订单识别任务的状态：running 是还在排队或识别（label 是给人看的进度词），
 * finished 是结束了（成功、失败或取消），idle 是还没开始。到货文件看 arrivalStatus。
 */
export function taskPhase(f: FileItem): { kind: 'running'; label: string } | { kind: 'finished' } | { kind: 'idle' } {
  if (f.mode === 'arrival')
    return f.arrivalStatus === 'running'
      ? { kind: 'running', label: importStateLabels.running }
      : { kind: 'finished' };
  const state = f.task?.state;
  if (state === 'running' || state === 'backoff' || state === 'queued')
    return { kind: 'running', label: importStateLabels[state] };
  if (state === 'ready' || state === 'failed' || state === 'cancelled') return { kind: 'finished' };
  return { kind: 'idle' };
}
export const fileFailed = (f: FileItem) =>
  f.mode === 'arrival' ? f.arrivalStatus === 'failed' : f.task?.state === 'failed';

/** 文件列表第二行：这份文件现在到哪一步了。job 是正在进行的识别提示。 */
export function fileStatus(f: FileItem, job?: string): string {
  if (f.imported)
    return (
      (f.imported.permanentlyDeleted ? '原正式订单已永久删除 · ' : importStateLabels.imported + ' · ') +
      f.imported.orderNumber
    );
  if (f.mode === 'arrival')
    return (
      job ||
      (f.arrivalStatus === 'confirmed'
        ? '已入库 · ' + (f.arrivalNumber || '')
        : f.arrivalStatus === 'running'
          ? importStateLabels.running
          : f.arrivalStatus === 'failed'
            ? '识别失败，可重试'
            : f.arrivalStatus === 'cancelled'
              ? '已取消识别，旧结果保留'
              : f.arrivalDocId
                ? '到货单待核对入库 · ' + (f.arrivalNumber || '')
                : f.arrivalStatus === 'recognized'
                  ? '已识别，待保存'
                  : '待识别到货单')
    );
  const history = f.historyImport
    ? '曾处理 ' +
      f.historyImport.orderNumber +
      (f.historyImport.permanentlyDeleted
        ? '（已永久删除）'
        : f.historyImport.archived
          ? '（归档记录）'
          : '（有效）') +
      ' · '
    : '';
  return history + (job || importStateLabel(f));
}

/** 右侧标题旁的状态标签：一个短词加颜色。待识别灰、进行中蓝、完成绿、取消黄、失败红。 */
export function fileChip(f: FileItem, job?: string): { label: string; tone: Tone } {
  if (job) return { label: '识别中', tone: 'accent' };
  if (f.imported)
    return f.imported.permanentlyDeleted
      ? { label: '原订单已删除', tone: 'danger' }
      : { label: importStateLabels.imported, tone: 'success' };
  if (f.mode === 'arrival') {
    if (f.arrivalStatus === 'confirmed') return { label: '已入库', tone: 'success' };
    if (f.arrivalStatus === 'running') return { label: '识别中', tone: 'accent' };
    if (f.arrivalStatus === 'failed') return { label: importStateLabels.failed, tone: 'danger' };
    if (f.arrivalStatus === 'cancelled') return { label: '已取消识别', tone: 'warning' };
    if (f.arrivalDocId) return { label: '待核对入库', tone: 'accent' };
    if (f.arrivalStatus === 'recognized') return { label: '待保存', tone: 'accent' };
    return { label: importStateLabels.uploaded, tone: 'neutral' };
  }
  // 标签里的“识别中”是短写，其余和文件列表同一套叫法
  const state = f.task?.state,
    label = state === 'running' ? '识别中' : importStateLabel(f);
  const tone: Tone =
    state === 'failed'
      ? 'danger'
      : state === 'cancelled'
        ? 'warning'
        : label === importStateLabels.uploaded
          ? 'neutral'
          : 'accent';
  return { label, tone };
}
