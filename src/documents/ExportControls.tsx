import { Download, Eye } from 'lucide-react';
import { pageHref } from '../../shared/core/index';
import { MenuItem, MoreMenu } from '../ui/index';
import type { DocumentExportStatus, DocumentFormat } from '../../shared/documents/index';
import { ExportFileCard, afterSaved } from './export-file';
import { FormatSelect } from './ExportDialog';

/*
 * 送货单导出窗里送货单自己的几块（BusinessExport.tsx 用）：说明和模板设置入口、一排操作、“导出并出库”那一行、办完的结果。
 * 只排版，数据和动作由 BusinessExport 传进来；模板下拉、格式下拉是单据导出窗的公共部分（ExportDialog.tsx）。
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
      <a className="adm-export-link" href={pageHref('ai-settings', { tab: 'templates' })}>
        模板设置
      </a>
    </header>
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
        <MenuItem disabled={o.exportBlocked} onClick={o.previewWord}>
          预览Word排版
        </MenuItem>
      </MoreMenu>
    </div>
  );
}

/** 待送货的“导出并出库”那一行：选格式、一个主按钮 */
export function FormalExportRow(o: {
  format: DocumentFormat;
  setFormat: (f: DocumentFormat) => void;
  busy: boolean;
  disabled: boolean;
  run: () => void;
}) {
  return (
    <div className="adm-export-formal">
      <div className="adm-export-formal-text">
        <strong>导出并出库</strong>
        <small>{afterSaved.shipped}；客户收到后再点“确认送达”。</small>
      </div>
      <FormatSelect ariaLabel="出库送货单文件格式" value={o.format} change={o.setFormat} disabled={o.busy} />
      <button className="primary" disabled={o.disabled} onClick={o.run}>
        导出并出库
      </button>
    </div>
  );
}

/** 办完的结果：办成的一句话、导出好的文件（可以再下载）；出错的原因在窗口最上面 */
export function ExportOutcome(o: { done: string; file: DocumentExportStatus | null }) {
  return (
    <>
      {o.done && (
        <p className="adm-inline-status" role="status">
          {o.done}
        </p>
      )}
      {o.file && <ExportFileCard file={o.file} />}
    </>
  );
}
