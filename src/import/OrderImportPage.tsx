import { useState, type DragEvent } from 'react';
import { useAuthState } from '../ui/index';
import { useOrderWorkspace } from './useOrderWorkspace';
import FilePreview from './FilePreview';
import FileList, { CheckedBar } from './FileList';
import FilePane from './FilePane';
import ImportPageHead, { DropZone, ImportBanners } from './ImportPageHead';
import ImportPageDialogs, { type PageDialog } from './ImportPageDialogs';
import { fileCounts } from './page-state';
import { useChecked, usePreviewShown, useRecognize, useUploadMode } from './useImportPage';

/** 拖文件进来的那一层：拖进时整页换样子，放下就上传 */
function dropHandlers(dragging: boolean, setDragging: (v: boolean) => void, upload: (files: File[]) => void) {
  return {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      if (!dragging) setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      upload(Array.from(e.dataTransfer.files));
    },
  };
}

/** 页面上的文件：在用的、读不出来的；都没有（也没有正在传的）时整页只放一个拖入区 */
function pageFiles(api: ReturnType<typeof useOrderWorkspace>) {
  const files = api.status?.workspaces || [],
    unreadable = api.status?.unreadable || [];
  return { files, unreadable, empty: !!api.status && !files.length && !api.uploads.length && !unreadable.length };
}

/**
 * AI 导入：左边文件，中间原件，右边识别结果。
 * 页头只有统计、“更多”（历史与归档）和主按钮“上传文件”；没有文件时整页只有一个拖入区。
 * 两种类型（客户订单、到货单）各有自己的面板，底栏同一个写法：让 AI 改 · 撤回修改 · 保存 · 主按钮。
 * 页面上的状态在 useImportPage.ts，窗口在 ImportPageDialogs.tsx。
 */
export default function OrderImportPage() {
  const auth = useAuthState(),
    localAdmin = !!auth?.actor?.localAdministrator,
    settingsLink = auth?.actor?.role === 'super_admin' || localAdmin;
  const uploadMode = useUploadMode();
  const api = useOrderWorkspace(uploadMode);
  const [dialog, setDialog] = useState<PageDialog | null>(null),
    [dragging, setDragging] = useState(false);
  const { showPreview, togglePreview } = usePreviewShown();
  const rec = useRecognize(api);
  const { files, unreadable, empty } = pageFiles(api),
    counts = fileCounts(files, api.uploads.filter((f) => f.state === 'failed').length);
  const sel = useChecked(files);
  return (
    <div
      className={'order-import' + (dragging ? ' is-dragging' : '')}
      {...dropHandlers(dragging, setDragging, api.upload)}
    >
      <ImportPageHead
        empty={empty}
        counts={counts}
        running={Object.keys(api.jobs).length}
        waiting={api.status?.queue?.waiting || 0}
        openHistory={() => setDialog({ kind: 'history' })}
        upload={api.upload}
      />
      <ImportBanners
        ai={api.status?.ai}
        settingsLink={settingsLink}
        uploadMode={uploadMode}
        error={api.fatal || api.errors[api.selected]}
        dismissError={() => {
          api.setFatal('');
          api.dismissError(api.selected);
        }}
        notice={api.notice}
        dismissNotice={() => api.setNotice('')}
      />
      {empty ? (
        <DropZone uploadMode={uploadMode} upload={api.upload} />
      ) : (
        <div className={'oi-workspace-body' + (showPreview ? '' : ' no-preview')}>
          <aside className="oi-left">
            <FileList
              files={files}
              uploads={api.uploads}
              selected={api.selected}
              checked={sel.checked}
              setChecked={sel.setChecked}
              jobs={api.jobs}
              totalDone={counts.done}
              choose={(fid) => void api.choose(fid)}
              cancel={(fid) => void api.cancel(fid)}
              retryUpload={api.retryUpload}
              discardUpload={api.discardUpload}
              unreadable={unreadable}
              openHistory={() => setDialog({ kind: 'history' })}
            />
            {showPreview && <FilePreview workspace={api.workspace} />}
          </aside>
          <div className="oi-right">
            <FilePane
              api={api}
              rec={rec}
              setDialog={setDialog}
              localAdmin={localAdmin}
              showPreview={showPreview}
              togglePreview={togglePreview}
            />
          </div>
        </div>
      )}
      <CheckedBar
        sel={sel}
        signedIn={!!auth?.actor}
        unsaved={api.operations(api.selected).length > 0}
        recognize={rec.recognize}
        setDialog={setDialog}
      />
      <ImportPageDialogs
        api={api}
        dialog={dialog}
        setDialog={setDialog}
        localAdmin={localAdmin}
        importTargets={sel.importTargets}
        setChecked={sel.setChecked}
        ask={rec.ask}
        closeAsk={rec.closeAsk}
      />
    </div>
  );
}
