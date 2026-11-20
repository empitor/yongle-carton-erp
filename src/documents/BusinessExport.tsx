import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { canEditBusiness, useAuthState, useAction, useSaveFile, EditorFooter, ManagementDialog } from '../ui/index';
import type { BusinessForm, DocumentExportStatus, DocumentFormat, DocumentTemplate } from '../../shared/documents/index';
import { errorMessage } from '../../shared/core/index';
import { deliverBusinessFile, WordFilePreview, type WordFile } from './export-file';
import { exportDocument, previewWordFile, readDeliveryForm, readDocumentTemplates } from './document-api';
import BusinessFormPreview from './BusinessFormPreview';
import { ExportButtons, ExportHeader, ExportOutcome, FormalExportRow, TemplatePicker } from './ExportControls';

type Format = DocumentFormat;
/** 窗口里原地显示的预览：要印的内容，预览 Word 排版时还有文件内容 */
type ExportPreviewData = { form: BusinessForm; file?: WordFile; format: Format };

/** 预览的标题和纸面 */
const previewTitle = (p: ExportPreviewData) => (p.form.title || '单据') + '预览' + (p.form.draft ? ' · 还没出库' : '');
const PreviewPaper = ({ preview }: { preview: ExportPreviewData }) =>
  preview.file ? <WordFilePreview file={preview.file} /> : <BusinessFormPreview form={preview.form} />;

/** 送货单（要 id、number、version、status） */
type DeliveryDoc = { id: number; number: string; version: number; status?: string };

/**
 * 送货单的预览与导出窗口，全站只有这一个：待送货的导出就是出库，已出库的重新下载或打印、不改库存。
 * 正式导出（出库）完成后 onDone 带着结果，窗口由调用方关掉。
 * 预览（含“预览 Word 排版”）在这个窗口里原地换成纸面，“返回”回到导出，不再叠一个窗口。
 * 采购订货单的导出在采购单列表勾选后的订货单窗口（operations/OrderBatchDialog.tsx）。
 */
export function DeliveryExportDialog({
  doc,
  close,
  onDone,
}: {
  doc: DeliveryDoc;
  close: () => void;
  onDone: (message: string) => void;
}) {
  const [preview, setPreview] = useState<ExportPreviewData | null>(null);
  return (
    <ManagementDialog
      title={preview ? previewTitle(preview) + ' · ' + doc.number : '送货单 · ' + doc.number}
      subtitle={doc.status === 'draft' ? '导出送货单就是出库' : '重新下载或打印，不改库存'}
      // 纸面按实际尺寸画（连续纸 241mm 比中等窗口宽），预览时换大窗口
      size={preview ? 'xl' : 'md'}
      close={close}
      footer={
        <EditorFooter>
          <button type="button" className="secondary" onClick={close}>
            取消
          </button>
          {preview && (
            <button type="button" className="secondary" onClick={() => setPreview(null)}>
              <ArrowLeft size={14} aria-hidden="true" />
              返回导出
            </button>
          )}
        </EditorFooter>
      }
    >
      {preview ? <PreviewPaper preview={preview} /> : <DeliveryExport doc={doc} onDone={onDone} onPreview={setPreview} />}
    </ManagementDialog>
  );
}

