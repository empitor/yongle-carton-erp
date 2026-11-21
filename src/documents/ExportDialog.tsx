import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  documentFormats,
  type BusinessForm,
  type DocumentFormat,
  type DocumentKind,
  type DocumentTemplate,
} from '../../shared/documents/index';
import { EditorFooter, FormMessage, ManagementDialog, useLoad, useSaveFile } from '../ui/index';
import BusinessFormPreview from './BusinessFormPreview';
import { WordFilePreview, deliverBusinessFile, type WordFile } from './export-file';
import { exportDocument, readDocumentTemplates } from './document-api';

/*
 * 单据导出窗：送货单（BusinessExport.tsx）、订货单（operations/OrderBatchDialog.tsx）共用的那一半——
 * 窗口外壳和原地预览、底栏的“取消”“返回导出”、模板下拉、格式下拉、正式导出并保存文件。
 * 取数、导出参数、窗口里的其他选项和按钮各单据自己写。
 */

/** 窗口里原地显示的预览：按模板排好的内容，或者 Word 排版的文件 */
export type ExportPreview = { form: BusinessForm } | { file: WordFile };

/** 正式导出交给服务端的内容 */
export type ExportBody = Parameters<typeof exportDocument>[0];

/**
 * 导出窗外壳：出错提示在最上面；没在预览时显示各单据自己的选项（children），预览时原地换成纸面，
 * 底栏“返回导出”回去，不再叠一个窗口。底栏左边一句说明，右边“取消”、“返回导出”、各单据自己的按钮（actions）。
 */
export function DocumentExportDialog(o: {
  title: string;
  subtitle?: string;
  size: 'md' | 'lg' | 'xl';
  close: () => void;
  /** 正在读或正在办：关窗、取消、返回都先不能点 */
  busy: boolean;
  error: string;
  preview: ExportPreview | null;
  back: () => void;
  note?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ManagementDialog
      title={o.title}
      subtitle={o.subtitle}
      size={o.size}
      close={o.close}
      busy={o.busy}
      footer={
        <EditorFooter note={o.note}>
          <button type="button" className="secondary" disabled={o.busy} onClick={o.close}>
            取消
          </button>
          {o.preview && (
            <button type="button" className="secondary" disabled={o.busy} onClick={o.back}>
              <ArrowLeft size={14} aria-hidden="true" />
              返回导出
            </button>
          )}
          {o.actions}
        </EditorFooter>
      }
    >
      <FormMessage>{o.error}</FormMessage>
      {o.preview ? (
        <div className="export-preview">
          {'file' in o.preview ? <WordFilePreview file={o.preview.file} /> : <BusinessFormPreview form={o.preview.form} />}
        </div>
      ) : (
        o.children
      )}
    </ManagementDialog>
  );
}

/** 这种单据能用的模板和默认的那套（打开窗口时读一次） */
export function useExportTemplates(kind: DocumentKind) {
  const { data, error } = useLoad(kind, () => readDocumentTemplates());
  return {
    templates: data ? data.templates.filter((t) => t.kind === kind) : [],
    defaultId: data ? data.defaults[kind] : '',
    error,
  };
}

/** 模板下拉：显示正在用的那套（没选过就是默认的）；模板还没读到时不显示 */
export function TemplateSelect(o: {
  ariaLabel: string;
  templates: DocumentTemplate[];
  value: string;
  change: (id: string) => void;
  disabled: boolean;
}) {
  if (!o.templates.length) return null;
  return (
    <label>
      <span>模板</span>
      <select aria-label={o.ariaLabel} disabled={o.disabled} value={o.value} onChange={(e) => o.change(e.target.value)}>
        {o.templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 文件格式下拉：Word、Excel */
export function FormatSelect(o: {
  ariaLabel: string;
  value: DocumentFormat;
  change: (f: DocumentFormat) => void;
  disabled: boolean;
}) {
  return (
    <select
      aria-label={o.ariaLabel}
      value={o.value}
      disabled={o.disabled}
      onChange={(e) => {
        // 只收选项里的格式
        const picked = documentFormats.find((f) => f === e.currentTarget.value);
        if (picked) o.change(picked);
      }}
    >
      <option value="docx">Word</option>
      <option value="xlsx">Excel</option>
    </select>
  );
}

/**
 * 正式导出：服务端生成文件，再下载、核对后保存（浏览器下载，安卓 App 里存进手机“下载”）。
 * 交回生成的文件和保存这一步：先拿到文件，保存没成时窗口里还能留着它再下载一次。
 */
export function useExportFile() {
  const save = useSaveFile();
  return async (body: ExportBody) => {
    const file = await exportDocument(body);
    return { file, saved: deliverBusinessFile(file, save) };
  };
}
