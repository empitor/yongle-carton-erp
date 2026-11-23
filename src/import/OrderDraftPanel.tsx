import { useState } from 'react';
import { Undo2, Save, ShieldCheck } from 'lucide-react';
import { errorMessage, pageHref } from '../../shared/core/index';
import type {
  DraftEvaluation,
  ImportPreview,
  ImportWorkspaceView as Workspace,
  OrderDraft,
} from '../../shared/import/index';
import { Hint, useAction } from '../ui/index';
import { executeImport, previewImport, readWorkspace } from './workspace-api';
import OrderDraftTable from './OrderDraftTable';
import ReviewIssues from './ReviewIssues';
import { DraftEmpty, DraftFooter, Figure } from './DraftUI';
import { ImportPreviewDialog } from './OrderDialogs';
import { SEND_NOTE } from './ImportDialog';
import type { useOrderWorkspace } from './useOrderWorkspace';

type Api = ReturnType<typeof useOrderWorkspace>;

/** 识别过这份文件、导入过订单时，告诉人原订单在哪。 */
function HistoryHint({ w }: { w: Workspace }) {
  const h = w.historyImport;
  if (!h) return null;
  return (
    <Hint tone="info">
      这份文件处理过：订单 {h.orderNumber}
      {h.permanentlyDeleted ? '（已永久删除，可以重新导入）' : h.archived ? '（已归档）' : '（当前有效）'}
      。重新识别不受影响，导入时会再查一次重复。
      {!h.permanentlyDeleted && (
        <a href={h.archived ? pageHref('orders', { archived: true }) : pageHref('orders', { order: h.orderId })}>
          {h.archived ? '去归档里查看' : '查看原订单'}
        </a>
      )}
    </Hint>
  );
}

/** 底栏左边的合计：数量、金额（有没保存的修改时注明）、币种和税费、核对提示 */
function OrderSummary({
  w,
  d,
  evaluation,
  unsaved,
}: {
  w: Workspace;
  d: OrderDraft;
  evaluation: DraftEvaluation | null;
  unsaved: boolean;
}) {
  return (
    <>
      <Figure label="数量">{evaluation?.totalQuantity || '待确认'}</Figure>
      <Figure label={unsaved ? '金额（未保存）' : '金额'}>{evaluation?.totalAmount || '待确认'}</Figure>
      <small>
        {d.header.currency.value || '币种待确认'} · {d.header.taxMode.value || '税费待确认'}
      </small>
      <ReviewIssues issues={evaluation?.issues || []} warnings={d.warnings} changes={w.changes} />
    </>
  );
}

/** 底栏的主按钮：导入过的给“查看订单”（原订单永久删除了只说一句），没导入的给“导入订单” */
function ImportButton({
  imported,
  disabled,
  importBusy,
  start,
}: {
  imported: Workspace['imported'];
  disabled: boolean;
  importBusy: boolean;
  start: () => void;
}) {
  if (imported?.permanentlyDeleted)
    return <small className="aii-footer-hint">正式订单 {imported.orderNumber} 已永久删除，不能恢复</small>;
  if (imported)
    return (
      <a className="aii-done-link" href={imported.archived ? pageHref('orders', { archived: true }) : pageHref('orders', { order: imported.orderId })}>
        <ShieldCheck size={14} />
        查看订单 {imported.orderNumber}
        {imported.archived ? '（已归档）' : ''}
      </a>
    );
  return (
    <button className="primary" disabled={disabled || importBusy} onClick={start}>
      {importBusy ? '正在生成预览…' : '导入订单'}
    </button>
  );
}

/**
 * 客户订单类型的识别结果：表格（含客户、产品对应）、底栏（“让 AI 改”打开全局助手），
 * 以及“导入订单”预览窗。到货单有自己的面板。
 */
