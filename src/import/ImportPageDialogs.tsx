import { ConfirmDialog, DataManagementEditorSlot, emit } from '../ui/index';
import BatchImportDialog from './BatchImportDialog';
import HistoryDialog from './HistoryDialog';
import { DeleteFilesDialog } from './OrderDialogs';
import type { FileItem } from './fileStatus';
import type { Ask } from './useImportPage';
import type { useOrderWorkspace } from './useOrderWorkspace';

type Api = ReturnType<typeof useOrderWorkspace>;
/** 读不出来的文件没有文件名：确认窗里这样叫它 */
const UNREADABLE_NAME = '读不出来的文件';
/** AI 导入页同一时间开着的窗口：历史与归档、数据管理、批量导入、归档或永久删除确认 */
export type PageDialog =
  | { kind: 'history' }
  | { kind: 'manage' }
  | { kind: 'batch' }
  | { kind: 'delete'; ids: string[]; permanent: boolean };

/** AI 导入页的各个窗口；ask 是识别前要问的那一句（useRecognize）。 */
export default function ImportPageDialogs({
  api,
  dialog,
  setDialog,
  localAdmin,
  importTargets,
  setChecked,
  ask,
  closeAsk,
}: {
  api: Api;
  dialog: PageDialog | null;
  setDialog: (dialog: PageDialog | null) => void;
  localAdmin: boolean;
  /** 勾选里能批量导入的客户订单 */
  importTargets: FileItem[];
  setChecked: (update: (ids: string[]) => string[]) => void;
  ask: Ask | null;
  closeAsk: () => void;
}) {
  const close = () => setDialog(null);
  const nameOf = (fid: string) =>
    api.status?.workspaces.find((f) => f.id === fid)?.fileName ||
    api.status?.archives.find((f) => f.id === fid)?.fileName ||
    (api.status?.unreadable.some((f) => f.id === fid) ? UNREADABLE_NAME : undefined);
  return (
    <>
      {dialog?.kind === 'history' && (
        <HistoryDialog
          archives={api.status?.archives || []}
          unreadable={api.status?.unreadable || []}
          selectedId={api.selected}
          localAdmin={localAdmin}
          close={close}
          open={async (fid) => {
            await api.choose(fid);
            close();
          }}
          restore={async (fid) => {
            await api.restore(fid);
            close();
          }}
          remove={(fid) => setDialog({ kind: 'delete', ids: [fid], permanent: true })}
          manage={() => setDialog({ kind: 'manage' })}
        />
      )}
      {dialog?.kind === 'manage' && (
        <DataManagementEditorSlot
          initialModule="workspaces"
          close={() => {
            close();
            void api.refresh();
          }}
        />
      )}
      {ask && (
        <ConfirmDialog
          title={ask.title}
          confirmLabel={ask.confirmLabel}
          close={closeAsk}
          onConfirm={() => {
            closeAsk();
            ask.run();
          }}
        >
          <p className="aii-confirm-text">{ask.body}</p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'delete' && (
        <DeleteFilesDialog
          names={dialog.ids.map(nameOf)}
          permanent={dialog.permanent}
          close={close}
          confirm={async () => {
            const { ids, permanent } = dialog;
            close();
            const removed = await api.removeMany(ids, permanent);
            setChecked((c) => c.filter((id) => !removed.includes(id)));
          }}
        />
      )}
      {dialog?.kind === 'batch' && (
        <BatchImportDialog
          files={importTargets}
          token={api.token}
          close={close}
          done={() => {
            void api.refresh();
            emit('erp-business-changed');
          }}
        />
      )}
    </>
  );
}