/** 打开时（送货单、版本、登录的人、选的模板变了时再）读要印的内容和送货单的模板 */
function useExportSource(o: { id: number; version: number; templateId: string; draftDelivery: boolean }) {
  const { id, version, templateId, draftDelivery } = o;
  const actorId = useAuthState()?.actor?.id;
  const [form, setForm] = useState<BusinessForm | null>(null),
    [templates, setTemplates] = useState<DocumentTemplate[]>([]),
    [format, setFormat] = useState<Format>('docx'),
    [loadError, setLoadError] = useState('');
  useEffect(() => {
    if (actorId === undefined) return;
    let active = true;
    Promise.all([readDeliveryForm(id, { templateId, shipping: draftDelivery }), readDocumentTemplates()])
      .then(([f, settings]) => {
        if (!active) return;
        setForm(f);
        setFormat(f.defaultFormat || 'docx');
        setTemplates(settings.templates.filter((t) => t.kind === 'delivery'));
      })
      .catch((e: unknown) => active && setLoadError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, [id, version, actorId, templateId, draftDelivery]);
  return { form, setForm, templates, format, setFormat, loadError, setLoadError };
}

/** 能不能导出：正在办、没有改的权限、要印的内容还没读到、已取消或已撤销的送货单，都不能 */
const exportBlockedFor = (o: { status?: string; busy: boolean; canEdit: boolean; form: BusinessForm | null }) =>
  o.busy || !o.canEdit || !o.form || ['cancelled', 'reversed'].includes(o.status || '');

/**
 * 送货单导出窗的正文：一句当前状态的说明和模板设置入口、模板下拉、一排操作（预览、导出 Word、导出 Excel，
 * 少用的“预览 Word 排版”进“更多”）；待送货的只有“导出并出库”。预览交给窗口原地显示。
 */
function DeliveryExport({
  doc: { id, version, status },
  onDone,
  onPreview,
}: {
  doc: DeliveryDoc;
  /** 导出并出库完成后：窗口关掉，提示交给页面 */
  onDone: (message: string) => void;
  onPreview: (preview: ExportPreviewData) => void;
}) {
  const auth = useAuthState(),
    [templateId, setTemplateId] = useState(''),
    [file, setFile] = useState<DocumentExportStatus | null>(null),
    [done, setDone] = useState('');
  const action = useAction(),
    busy = action.busy,
    save = useSaveFile();
  const canEdit = canEditBusiness(auth);
  const draftDelivery = status === 'draft';
  const source = useExportSource({ id, version, templateId, draftDelivery }),
    { form } = source;
  const work = (job: () => Promise<void>) => {
    setDone('');
    source.setLoadError('');
    return void action.run(job);
  };
  const download = (f: Format, ship = false) =>
    work(async () => {
      const generated = await exportDocument({
        kind: 'delivery',
        id,
        format: f,
        markShipped: ship,
        templateId: form?.templateId,
        expectedVersion: version,
        requestId: crypto.randomUUID(),
      });
      setFile(generated);
      await deliverBusinessFile(generated, save);
      if (ship) onDone('送货单已导出，已出库，送货中。客户收到后点“确认送达”。');
      else setDone('文件已交付。');
    });
  const exportBlocked = exportBlockedFor({ status, busy, canEdit, form });
  const templateOverride = form?.templateId ? { templateId: form.templateId } : {};
  const preview = () =>
    work(async () => {
      const current = await readDeliveryForm(id, { templateId, shipping: draftDelivery });
      source.setForm(current);
      onPreview({ form: current, format: 'xlsx' });
    });
  // 只排版给人看：走只读预览接口，不写导出记录、不改状态；待送货的按导出并出库后印出来的样子
  const previewWord = () =>
    work(async () => {
      if (!form) return;
      const wordFile = await previewWordFile({ kind: 'delivery', id, ...templateOverride, shipping: draftDelivery });
      onPreview({ form, file: wordFile, format: 'docx' });
    });
  return (
    <section className="record-section adm-export adm-export-bare" aria-label="送货单操作">
      <ExportHeader status={status} />
      <div className="adm-export-row">
        <TemplatePicker
          templates={source.templates}
          busy={busy}
          value={templateId || form?.templateId || ''}
          change={(next) => {
            setTemplateId(next);
            source.setForm(null);
          }}
        />
        <ExportButtons
          busy={busy}
          canEdit={canEdit}
          exportBlocked={exportBlocked}
          draftDelivery={draftDelivery}
          preview={preview}
          previewWord={previewWord}
          download={(f) => download(f)}
        />
      </div>
      {draftDelivery && (
        <FormalExportRow
          format={source.format}
          setFormat={source.setFormat}
          disabled={exportBlocked}
          run={() => download(source.format, true)}
        />
      )}
      <ExportOutcome done={done} error={action.error || source.loadError} file={file} />
    </section>
  );
}
