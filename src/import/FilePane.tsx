import { evaluateDraft } from '../../shared/import/index';
import ArrivalDraftPanel from './ArrivalDraftPanel';
import OrderDraftPanel from './OrderDraftPanel';
import DocHead from './DocHead';
import FileMenu from './FileMenu';
import { RecognizeProgress } from './DraftUI';
import { taskRunning, type FileMode } from './fileStatus';
import { arrivalFlags, canReanalyze, headAction } from './page-state';
import type { PageDialog } from './ImportPageDialogs';
import type { useRecognize } from './useImportPage';
import type { useOrderWorkspace } from './useOrderWorkspace';

/**
 * AI 导入页右边：当前文件的头部（类型、主按钮、“更多”）、识别进度和识别结果面板。
 * 客户订单、到货单各有自己的面板。
 */
export default function FilePane({
  api,
  rec,
  setDialog,
  localAdmin,
  showPreview,
  togglePreview,
}: {
  api: ReturnType<typeof useOrderWorkspace>;
  rec: ReturnType<typeof useRecognize>;
  setDialog: (dialog: PageDialog) => void;
  localAdmin: boolean;
  showPreview: boolean;
  togglePreview: () => void;
}) {
  const w = api.workspace,
    id = api.selected,
    busy = !!api.jobs[id],
    currentMode: FileMode = w?.mode || 'order',
    current = api.status?.workspaces.find((f) => f.id === id),
    head = headAction(currentMode, w, current, busy);
  return (
    <section className="aii-pane">
      {w && current && (
        <DocHead
          file={current}
          fileName={w.fileName}
          mode={currentMode}
          job={api.jobs[current.id]}
          modeLocked={arrivalFlags(current).locked || !!api.jobs[current.id] || taskRunning(current)}
          switchMode={(mode) => rec.switchFilingMode(current, mode)}
          primary={
            head && {
              label: head.label,
              disabled: head.disabled,
              onClick: () => (head.mode === 'order' ? rec.recognize([id]) : rec.reanalyzeFile(current)),
            }
          }
          showPreview={showPreview}
          togglePreview={togglePreview}
          revision={w.revision}
        >
          <FileMenu
            api={api}
            fileName={w.fileName}
            busy={busy}
            localAdmin={localAdmin}
            reanalyze={canReanalyze(currentMode, w, current, busy) ? () => rec.reanalyzeFile(current) : undefined}
            remove={() => setDialog({ kind: 'delete', ids: [id], permanent: false })}
          />
        </DocHead>
      )}
      {busy && <RecognizeProgress progress={api.progress[id]} />}
      {currentMode === 'arrival' ? (
        <ArrivalDraftPanel key={id} api={api} workspace={w} recognizeSignal={rec.recognizeSignal} />
      ) : (
        <OrderDraftPanel
          key={id}
          api={api}
          workspace={w}
          draft={api.draft}
          evaluation={api.draft ? evaluateDraft(api.draft) : null}
          busy={busy}
          localAdmin={localAdmin}
        />
      )}
    </section>
  );
}
