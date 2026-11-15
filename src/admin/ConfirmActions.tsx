import { ConfirmDialog } from '../ui/index';
import { dataManagementFieldName } from '../../shared/business/index';
import { recordLabel } from './record-refs';
import type { ListedRecord } from './record-types';
// 数据管理里两种要先确认再办的操作：永久删除 AI 识别文件、批量修改。确认后由数据管理窗口去办，办完窗口关掉、页面提示结果。

type Common = { busy: boolean; error: string; close: () => void; confirm: () => void };

/** 删 AI 识别文件：删了就没了，原件一起删 */
export function RemoveWorkspacesDialog({
  rows,
  busy,
  error,
  close,
  confirm,
}: Common & { rows: ListedRecord[] }) {
  return (
    <ConfirmDialog
      title="删除AI识别文件"
      confirmLabel="永久删除"
      danger
      busy={busy}
      error={error}
      close={close}
      onConfirm={confirm}
    >
      <p>
        <strong>删除后不能恢复 · {rows.length} 份</strong>
      </p>
      <p>{rows.map((x) => recordLabel(x.record)).join('、')}</p>
      <p>识别结果和上传的原件一起永久删除，回收站里也不留。</p>
    </ConfirmDialog>
  );
}

/** 批量修改：列出要改的记录和改成什么 */
export function BatchUpdateDialog({
  module,
  rows,
  patch,
  busy,
  error,
  close,
  confirm,
}: Common & { module: string; rows: ListedRecord[]; patch: Record<string, unknown> | undefined }) {
  return (
    <ConfirmDialog
      title="批量修改"
      confirmLabel="确认此范围"
      danger
      busy={busy}
      error={error}
      close={close}
      onConfirm={confirm}
    >
      <p>
        <strong>即将执行：批量修改 · {rows.length} 条</strong>
      </p>
      <p>{rows.map((x) => recordLabel(x.record)).join('、')}</p>
      {patch && (
        <p>
          修改：
          {Object.entries(patch)
            .map(([k, v]) => dataManagementFieldName(k, '', module) + ' 改为“' + String(v ?? '') + '”')
            .join('；')}
        </p>
      )}
    </ConfirmDialog>
  );
}
