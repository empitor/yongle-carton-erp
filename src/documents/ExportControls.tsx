import { Download, Eye } from 'lucide-react';
import { Hint, MoreMenu } from '../ui/index';
import type { DocumentExportStatus, DocumentFormat, DocumentTemplate } from '../../shared/documents/index';
import { ExportFileCard, afterSaved } from './export-file';

/*
 * 送货单导出窗里的几块（BusinessExport.tsx 用）：说明和模板设置入口、模板下拉、一排操作、“导出并出库”那一行、办完的结果。
 * 只排版，数据和动作由 BusinessExport 传进来。
 */

/** 导出说明：已出库的重新导出不再出库；待送货的导出就是出库 */
const exportHint = (status?: string) =>
  status === 'confirmed'
    ? '按本批实际送货数量导出，重复下载不会再次出库。'
    : '点“导出并出库”：' + afterSaved.shipped + '。只想看看用“预览送货单”。';

/** 一句说明、模板设置入口 */
export function ExportHeader({ status }: { status?: string }) {
  return (
    <header>
      <p className="adm-export-hint">{exportHint(status)}</p>
      <a className="adm-export-link" href="#ai-settings?tab=templates">
        模板设置
      </a>
    </header>
  );
}

/** 模板下拉：换模板就按新模板重读要印的内容 */
export function TemplatePicker(o: { templates: DocumentTemplate[]; busy: boolean; value: string; change: (id: string) => void }) {
  if (!o.templates.length) return null;
  return (
    <label className="adm-export-template">
      <span>模板</span>
      <select aria-label="单据导出模板" disabled={o.busy} value={o.value} onChange={(e) => o.change(e.target.value)}>
        {o.templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 一排操作：预览、导出 Word、导出 Excel（待送货的没有，只有“导出并出库”），少用的“预览 Word 排版”进“更多” */
export function ExportButtons(o: {
  busy: boolean;
  canEdit: boolean;
  exportBlocked: boolean;
  draftDelivery: boolean;
  preview: () => void;
  previewWord: () => void;
  download: (f: DocumentFormat) => void;
}) {
  return (
    <div className="adm-export-buttons">
      <button className="secondary" disabled={o.busy || !o.canEdit} title="预览送货单" onClick={o.preview}>
        <Eye size={14} aria-hidden="true" />
        预览送货单
      </button>
      {!o.draftDelivery && (
        <>
          <button className="secondary" disabled={o.exportBlocked} onClick={() => o.download('docx')}>
            <Download size={14} aria-hidden="true" />
            导出Word
          </button>
          <button className="secondary" disabled={o.exportBlocked} onClick={() => o.download('xlsx')}>
            导出Excel
          </button>
        </>
      )}
      <MoreMenu label="更多送货单操作">
        <button type="button" role="menuitem" disabled={o.exportBlocked} onClick={o.previewWord}>
          预览Word排版
        </button>
      </MoreMenu>
    </div>
  );
}

/** 待送货的“导出并出库”那一行：选格式、一个主按钮 */
export function FormalExportRow({
  format,
  setFormat,
  disabled,
  run,
}: {
  format: DocumentFormat;
  setFormat: (f: DocumentFormat) => void;
  disabled: boolean;
  run: () => void;
}) {
  return (
    <div className="adm-export-formal">
      <div className="adm-export-formal-text">
        <strong>导出并出库</strong>
        <small>{afterSaved.shipped}；客户收到后再点“确认送达”。</small>
      </div>
      <select aria-label="出库送货单文件格式" value={format} onChange={(e) => setFormat(e.target.value === 'xlsx' ? 'xlsx' : 'docx')}>
        <option value="docx">Word (.docx)</option>
        <option value="xlsx">Excel (.xlsx)</option>
      </select>
      <button className="primary" disabled={disabled} onClick={run}>
        导出并出库
      </button>
    </div>
  );
}

/** 办完的结果：办成的一句话、出错的原因、导出好的文件（可以再下载） */
export function ExportOutcome(o: { done: string; error: string; file: DocumentExportStatus | null }) {
  return (
    <>
      {o.done && (
        <p className="adm-inline-status" role="status">
          {o.done}
        </p>
      )}
      {o.error && (
        <div role="alert">
          <Hint tone="danger">{o.error}</Hint>
        </div>
      )}
      {o.file && <ExportFileCard file={o.file} />}
    </>
  );
}
