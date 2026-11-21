import type { FlowApi } from '../../shared/business/index';
import { DeliveryExportDialog } from '../documents/index';
import RecordContextDialog from '../recordkit/RecordContext';
import DatabaseDeleteDialog from '../recordkit/DatabaseDeleteDialog';
import CorrectionDialog from './CorrectionDialog';
import DocumentInfoDialog from './DocumentInfoDialog';
import DeliveredDialog from './DeliveredDialog';
import FlowEditorDialog from './FlowEditorDialog';
import { FlowActionDialog, FlowReviewDialog, FlowScheduleDialog } from './FlowDialogs';
import ProductionBatchDialog from './ProductionBatchDialog';
import { PurchaseReturnDialog } from './PurchaseReturnDialog';
import { infoSavedMessage } from './flow-words';
import { detailLookups } from './lookups';
import type { FlowDesk } from './useFlowDesk';

/** 登记完工的结果 */
type CompletionResult = FlowApi['POST /flow/production-completion/execute']['response'];

/** 登记完工办完的提示：登记了哪几张、库存动没动（先登记、稍后核对入库的，库存没动，在完工记录里逐张核对入库） */
function completionNotice(r: CompletionResult) {
  const numbers = r.results.map((x) => x.number).filter(Boolean);
  const listed = numbers.length ? ' ' + numbers.join('、') : '';
  return r.pending
    ? '已登记 ' + r.results.length + ' 张完工' + listed + '，待核对入库。'
    : '已登记完工' + listed + '，成品已入库，领的纸板已扣库存。';
}

/** 单据本身的几个窗口：确认送达、导出送货单、删除、关联记录与修改历史 */
function DocumentDialogs({ desk }: { desk: FlowDesk }) {
  const { kind, view, setView, notify, refresh, dialogOnly, delivering, exporting, deleting } = desk;
  return (
    <>
      {delivering && (
        <DeliveredDialog
          doc={delivering}
          close={() => desk.setDelivering(null)}
          done={(after) => {
            desk.setDelivering(null);
            setView(dialogOnly ? null : after);
            notify('送货单 ' + after.number + ' 已确认送达（' + after.deliveredAt + '）。');
            refresh();
          }}
        />
      )}
      {exporting && (
        <DeliveryExportDialog
          doc={exporting}
          close={() => desk.setExporting(null)}
          onDone={(message) => {
            desk.setExporting(null);
            setView(null);
            notify(message);
            refresh();
          }}
        />
      )}
      {deleting && (
        <DatabaseDeleteDialog
          module={deleting.at(0)?.kind || kind}
          rows={deleting}
          close={() => desk.setDeleting(null)}
          done={(message) => {
            desk.setDeleting(null);
            setView(null);
            desk.clearSelection();
            notify(message);
            refresh();
          }}
        />
      )}
      {desk.contextId !== null && (
        <RecordContextDialog
          module={view?.kind || kind}
          id={desk.contextId}
          label={view?.number}
          close={() => desk.setContextId(null)}
        />
      )}
    </>
  );
}

/** 填写和核对的窗口：编辑、核对入库或出库、登记完工、调整排程 */
function WorkDialogs({ desk }: { desk: FlowDesk }) {
  const { data, busy, error, setView, notify, refresh, editor, preview, batch, scheduling } = desk;
  return (
    <>
      {editor && (
        <FlowEditorDialog
          kind={desk.editorKind}
          editor={editor}
          setEditor={desk.setEditor}
          data={data}
          ready={desk.editorReady}
          busy={busy}
          error={error}
          save={() => void desk.save()}
        />
      )}
      {preview && (
        <FlowReviewDialog
          kind={preview.document.kind}
          preview={preview}
          data={data}
          ready={desk.ready(detailLookups(preview.document))}
          busy={busy}
          error={error}
          close={() => desk.setPreview(null)}
          confirm={() => void desk.confirm()}
        />
      )}
      {batch && (
        <ProductionBatchDialog
          tasks={data.tasks.map((t) => ({
            ...t,
            productName: t.productName || data.products.find((p) => p.id === t.productId)?.name,
          }))}
          items={data.items}
          products={data.products}
          taskIds={batch.taskIds}
          close={() => desk.setBatch(null)}
          done={(r: CompletionResult) => {
            desk.setBatch(null);
            desk.clearSelection();
            setView(null);
            notify(completionNotice(r));
            refresh();
          }}
        />
      )}
      {scheduling && (
        <FlowScheduleDialog
          doc={scheduling}
          label={desk.labelRow(scheduling)}
          date={desk.newPlanDate}
          time={desk.newPlanTime}
          setDate={desk.setNewPlanDate}
          setTime={desk.setNewPlanTime}
          busy={busy}
          error={error}
          close={() => desk.setScheduling(null)}
          save={desk.saveSchedule}
        />
      )}
    </>
  );
}

/** 已生效单据的后续：采购退货、只改说明的编辑、更正，和撤销、取消的确认窗 */
function FollowUpDialogs({ desk }: { desk: FlowDesk }) {
  const { kind, busy, error, setError, notify, refresh, returning, editingInfo, correcting, action } = desk;
  return (
    <>
      {returning && (
        <PurchaseReturnDialog
          arrival={returning}
          close={() => desk.setReturning(null)}
          done={() => {
            desk.setReturning(null);
            desk.setReturnRevision((v) => v + 1);
            notify('已退货，库存和采购已到货已同步扣减。金额以供应商到票或红字发票为准。');
            refresh();
          }}
        />
      )}
      {/* 编辑、更正办完只关自己的窗口，详情留着、跟着列表刷新 */}
      {editingInfo && (
        <DocumentInfoDialog
          doc={editingInfo}
          close={() => desk.setEditingInfo(null)}
          saved={(result) => {
            desk.setEditingInfo(null);
            notify(infoSavedMessage(editingInfo.kind, result));
            refresh();
          }}
        />
      )}
      {correcting && (
        <CorrectionDialog
          id={correcting.id}
          kind={correcting.kind}
          close={() => desk.setCorrecting(null)}
          done={(result) => {
            desk.setCorrecting(null);
            // 更正窗已通知业务数据变了，列表和详情会重读
            notify(result.summary);
          }}
        />
      )}
      {action && (
        <FlowActionDialog
          action={action}
          kind={action.rows.at(0)?.kind || kind}
          reason={desk.reason}
          setReason={desk.setReason}
          busy={busy}
          // 没办成时原因显示在窗口里；关掉窗口一起清掉，不留在页面上
          close={() => {
            desk.setAction(null);
            setError('');
          }}
          perform={desk.perform}
          error={error}
        />
      )}
    </>
  );
}

/** 单据办理的窗口（编辑、核对、登记完工、导出送货单、确认送达、撤销取消、删除……），状态都在 useFlowDesk 里。 */
export default function FlowDeskDialogs({ desk }: { desk: FlowDesk }) {
  return (
    <>
      <DocumentDialogs desk={desk} />
      <WorkDialogs desk={desk} />
      <FollowUpDialogs desk={desk} />
    </>
  );
}
