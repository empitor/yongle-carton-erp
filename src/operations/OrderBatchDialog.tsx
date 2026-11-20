import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { OrderBatchDraft, OrderBatchView } from '../../shared/business/index';
import { errorMessage } from '../../shared/core/index';
import type { DocumentFormat, DocumentTemplate } from '../../shared/documents/index';
import { FormMessage, ManagementDialog, emit, useAction, useSaveFile } from '../ui/index';
import { deliverBusinessFile } from '../documents/export-file';
import { exportDocument, previewDocumentBatch, previewWordFile, readDocumentTemplates } from '../documents/document-api';
import { draftOrderBatch, scheduleOrderBatch } from '../warehouse/order-batch-api';
import { rowDrafts, scheduleBody, scheduleProblem, type RowDrafts } from './BatchSchedule';
import { FileChoice, OrderFooter, OrderRows, PreviewPane, type Preview } from './OrderBatchParts';

/** 已经订过货的那份订货单（重新导出时带着）：编号、单号、版本 */
type DraftBatch = NonNullable<OrderBatchDraft['batch']>;

/**
 * 到货安排存进批次后，窗口里记着的批次换成服务端返回的新版本（没有返回时照旧）。
 * 返回的是改完的整份订货单，这里只看版本号。
 */
export function batchAfterSave<Saved extends Pick<OrderBatchView, 'version'>>(
  batch: DraftBatch,
  saved: Saved | null,
): DraftBatch {
  return { ...batch, version: saved && Number.isInteger(saved.version) ? saved.version : batch.version };
}

/** 预览、Word 排版都带的：这几张采购单、窗口里填的到货安排、选的模板（没选不带） */
const batchBody = (draft: OrderBatchDraft, schedule: RowDrafts, templateId: string) => ({
  purchaseIds: draft.purchases.map((p) => p.id),
  schedule: scheduleBody(schedule),
  ...(templateId ? { templateId } : {}),
});

/** 正式导出：第一张采购单是“id”那张，几张都带上版本号；已经订过货的到货安排先存进批次，不再随导出交 */
function exportBody(
  draft: OrderBatchDraft,
  schedule: RowDrafts,
  o: { format: DocumentFormat; markOrdered: boolean; templateId: string },
): Parameters<typeof exportDocument>[0] {
  const head = draft.purchases[0];
  return {
    kind: 'purchase',
    id: head.id,
    format: o.format,
    markOrdered: o.markOrdered,
    expectedVersion: head.version,
    purchases: draft.purchases.map((p) => ({ id: p.id, version: p.version })),
    ...(draft.batch ? {} : { schedule: scheduleBody(schedule) }),
    ...(o.templateId ? { templateId: o.templateId } : {}),
    requestId: crypto.randomUUID(),
  };
}

/** 导出完给人看的一句 */
function exportedMessage(draft: OrderBatchDraft, markOrdered: boolean) {
  if (!markOrdered) return '订货单文件已导出，采购状态没有改变。';
  const which =
    draft.purchases.length > 1 ? draft.purchases.length + ' 张采购单' : '采购单 ' + draft.purchases[0].number;
  return which + (draft.batch ? ' 的订货单已重新导出。' : ' 已变成待到货，订货单已导出，到货页能看到。');
}

/**
 * 打开窗口时读的：按这几张采购单排的订货单（已订过货的带着原批次）、采购订货单能用的模板，
 * 和各行可编辑的到货安排。initial 记着打开时（或最近一次存进批次的）到货安排，重新导出时比对改过没有。
 */
