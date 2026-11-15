import type { ImportWorkspaceView as Workspace } from '../../shared/import/index';
import { fileMode, taskRunning, type FileItem, type FileMode } from './fileStatus';

/**
 * AI 导入页上由文件列表推出来的东西：页头的几个数、当前文件能不能识别 / 重新识别、
 * 识别类型锁没锁。只算不渲染，不依赖 React。
 */

/** 还没识别、可以批量识别的客户订单。 */
export const recognizableOrders = (files: FileItem[]) =>
  files.filter((f) => fileMode(f) === 'order' && !f.hasDraft && !f.imported && !taskRunning(f));

/** 页头统计：待核对、待识别、识别失败，以及文件列表上方“已识别几份”。 */
export function fileCounts(files: FileItem[], failedUploads: number) {
  return {
    done: files.filter((f) =>
      f.mode === 'arrival'
          ? ['recognized', 'draft', 'confirmed'].includes(f.arrivalStatus || '')
          : f.hasDraft,
    ).length,
    reviewing: files.filter((f) => f.hasDraft && !f.imported && fileMode(f) === 'order').length,
    waiting: recognizableOrders(files).length,
    failed:
      files.filter((f) =>
        f.mode === 'arrival' ? f.arrivalStatus === 'failed' : f.task?.state === 'failed',
      ).length + failedUploads,
  };
}

/** 到货文件：确认、取消或冲销后识别类型锁定；有原件识别记录或到货单就算识别过。 */
export function arrivalFlags(file?: FileItem) {
  return {
    locked:
      file?.mode === 'arrival' &&
      !!file.arrivalDocId &&
      ['confirmed', 'cancelled', 'reversed'].includes(file.arrivalStatus || ''),
    recognized:
      !!(file?.arrivalSourceId || file?.arrivalDocId) ||
      ['recognized', 'draft', 'confirmed'].includes(file?.arrivalStatus || ''),
  };
}

export type HeadAction = { mode: FileMode; label: string; disabled: boolean };

/** 头部主按钮：还没识别的文件给“开始识别”（失败过的叫“重试识别”）；识别过的不给。 */
export function headAction(
  mode: FileMode,
  workspace: Workspace | undefined,
  file: FileItem | undefined,
  busy: boolean,
): HeadAction | undefined {
  if (!workspace || !file) return undefined;
  const failed =
    mode === 'arrival' ? file.arrivalStatus === 'failed' : workspace.task?.state === 'failed';
  const label = busy ? '正在识别…' : failed ? '重试识别' : '开始识别';
  if (mode === 'order')
    return !workspace.draft && !workspace.imported ? { mode, label, disabled: busy } : undefined;
  const arrival = arrivalFlags(file);
  return !arrival.recognized && !arrival.locked ? { mode, label, disabled: busy } : undefined;
}

/** “更多”里给不给“重新识别”。 */
export function canReanalyze(
  mode: FileMode,
  workspace: Workspace | undefined,
  file: FileItem | undefined,
  busy: boolean,
) {
  if (!workspace || !file || busy) return false;
  if (mode === 'order') return !workspace.imported && !!workspace.draft;
  const arrival = arrivalFlags(file);
  return arrival.recognized && !arrival.locked;
}
