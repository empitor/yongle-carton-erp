import { priceText, type OrderBatchDraft } from '../../shared/business/index';
import type { DocumentFormat, DocumentTemplate } from '../../shared/documents/index';
import { Hint, MenuItem, MoreMenu, Section } from '../ui/index';
import { FormatSelect, TemplateSelect } from '../documents/index';
import OrderSheetRow from './OrderSheetRow';
import type { RowDrafts } from './BatchSchedule';

/**
 * 订货单导出窗口（OrderBatchDialog.tsx）自己的几块：底栏里订货单的按钮、订哪些纸板、文件格式和模板。
 * 窗口外壳、预览、“取消”“返回导出”、两个下拉是单据导出窗的公共部分（documents/ExportDialog.tsx）。
 */

type ActionProps = {
  busy: boolean;
  hasDraft: boolean;
  /** 这几张都已经订过货（重新导出）：主按钮写“重新导出订货单”，导出不再改状态 */
  ordered: boolean;
  previewing: boolean;
  problem: string;
  showPreview: () => void;
  showWord: () => void;
  exportOrder: (markOrdered: boolean) => void;
};

/** 底栏里订货单的按钮：预览（预览时换成公共的“返回导出”）、“更多”（Word 排版、只导出文件）、主按钮导出 */
export function OrderActions(o: ActionProps) {
  const blocked = o.busy || !o.hasDraft || !!o.problem;
  return (
    <>
      {!o.previewing && (
        <button type="button" className="secondary" disabled={o.busy || !o.hasDraft} onClick={o.showPreview}>
          预览
        </button>
      )}
      <MoreMenu text="更多" label="订货单的更多操作">
        <MenuItem disabled={blocked} onClick={o.showWord}>
          预览 Word 排版
        </MenuItem>
        {!o.ordered && (
          <MenuItem disabled={blocked} onClick={() => o.exportOrder(false)}>
            只导出文件，不改状态
          </MenuItem>
        )}
      </MoreMenu>
      <button type="button" className="primary" disabled={blocked} onClick={() => o.exportOrder(true)}>
        {o.busy && o.hasDraft ? '正在导出…' : o.ordered ? '重新导出订货单' : '导出订货单'}
      </button>
    </>
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

/** 文件：格式（Word、Excel）、模板（显示正在用的那套） */
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
          <FormatSelect ariaLabel="订货单文件格式" value={o.format} change={o.setFormat} disabled={o.busy} />
        </label>
        <TemplateSelect
          ariaLabel="订货单模板"
          templates={o.templates}
          value={o.templateId}
          change={o.setTemplateId}
          disabled={o.busy}
        />
      </div>
    </Section>
  );
}