export default function OrderDraftPanel({
  api,
  workspace: w,
  draft: d,
  evaluation,
  busy,
  localAdmin,
}: {
  api: Api;
  workspace?: Workspace;
  draft?: OrderDraft;
  evaluation: DraftEvaluation | null;
  busy: boolean;
  localAdmin: boolean;
}) {
  const id = api.selected,
    ops = api.operations(id),
    unsaved = ops.length > 0,
    locked = busy || (!!w?.imported && !localAdmin);
  const [matchingPending, setMatchingPending] = useState(false),
    [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const importing = useAction(),
    importBusy = importing.busy;
  const saveEdits = () => api.saveEdits(id, ops);
  /** 导入订单：有没保存的修改先存下来，再按最新这一版生成导入预览；没办成的原因写在页头。 */
  const startImport = () =>
    importing.run(async () => {
      try {
        if (unsaved && !(await saveEdits())) return;
        const latest = await readWorkspace(id);
        setImportPreview(await previewImport(api.token(), id, latest.revision));
      } catch (error) {
        api.setFatal(errorMessage(error));
      }
    });
  /** 正式导入：没办成的原因写在导入窗里 */
  const executeImportNow = (preview: ImportPreview, distinctProducts: string[]) =>
    importing.run(async () => {
      const receipt = await executeImport(api.token(), id, preview, distinctProducts);
      await api.load(id);
      await api.refresh();
      api.setNotice('已导入订单 ' + receipt.orderNumber + '，点底部“查看订单”可以打开。');
      setImportPreview(null);
    });
  if (!w || !d)
    return (
      <div className="aii-pane-body">
        <DraftEmpty title={w ? '还没有识别' : '先选一份文件'}>
          {w ? '点右上角“开始识别”，结果填到这里，所有内容都可以改。' + SEND_NOTE : ''}
        </DraftEmpty>
      </div>
    );
  return (
    <>
      <div className="aii-pane-body">
        <HistoryHint w={w} />
        <OrderDraftTable
          key={id}
          workspace={{ ...w, evaluation }}
          draft={d}
          locked={locked}
          change={(k, v, line) => api.change(id, k, v, line)}
          mappingError={api.errors[id]}
          onMappingPending={setMatchingPending}
          onMapping={async (m) => {
            if (unsaved && !(await saveEdits())) return null;
            return api.saveMapping(id, m);
          }}
        />
      </div>
      <DraftFooter
        moreLabel="订单识别更多操作"
        summary={<OrderSummary w={w} d={d} evaluation={evaluation} unsaved={unsaved} />}
      >
        {matchingPending && !w.imported && <small className="aii-footer-hint">先确认上面的客户和产品</small>}
        <button
          className="aii-ai-button"
          title={unsaved ? '先保存修改，助手看到的是保存后的这一版' : '打开助手，说要改哪里'}
          disabled={busy || unsaved}
          onClick={() => api.askAssistant(id)}
        >
          让 AI 改
        </button>
        {(unsaved || w.canUndo) && (
          <button
            className="secondary"
            disabled={busy}
            title={unsaved ? '放弃还没保存的修改' : '撤回上一次保存的修改'}
            onClick={() => (unsaved ? api.discard(id) : void api.undo(id))}
          >
            <Undo2 size={14} />
            撤回修改
          </button>
        )}
        {unsaved && (
          <button className="secondary" disabled={busy} onClick={() => void saveEdits()}>
            <Save size={14} />
            保存 ({ops.length})
          </button>
        )}
        <ImportButton
          imported={w.imported}
          disabled={busy || matchingPending}
          importBusy={importBusy}
          start={() => void startImport()}
        />
      </DraftFooter>
      {importPreview && (
        <ImportPreviewDialog
          preview={importPreview}
          needsAgreement={!localAdmin}
          busy={importBusy}
          error={importing.error}
          close={() => setImportPreview(null)}
          confirm={(distinct) => void executeImportNow(importPreview, distinct)}
        />
      )}
    </>
  );
}
