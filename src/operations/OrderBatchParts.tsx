import { ArrowLeft } from 'lucide-react';
import { priceText, type OrderBatchDraft } from '../../shared/business/index';
import { documentFormats, type BusinessForm, type DocumentFormat, type DocumentTemplate } from '../../shared/documents/index';
import { EditorFooter, Hint, MoreMenu, Section } from '../ui/index';
import BusinessFormPreview from '../documents/BusinessFormPreview';
import { WordFilePreview, afterSaved, type WordFile } from '../documents/export-file';
import OrderSheetRow from './OrderSheetRow';
import type { RowDrafts } from './BatchSchedule';

/** 订货单导出窗口（OrderBatchDialog.tsx）的几块：底部按钮、订哪些纸板、文件格式和模板、预览。 */

/** 窗口里的预览：按模板排好的内容，或者 Word 排版的文件 */
export type Preview = { form: BusinessForm } | { file: WordFile };

type FooterProps = {
  busy: boolean;
  hasDraft: boolean;
  /** 这几张都已经订过货（重新导出）：主按钮写“重新导出订货单”，导出不再改状态 */
  ordered: boolean;
  previewing: boolean;
  problem: string;
  close: () => void;
  back: () => void;
  showPreview: () => void;
  showWord: () => void;
  exportOrder: (markOrdered: boolean) => void;
};

/** 窗口底部：取消、预览或返回修改、“更多”（Word 排版、只导出文件）、主按钮导出 */
export function OrderFooter(o: FooterProps) {
  const blocked = o.busy || !o.hasDraft || !!o.problem;
  return (
    <EditorFooter
      note={o.previewing ? '这是导出后的样子。' : o.ordered ? '改过的到货安排一起保存。' : afterSaved.ordered + '。'}
    >
      <button type="button" className="secondary" disabled={o.busy && !o.hasDraft} onClick={o.close}>
        取消
      </button>
      {o.previewing ? (
        <button type="button" className="secondary" disabled={o.busy} onClick={o.back}>
          <ArrowLeft size={14} aria-hidden="true" />
          返回修改
        </button>
      ) : (
        <button type="button" className="secondary" disabled={o.busy || !o.hasDraft} onClick={o.showPreview}>
          预览
        </button>
      )}
      <MoreMenu text="更多" label="订货单的更多操作">
        <button type="button" role="menuitem" disabled={blocked} onClick={o.showWord}>
          预览 Word 排版
        </button>
        {!o.ordered && (
          <button type="button" role="menuitem" disabled={blocked} onClick={() => o.exportOrder(false)}>
            只导出文件，不改状态
          </button>
        )}
      </MoreMenu>
      <button type="button" className="primary" disabled={blocked} onClick={() => o.exportOrder(true)}>
        {o.busy && o.hasDraft ? '正在导出…' : o.ordered ? '重新导出订货单' : '导出订货单'}
      </button>
    </EditorFooter>
  );
}

/** 订哪些纸板：每行一种纸板和它的到货安排；几张合并时先说明合成一行的规矩 */
export function OrderRows(o: {
  draft: OrderBatchDraft;
  schedule: RowDrafts;
  setSchedule: (change: (s: RowDrafts) => RowDrafts) => void;
  busy: boolean;
}) {
  return (
    <>
      {o.draft.purchases.length > 1 && (
        <Hint>同一种纸板合成一行写总数；系统里的采购单不合并，到货时按下单先后分回各张采购单。</Hint>
      )}
      <Section title={'订哪些纸板 · ' + o.draft.rows.length + ' 行'}>
        <div className="ob-rows">
          {o.draft.rows.map((r) => (
            <OrderSheetRow
              key={r.key}
              row={r}
              note={priceText(r.unitPrice, r.priceBasis, r.unit)}
              value={o.schedule[r.key] || []}
              disabled={o.busy}
              onChange={(v) => o.setSchedule((s) => ({ ...s, [r.key]: v }))}
            />
          ))}
        </div>
        <p className="ob-hint">到货日期可以不写，以后在采购单详情的订货单一节里改。</p>
      </Section>
    </>
  );
}

/** 文件：格式（Word、Excel），模板多于一套时选模板 */
export function FileChoice(o: {
  format: DocumentFormat;
  setFormat: (f: DocumentFormat) => void;
  templateId: string;
  setTemplateId: (id: string) => void;
  templates: DocumentTemplate[];
  busy: boolean;
}) {
  return (
    <Section title="文件">
      <div className="ob-file">
        <label>
          <span>格式</span>
          <select
            aria-label="订货单文件格式"
            value={o.format}
            disabled={o.busy}
            onChange={(e) => {
              // 只收选项里的格式
              const picked = documentFormats.find((f) => f === e.currentTarget.value);
              if (picked) o.setFormat(picked);
            }}
          >
            <option value="docx">Word</option>
            <option value="xlsx">Excel</option>
          </select>
        </label>
        {o.templates.length > 1 && (
          <label>
            <span>模板</span>
            <select
              aria-label="订货单模板"
              value={o.templateId}
              disabled={o.busy}
              onChange={(e) => o.setTemplateId(e.target.value)}
            >
              <option value="">默认模板</option>
              {o.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </Section>
  );
}

/** 预览：Word 排版的文件，或者按模板排好的内容 */
export function PreviewPane({ preview }: { preview: Preview }) {
  return (
    <div className="ob-preview">
      {'file' in preview ? <WordFilePreview file={preview.file} /> : <BusinessFormPreview form={preview.form} />}
    </div>
  );
}
