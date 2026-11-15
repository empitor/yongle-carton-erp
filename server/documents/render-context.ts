import { factoryName, spacedTitle, totalLine } from '../../shared/documents/index.js';
import { AppError } from '../core/index.js';
import type { BusinessForm } from '../../shared/documents/index.js';
import { planLayout } from './layout.js';
import { MIN_PT, emMm, fitPt, lineMm } from './measure.js';
import { CELL_TEXT_INSET_MM, TITLE_SPACING_PT } from './paper.js';
/**
 * 排版前两种格式共用的一轮检查：每一格按版式找能放下的字号，放不下就拒绝（不生成文件、不建导出记录、不改业务状态）。
 * 算出的字号和尺寸交给 render-docx.ts、render-xlsx.ts 照着画。
 */
type Layout = ReturnType<typeof planLayout>;
/** 抬头标题栏尽量落在纸面中间：左右两块按列宽各取约三分之一 */
const TITLE_SPAN = { from: 0.34, to: 0.66 } as const;
/** 明细列至少这么多，公司名才从商标后面那一列开始（列太少就和商标挤在同一列） */
const LOGO_OWN_COLUMN_MIN = 3;
/** 抬头第一行算字号时再留的余量 */
const HEAD_SAFETY_MM = 0.3;
/** 每个签字位至少留给签名横线的宽度 */
const SIGNATURE_BLANK_MM = 21;
/** 竖排联次说明：能用的宽度和基准字号 */
const COPY_LABEL = { widthMm: 5.5, pt: 8 } as const;
type Fit = (text: string, width: number, height: number, base: number, where: { field: string; row?: number }) => number;
const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);

/** 按版式找放得下的字号；最小字号也放不下就拒绝，说清是哪一格 */
function fitter(form: BusinessForm): Fit {
  const fail = (field: string, row?: number): never => {
    throw new AppError(
      `单据“${form.number}”${row ? `第 ${row} 行明细` : '的'}“${field}”内容过长，最小 ${MIN_PT} 磅仍放不下。请缩短内容或换更大的纸张后重新导出。`,
      400,
      'document_layout_overflow',
    );
  };
  return (text, width, height, base, where) =>
    fitPt(text, width, base, height) ?? fail(where.field, where.row);
}

/** 每张纸的明细：按每张行数切开，不够的补空行 */
function pagesOf(form: BusinessForm, L: Layout) {
  const N = L.rowsPerPage,
    pageCount = Math.max(1, Math.ceil(form.rows.length / N));
  return Array.from({ length: pageCount }, (_, p) => {
    const rows = form.rows.slice(p * N, (p + 1) * N);
    return [...rows, ...Array.from({ length: N - rows.length }, () => L.keys.map(() => ''))];
  });
}

/** 信息格每一格合并哪几列、多宽、用多大字 */
function infoCellsOf(L: Layout, fit: Fit) {
  const { colMm, slotColumns, page, size } = L;
  return L.infoRows.map((items, r) => {
    let slot = 0;
    return items.map(({ k, v, slots }) => {
      const c1 = slotColumns[slot],
        c2 = slotColumns[slot + slots],
        width = sum(colMm.slice(c1, c2));
      slot += slots;
      const pt = fit(k + '：' + v, width - CELL_TEXT_INSET_MM, L.infoRowMm[r] - page.padMm * 2, size, { field: k });
      return { k, v, c1, c2, width, pt };
    });
  });
}

/** 抬头：公司名、标题、单号各占哪几列（c0 起到 l 是公司名，l 到 r 是标题，r 之后是单号） */
function headColumns(L: Layout) {
  const { keys, colMm, wide } = L;
  const c0 = L.showLogo && keys.length >= LOGO_OWN_COLUMN_MIN ? 2 : 1,
    cum = colMm.map((_, i) => sum(colMm.slice(0, i + 1))),
    near = (target: number) =>
      cum.reduce((best, v, i) => (Math.abs(v - target) < Math.abs(cum[best] - target) ? i : best), 0) + 1,
    l = wide
      ? Math.max(c0, Math.min(keys.length - 2, near(L.bodyMm * TITLE_SPAN.from)))
      : keys.length - 1,
    r = wide
      ? Math.min(keys.length - 1, Math.max(l + 1, near(L.bodyMm * TITLE_SPAN.to)))
      : keys.length - 1;
  return { c0, l, r, headFirstMm: L.headMm - lineMm(L.small) };
}

