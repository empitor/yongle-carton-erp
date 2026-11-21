import { useEffect, useState } from 'react';
import { canEditBusiness, useAuthState, useAction } from '../ui/index';
import type { BusinessForm, DocumentExportStatus, DocumentFormat } from '../../shared/documents/index';
import { errorMessage } from '../../shared/core/index';
import { previewWordFile, readDeliveryForm } from './document-api';
import { DocumentExportDialog, TemplateSelect, useExportFile, useExportTemplates, type ExportPreview } from './ExportDialog';
import { ExportButtons, ExportHeader, ExportOutcome, FormalExportRow } from './ExportControls';

/** 送货单（要 id、number、version、status） */
type DeliveryDoc = { id: number; number: string; version: number; status?: string };

/** 窗口里原地显示的预览和它的标题（“送货单预览 · 还没出库”） */
type DeliveryPreview = { paper: ExportPreview; title: string };
const previewTitle = (form: BusinessForm) => (form.title || '单据') + '预览' + (form.draft ? ' · 还没出库' : '');

/**
 * 送货单的预览与导出窗口，全站只有这一个：待送货的导出就是出库，已出库的重新下载或打印、不改库存。
 * 正式导出（出库）完成后 onDone 带着结果，窗口由调用方关掉。外壳、模板下拉、格式下拉和导出文件用单据导出窗的公共部分
 * （ExportDialog.tsx，订货单 operations/OrderBatchDialog.tsx 也用）。
 * 正文：一句当前状态的说明和模板设置入口、模板下拉、一排操作（预览、导出 Word、导出 Excel，少用的“预览 Word 排版”进“更多”）；
 * 待送货的只有“导出并出库”。
 */
export function DeliveryExportDialog({
  doc,
  close,
  onDone,
}: {
  doc: DeliveryDoc;
  close: () => void;
  /** 导出并出库完成后：窗口关掉，提示交给页面 */
  onDone: (message: string) => void;
}) {
  const d = useDeliveryExport(doc, onDone);
  return (
    <DocumentExportDialog
      title={(d.preview ? d.preview.title : '送货单') + ' · ' + doc.number}
      subtitle={d.draftDelivery ? '导出送货单就是出库' : '重新下载或打印，不改库存'}
      // 纸面按实际尺寸画（连续纸 241mm 比中等窗口宽），预览时换大窗口
      size={d.preview ? 'xl' : 'md'}
      close={close}
      busy={d.busy}
      error={d.error}
      preview={d.preview ? d.preview.paper : null}
      back={() => d.setPreview(null)}
    >
      <section className="record-section adm-export adm-export-bare" aria-label="送货单操作">
        <ExportHeader status={doc.status} />
        <div className="adm-export-row">
          <TemplateSelect
            ariaLabel="单据导出模板"
            templates={d.templates}
            disabled={d.busy}
            value={d.templateId}
            change={d.chooseTemplate}
          />
          <ExportButtons {...d.buttons} />
        </div>
        {d.draftDelivery && <FormalExportRow {...d.formal} />}
        <ExportOutcome done={d.done} file={d.file} />
      </section>
    </DocumentExportDialog>
  );
}

/** 打开时（送货单、版本、登录的人、选的模板变了时再）读要印的内容 */
function useDeliveryForm(o: { id: number; version: number; templateId: string; draftDelivery: boolean }) {
  const { id, version, templateId, draftDelivery } = o;
  const actorId = useAuthState()?.actor?.id;
  const [form, setForm] = useState<BusinessForm | null>(null),
    [format, setFormat] = useState<DocumentFormat>('docx'),
    [loadError, setLoadError] = useState('');
  useEffect(() => {
    if (actorId === undefined) return;
    let active = true;
    readDeliveryForm(id, { templateId, shipping: draftDelivery })
      .then((f) => {
        if (!active) return;
        setForm(f);
        setFormat(f.defaultFormat || 'docx');
      })
      .catch((e: unknown) => active && setLoadError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, [id, version, actorId, templateId, draftDelivery]);
  return { form, setForm, format, setFormat, loadError, setLoadError };
}

/** 能不能导出：正在办、没有改的权限、要印的内容还没读到、已取消或已撤销的送货单，都不能 */
const exportBlockedFor = (o: { status?: string; busy: boolean; canEdit: boolean; form: BusinessForm | null }) =>
  o.busy || !o.canEdit || !o.form || ['cancelled', 'reversed'].includes(o.status || '');

/** 送货单导出窗的数据和动作：读要印的内容和模板、预览、导出（待送货的导出并出库） */
function useDeliveryExport({ id, version, status }: DeliveryDoc, onDone: (message: string) => void) {
  const canEdit = canEditBusiness(useAuthState());
  const [templateId, setTemplateId] = useState(''),
    [file, setFile] = useState<DocumentExportStatus | null>(null),
    [done, setDone] = useState(''),
    [preview, setPreview] = useState<DeliveryPreview | null>(null);
  const action = useAction(),
    busy = action.busy,
    exportFile = useExportFile(),
    templates = useExportTemplates('delivery');
  const draftDelivery = status === 'draft';
  const source = useDeliveryForm({ id, version, templateId, draftDelivery }),
    { form } = source;
  const work = (job: () => Promise<void>) => {
    setDone('');
    source.setLoadError('');
    return void action.run(job);
  };
  const download = (f: DocumentFormat, ship = false) =>
    work(async () => {
      const generated = await exportFile({
        kind: 'delivery',
        id,
        format: f,
        markShipped: ship,
        templateId: form?.templateId,
        expectedVersion: version,
        requestId: crypto.randomUUID(),
      });
      setFile(generated.file);
      await generated.saved;
      if (ship) onDone('送货单已导出，已出库，送货中。客户收到后点“确认送达”。');
      else setDone('文件已交付。');
    });
  const exportBlocked = exportBlockedFor({ status, busy, canEdit, form });
  const showPreview = () =>
    work(async () => {
      const current = await readDeliveryForm(id, { templateId, shipping: draftDelivery });
      source.setForm(current);
      setPreview({ paper: { form: current }, title: previewTitle(current) });
    });
  // 只排版给人看：走只读预览接口，不写导出记录、不改状态；待送货的按导出并出库后印出来的样子
  const previewWord = () =>
    work(async () => {
      if (!form) return;
      const override = form.templateId ? { templateId: form.templateId } : {};
      const wordFile = await previewWordFile({ kind: 'delivery', id, ...override, shipping: draftDelivery });
      setPreview({ paper: { file: wordFile }, title: previewTitle(form) });
    });
  return {
    busy,
    draftDelivery,
    preview,
    setPreview,
    done,
    file,
    error: action.error || source.loadError || templates.error,
    templates: templates.templates,
    templateId: templateId || templates.defaultId,
    chooseTemplate: (next: string) => {
      setTemplateId(next);
      source.setForm(null);
    },
    buttons: { busy, canEdit, exportBlocked, draftDelivery, preview: showPreview, previewWord, download: (f: DocumentFormat) => download(f) },
    formal: { format: source.format, setFormat: source.setFormat, busy, disabled: exportBlocked, run: () => download(source.format, true) },
  };
}