function useOrderDraft(purchaseIds: number[]) {
  const [draft, setDraft] = useState<OrderBatchDraft | null>(null),
    [templates, setTemplates] = useState<DocumentTemplate[]>([]),
    [schedule, setSchedule] = useState<RowDrafts>({}),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState('');
  const initial = useRef('');
  // 换了采购单才重读；读的时候取这一组的编号
  const idsKey = purchaseIds.join(',');
  const read = useEffectEvent(() => Promise.all([draftOrderBatch(purchaseIds), readDocumentTemplates()]));
  useEffect(() => {
    let active = true;
    read()
      .then(([d, settings]) => {
        if (!active) return;
        setDraft(d);
        const drafts = rowDrafts(d.rows);
        setSchedule(drafts);
        initial.current = JSON.stringify(scheduleBody(drafts));
        setTemplates(settings.templates.filter((t) => t.kind === 'purchase'));
      })
      .catch((e: unknown) => active && setLoadError(errorMessage(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [idsKey]);
  return { draft, setDraft, templates, schedule, setSchedule, initial, loading, loadError };
}

/**
 * 订货单：全站唯一的导出窗口。一张或几张同一家供应商的采购单合成一份发给供应商。
 * 同一种纸板合成一行写总数，每行可以写到货安排（多少在哪天前到，可以不写）。
 * 主按钮“导出订货单”：文件存好后这些采购单变成待到货（已订货）；
 * 预览在本窗口里切换着看，“只导出文件，不改状态”收在“更多”里。
 */
export default function OrderBatchDialog({
  purchaseIds,
  close,
  done,
}: {
  purchaseIds: number[];
  close: () => void;
  done: (message: string) => void;
}) {
  const order = useOrderDraft(purchaseIds);
  const { draft, schedule, initial } = order;
  const [templateId, setTemplateId] = useState(''),
    [format, setFormat] = useState<DocumentFormat>('docx'),
    [preview, setPreview] = useState<Preview | null>(null);
  const action = useAction(),
    save = useSaveFile();
  // 读的时候和办事的时候都算忙；读不出来时按钮都不能点，两处的错误不会同时有
  const busy = order.loading || action.busy,
    error = order.loadError || action.error;
  const problem = draft ? scheduleProblem(draft.rows, schedule) : '';
  // 按钮在读到订货单之前都不能点，下面几个都只在有订货单时办
  const showPreview = () =>
    void action.run(async () => {
      if (!draft) return;
      setPreview({ form: await previewDocumentBatch(batchBody(draft, schedule, templateId)) });
    });
  /**
   * 预览 Word 排版：服务端按模板排一份 Word 只用来看，不下载、不改状态，也不占订货单号、不留导出记录；
   * 几张合并时纸上印的是“下一个号”，和“预览”一样，正式导出时才占。到货安排和“预览”一样按窗口里填的。
   */
  const showWord = () =>
    void action.run(async () => {
      if (!draft) return;
      if (problem) throw new Error(problem);
      setPreview({ file: await previewWordFile({ kind: 'purchase', ...batchBody(draft, schedule, templateId) }) });
    });
  const exportOrder = (markOrdered: boolean) =>
    void action.run(async () => {
      if (!draft) return;
      if (problem) throw new Error(problem);
      // 已经订过货的整份重新导出：先把改过的到货安排存进批次
      const body = scheduleBody(schedule);
      if (draft.batch && JSON.stringify(body) !== initial.current) {
        const saved = await scheduleOrderBatch(draft.batch, body);
        // 到货安排已经存进批次、批次版本变了：记下新版本和已存的安排，
        // 后面导出失败再点一次时不会拿旧版本去存（那样必然被当成“已被别人改过”拒绝）
        initial.current = JSON.stringify(body);
        order.setDraft((d) => (d?.batch ? { ...d, batch: batchAfterSave(d.batch, saved) } : d));
      }
      await deliverBusinessFile(await exportDocument(exportBody(draft, schedule, { format, markOrdered, templateId })), save);
      emit('erp-business-changed');
      done(exportedMessage(draft, markOrdered));
    });
  const batch = draft?.batch;
  return (
    <ManagementDialog
      title={batch ? '订货单 ' + batch.number : '导出订货单'}
      subtitle={draft ? draft.supplierName + ' · ' + draft.purchases.map((p) => p.number).join('、') : undefined}
      size="lg"
      close={close}
      busy={busy}
      footer={
        <OrderFooter
          {...{ busy, problem, close, showPreview, showWord, exportOrder }}
          hasDraft={!!draft}
          ordered={!!batch}
          previewing={!!preview}
          back={() => setPreview(null)}
        />
      }
    >
      <FormMessage>{error || problem}</FormMessage>
      {!draft ? (
        <p className="help-text" role="status">
          {busy ? '正在读取采购单…' : ''}
        </p>
      ) : preview ? (
        <PreviewPane preview={preview} />
      ) : (
        <>
          <OrderRows draft={draft} schedule={schedule} setSchedule={order.setSchedule} busy={busy} />
          <FileChoice {...{ format, setFormat, templateId, setTemplateId, busy }} templates={order.templates} />
        </>
      )}
    </ManagementDialog>
  );
}