/** 抬头里公司名、标题、单号、日期的字号 */
function headPts(form: BusinessForm, L: Layout, company: string, fit: Fit) {
  const { colMm, page, size, small, wide } = L;
  const { c0, l, r, headFirstMm } = headColumns(L);
  const companyPt = fit(
      company,
      Math.min(L.sideMm - L.logoColMm, sum(colMm.slice(c0 - 1, l))) - CELL_TEXT_INSET_MM,
      headFirstMm - HEAD_SAFETY_MM,
      L.companyPt,
      { field: '公司名称' },
    ),
    titleSpacingMm = spacedTitle(form.title) ? emMm(TITLE_SPACING_PT) * form.title.length : 0,
    titlePt = fit(
      form.title,
      Math.min(L.bodyMm - L.sideMm * 2 - titleSpacingMm, wide ? sum(colMm.slice(l, r)) : L.bodyMm) -
        CELL_TEXT_INSET_MM,
      Math.min(L.headMm - page.padMm * 2 - 1, wide ? headFirstMm - HEAD_SAFETY_MM : L.extraHeadMm),
      L.titlePt,
      { field: '单据标题' },
    ),
    numberPt = fit(
      'No. ' + L.number,
      Math.min(L.sideMm, sum(colMm.slice(r))) - CELL_TEXT_INSET_MM,
      Math.min(lineMm(size + 2), headFirstMm - HEAD_SAFETY_MM),
      size + 2,
      { field: '单号' },
    ),
    datePt = L.date
      ? fit(L.date[0] + '：' + L.date[1], L.sideMm - CELL_TEXT_INSET_MM, lineMm(small), small, {
          field: L.date[0],
        })
      : small;
  return { c0, l, r, headFirstMm, companyPt, titlePt, numberPt, datePt };
}

/** 签字栏一行的文字和字号（每个签字位同一个字号） */
function signaturesOf(form: BusinessForm, L: Layout, fit: Fit) {
  const { bodyMm, size } = L;
  const where = { field: '签字栏' };
  const signatureLine = form.signatures.map((s) => s + '：________________').join('　　'),
    signaturePt = Math.min(
      fit(signatureLine, bodyMm - CELL_TEXT_INSET_MM, lineMm(size), size, where),
      ...form.signatures.map((s) =>
        fit(s + '：', bodyMm / form.signatures.length - SIGNATURE_BLANK_MM, lineMm(size), size, where),
      ),
    );
  return { signatureLine, signaturePt, signaturePts: form.signatures.map(() => signaturePt) };
}

/** 明细、备注、合计每一格的字号；放不下的在这里就拒绝 */
function bodyPts(form: BusinessForm, L: Layout, fit: Fit) {
  const { page, size, colMm, total } = L;
  const cellPt = (text: string, i: number, row?: number) =>
      fit(text, colMm[i] - CELL_TEXT_INSET_MM, L.rowMm - page.padMm * 2, size, {
        field: form.headers[i],
        row,
      }),
    notesPt = fit(form.notes, L.notesW, L.notesMm - page.padMm * 2, size, { field: '备注' }),
    totalPt = total
      ? fit(totalLine(total), L.bodyMm - CELL_TEXT_INSET_MM, L.totalMm - page.padMm * 2, size, {
          field: '合计金额',
        })
      : size;
  return { cellPt, notesPt, totalPt };
}

/** 信息格里有模板没留位置的字段就拒绝 */
function checkInfoFields(form: BusinessForm, L: Layout) {
  if (!form.kind) return;
  for (const [k] of L.info)
    if (!L.infoKeys.includes(k))
      throw new AppError(
        `单据“${form.number}”的“${k}”在模板里没有位置，请在单据模板里加上这一格后重新导出。`,
        400,
        'document_layout_overflow',
      );
}

export function prepareRender(form: BusinessForm) {
  const L = planLayout(form),
    { page, size, small, keys, colMm, total, draft } = L,
    company = form.companyName || factoryName,
    font = form.fontFamily || '宋体',
    fit = fitter(form),
    body = bodyPts(form, L, fit),
    infoCells = infoCellsOf(L, fit);
  // 两种格式在生成字节前完成同一轮检查。失败时不创建导出回执、文件或业务状态变更。
  form.rows.forEach((r, i) => r.forEach((text, j) => body.cellPt(text, j, i + 1)));
  checkInfoFields(form, L);
  const head = headPts(form, L, company, fit),
    signatures = signaturesOf(form, L, fit),
    copyPt = L.copyLabels
      ? fit(L.copyLabels, page.height - page.top - page.bottom, COPY_LABEL.widthMm, COPY_LABEL.pt, {
          field: '联次说明',
        })
      : COPY_LABEL.pt;
  const title = company + ' ' + form.title + (draft ? ' ' + draft.replace(' · ', ' ') : '');
  return {
    form,
    L,
    page,
    size,
    small,
    keys,
    colMm,
    total,
    draft,
    company,
    color: form.color || 'E8EEF0',
    font,
    titleFont: font === '宋体' ? '黑体' : font,
    pages: pagesOf(form, L),
    ...body,
    infoCells,
    wide: L.wide,
    ...head,
    ...signatures,
    copyPt,
    title,
  };
}
export type RenderContext = ReturnType<typeof prepareRender>;
