import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  Header,
  Footer,
  PageNumber,
  PageOrientation,
  ImageRun,
  TextDirection,
  TableAnchorType,
  OverlapType,
  HeightRule,
  VerticalAlignTable,
  ShadingType,
  LineRuleType,
} from 'docx';
import ExcelJS from 'exceljs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { factoryName } from '../../shared/business-export.js';
import {
  splitFields,
  packInfo,
  totalParts,
  draftText,
  spacedTitle,
  templateInfoFields,
  totalLine,
} from '../../shared/document-layout.js';
import { ImportError } from '../import/errors.js';
import {
  templateHeaderText,
  documentColumns,
  documentPapers,
  purchaseColumns,
  deliveryColumns,
  templatePaper,
  templateCopyLabels,
  type DocumentTemplate,
  type DocumentColumn,
  type DocumentPaper,
} from '../../shared/document-templates.js';
import { brandLogoPng } from './brand-logo.js';
export type BusinessForm = {
  title: string;
  companyName?: string;
  color?: string;
  fontSize?: number;
  templateId?: string;
  templateRevision?: number;
  defaultFormat?: 'docx' | 'xlsx';
  kind?: 'purchase' | 'delivery';
  headerText?: string;
  footerText?: string;
  fontFamily?: string;
  orientation?: 'portrait' | 'landscape';
  density?: 'compact' | 'normal';
  paper?: DocumentPaper;
  /** 针式联单右侧竖排的联次说明，空串不印。 */
  copyLabels?: string;
  showLogo?: boolean;
  /** 每张纸固定的明细行数，由版式算出，预览和导出一致。 */
  rowsPerPage?: number;
  columnKeys?: DocumentColumn[];
  lineData?: Record<string, string>[];
  templateSnapshot?: DocumentTemplate;
  number: string;
  draft: boolean;
  sample?: boolean;
  fields: [string, string][];
  headers: string[];
  rows: string[][];
  notes: string;
  total?: string | null;
  signatures: string[];
};
export function applyDocumentTemplate(
  form: BusinessForm,
  template: DocumentTemplate,
  revision = 0,
): BusinessForm {
  const keys =
    template.columns || (template.kind === 'purchase' ? purchaseColumns : deliveryColumns);
  const originalKeys =
    form.columnKeys || (template.kind === 'purchase' ? purchaseColumns : deliveryColumns);
  const fields: [string, string][] = [...form.fields];
  if (template.companyContact || template.companyPhone)
    fields.push([
      '我方联系人',
      [template.companyContact, template.companyPhone].filter(Boolean).join(' / '),
    ]);
  if (template.kind === 'delivery' && template.companyAddress)
    fields.push(['我方地址', template.companyAddress]);
  if (template.kind === 'purchase') {
    if (template.companyAddress) fields.push(['交货地址', template.companyAddress]);
    if (template.deliveryTerms) fields.push(['交货要求', template.deliveryTerms]);
    if (template.acceptanceTerms) fields.push(['验收要求', template.acceptanceTerms]);
    if (template.paymentTerms) fields.push(['付款条件', template.paymentTerms]);
    fields.push(['税费说明', '本单未记录独立税费约定；如有约定，以本单备注为准，不自动推算税额。']);
  }
  const applied: BusinessForm = {
    ...form,
    kind: template.kind,
    companyName: template.companyName,
    title: template.title + (form.title.includes('已取消') ? '（已取消，仅供存档）' : ''),
    fields: fields.filter(([k]) => !template.hiddenFields.includes(k as any)),
    headers: keys.map((k) =>
      k === 'quantity'
        ? template.kind === 'purchase'
          ? '订购数量'
          : '本批送货数量'
        : documentColumns[k],
    ),
    rows: form.rows.map((r, i) => {
      const data = {
        ...Object.fromEntries(originalKeys.map((k, j) => [k, r[j]])),
        ...form.lineData?.[i],
      };
      return keys.map((k) => data[k] || '');
    }),
    columnKeys: keys,
    signatures: template.signatures,
    notes: [form.notes, template.footerNotes].filter(Boolean).join('\n'),
    color: template.color,
    fontSize: template.fontSize,
    fontFamily: template.fontFamily,
    orientation: template.orientation,
    density: template.density,
    paper: templatePaper(template),
    copyLabels: templateCopyLabels(template),
    showLogo: template.showLogo,
    headerText: template.headerText,
    footerText: template.footerText,
    templateId: template.id,
    templateRevision: revision,
    defaultFormat: template.defaultFormat,
    templateSnapshot: template,
  };
  return { ...applied, rowsPerPage: documentRowsPerPage(applied) };
}

const columnWeights: Record<string, number> = {
  index: 0.6,
  name: 2.1,
  specification: 3.1,
  unit: 0.8,
  quantity: 1.2,
  unitPrice: 1.6,
  amount: 1.5,
  notes: 1.7,
  productCode: 1.6,
  orderNumber: 2.2,
  customerOrderNumber: 1.7,
  dimensions: 1.8,
  material: 1.5,
  flute: 0.8,
};
const columnAlign = (key?: string) =>
  key === 'index' || key === 'unit' || key === 'flute'
    ? 'center'
    : key === 'quantity' || key === 'amount' || key === 'unitPrice'
      ? 'right'
      : 'left';
/**
 * 固定版式：每张纸版式完全相同，明细行数固定、铺满整张纸。货少只填前几行，其余空行留表格线；
 * 超过一张时续页，每张都重复抬头、信息格、备注和签字栏，合计只写在最后一张。
 * 尺寸单位都是 mm，行高按字号估算（WPS / Word 中文排版实测校准）。
 */
type PageLayout = {
  width: number;
  height: number;
  top: number;
  bottom: number;
  side: number;
  landscape: boolean;
  small: boolean;
  /** 三等分联单只有 93 mm 高，字号和行高再收一档。 */
  tight: boolean;
  /** 明细行的最小行高；规划时会把剩余高度均分进去，铺满整张纸。 */
  rowMm: number;
  /** 信息格每行最小行高 */
  infoMm: number;
  padMm: number;
  gapMm: number;
  sigMm: number;
  headerDist: number;
  footerDist: number;
};
function pageLayout(form: BusinessForm): PageLayout {
  const paper = form.paper || 'a4',
    { width, height } = documentPapers[paper],
    compact = form.density === 'compact';
  if (paper === 'a4') {
    const landscape = (form.orientation || 'landscape') === 'landscape';
    return {
      width: landscape ? height : width,
      height: landscape ? width : height,
      top: 12,
      bottom: 12,
      side: 14,
      landscape,
      small: false,
      tight: false,
      rowMm: compact ? 6.8 : 7.5,
      infoMm: 7,
      padMm: compact ? 0.8 : 1.1,
      gapMm: 2.5,
      sigMm: 12,
      headerDist: 6,
      footerDist: 6,
    };
  }
  const small = {
    landscape: false,
    small: true,
    tight: false,
    rowMm: compact ? 5.8 : 6.2,
    infoMm: 5.4,
    padMm: 0.4,
    gapMm: 1.2,
    sigMm: 8.5,
    headerDist: 2.5,
    footerDist: 2,
  };
  if (paper === 'a5')
    return { ...small, width, height, top: 7, bottom: 7, side: 10, landscape: true };
  // 针式联单两侧各有约 12.7 mm 的穿孔带，正文避开。
  return paper === 'continuous-241x93'
    ? {
        ...small,
        width,
        height,
        top: 4,
        bottom: 4,
        side: 13,
        tight: true,
        rowMm: compact ? 5 : 5.4,
        infoMm: 4.8,
        padMm: 0.3,
        gapMm: 0.6,
        sigMm: 6.5,
        headerDist: 1.5,
        footerDist: 1.2,
      }
    : { ...small, width, height, top: 6, bottom: 6, side: 13 };
}
const emMm = (pt: number) => pt * 0.3528,
  BORDER_MM = 0.2;
const measureContext = createCanvas(1, 1).getContext('2d');
// Linux 字体包是 TTC 集合；canvas 有些版本只登记集合首个 JP 族，仍包含完整 CJK 字形。
const linuxMeasurementFont = GlobalFonts.has('Noto Serif CJK SC') ? 'Noto Serif CJK SC' : 'Noto Serif CJK JP';
export function checkDocumentFonts() {
  if (process.platform === 'linux' && !GlobalFonts.has(linuxMeasurementFont))
    throw new Error('缺少 Linux 中文字体 Noto Serif CJK，请安装 fonts-noto-cjk 并刷新字体缓存后启动。');
}
/** 按字体测宽，避免把 W、数字和窄拉丁字母都当成半个汉字；额外留 6% 余量。 */
const textMm = (t: string, pt: number) => {
  measureContext.font = `${pt}px "${process.platform === 'linux' ? linuxMeasurementFont : '宋体'}"`;
  // 某些运行环境会用窄字形替代宋体汉字；汉字至少按一个 em 预留。
  return (
    [...t.replaceAll('\t', '    ')].reduce(
      (n, ch) => n + (/[\u2e80-\uffef]/.test(ch) ? pt : Math.max(measureContext.measureText(ch).width, /[WM]/.test(ch) ? pt : pt * 0.55)),
      0,
    ) *
    0.3528 *
    1.06
  );
};
const lineMm = (pt: number) => emMm(pt) * 1.3;
const linesFor = (text: string, widthMm: number, pt: number) =>
  (text || '')
    .split('\n')
    .reduce((n, t) => n + Math.max(1, Math.ceil(textMm(t, pt) / Math.max(0.1, widthMm))), 0);
/** 先确认最小字号可容纳；Word、Excel 共用同一判断，禁止裁字或撑高。 */
function fitPt(text: string, widthMm: number, basePt: number, heightMm: number) {
  for (let p = basePt; p >= 7; p -= 0.5)
    if (linesFor(text, widthMm, p) * lineMm(p) <= heightMm) return p;
  return null;
}
/** 版式规划：Word、Excel 和页面预览用同一套尺寸，算出每张能放几行明细。 */
function planLayout(form: BusinessForm) {
  const page = pageLayout(form),
    size = form.fontSize || 10,
    small = Math.max(7.5, size - 1.5),
    copyLabels = (form.copyLabels || '').trim(),
    showLogo = form.showLogo !== false,
    bodyMm = page.width - page.side * 2 - (copyLabels ? 8 : 0),
    keys = form.headers.map((_, i) => form.columnKeys?.[i] || ''),
    weights = keys.map((k) => columnWeights[k] || 1.5),
    weightSum = weights.reduce((n, v) => n + v, 0),
    colMm = weights.map((w) => (bodyMm * w) / weightSum),
    split = splitFields(form),
    total = totalParts(form),
    draft = draftText(form),
    pad2 = page.padMm * 2;
  // 抬头一行：左边商标和公司名，中间标题（左右两栏等宽，标题在整张纸正中），右边单号和日期。
  // 我方联系人、地址放到页脚一行，草稿/样张字样放到页眉，都不占正文高度，也不让行数随单据状态变化。
  const logoColMm = showLogo ? (page.small ? 11 : 15) : 0,
    sideMm = bodyMm * 0.36,
    companyRoom = sideMm - logoColMm - 3,
    companyPt = Math.max(
      9,
      Math.min(
        page.tight ? 11 : page.small ? 12 : 15,
        Math.floor((companyRoom / textMm(form.companyName || factoryName, 1)) * 2) / 2,
      ),
    ),
    titlePt = page.tight ? 14 : page.small ? 16 : 20,
    logoMm = showLogo ? (page.tight ? 8 : page.small ? 9 : 12.7) : 0,
    ownText = split.own.map(([k, v]) => k + '：' + v).join('　'),
    headMm =
      pad2 +
      Math.max(
        logoMm,
        lineMm(companyPt),
        lineMm(titlePt) + 1,
        lineMm(size + 2) + (form.kind || split.date ? lineMm(small) : 0),
      );
  // 信息格：「标签：内容」写在同一格，宽纸一行三格、窄纸两格
  const perRow = keys.length >= 6 && bodyMm >= 200 ? 3 : keys.length >= 4 ? 2 : 1,
    infoKeys = form.kind
      ? templateInfoFields(
          form.kind,
          form.templateSnapshot?.hiddenFields,
          form.templateSnapshot?.companyAddress,
        )
      : split.info.map(([k]) => k),
    infoRows = packInfo(
      infoKeys.map((k) => [k, split.info.find(([name]) => name === k)?.[1] || '未填写']),
      perRow,
    ),
    infoRowMm = infoRows.map(() => Math.max(page.infoMm, lineMm(size) + pad2)),
    infoMm = infoRowMm.reduce((n, v) => n + v, 0);
  const headerRowMm = Math.max(
    page.rowMm,
    ...form.headers.map((h, i) => linesFor(h, colMm[i] - 3.4, size) * lineMm(size) + pad2),
  );
  let noteSpan = 0;
  for (let acc = 0; noteSpan < colMm.length - 1 && acc < (page.small ? 13 : 16);)
    acc += colMm[noteSpan++];
  noteSpan = Math.max(1, noteSpan);
  const notesW = colMm.slice(noteSpan).reduce((n, v) => n + v, 0) - 3,
    // 备注固定两行（7 磅），短文字可用较大字号；不按单据备注长度重算容量。
    notesMm = Math.max(page.rowMm, lineMm(7) * 2 + pad2),
    termText = split.terms.map(([k, v], i) => i + 1 + '. ' + k + '：' + v),
    termsMm = termText.length
      ? 1.8 + termText.reduce((n, t) => n + linesFor(t, bodyMm, small) * lineMm(small), 0)
      : 0;
  // 页眉页脚伸进正文区的部分
  const runningPt = 7.5,
    headerLine = [form.headerText, draft].filter(Boolean).join('　'),
    footerLine = [ownText, form.footerText].filter(Boolean).join('　'),
    headIntrude = Math.max(
      0,
      page.headerDist +
        linesFor(
          [form.headerText, '测试样张 · 非正式'].filter(Boolean).join('　'),
          bodyMm,
          runningPt,
        ) *
          lineMm(runningPt) -
        page.top,
    ),
    footIntrude = Math.max(
      0,
      page.footerDist +
        linesFor(footerLine + '　第 1 张 / 共 1 张', bodyMm, runningPt) * lineMm(runningPt) -
        page.bottom,
    ),
    usable = page.height - page.top - page.bottom - headIntrude - footIntrude - 1.5;
  const hasTotal = form.kind ? form.kind === 'purchase' : total !== null,
    extraHeadMm = keys.length < 5 ? lineMm(titlePt) + 2 : 0;
  const fixed =
    headMm +
    extraHeadMm +
    page.gapMm +
    (infoMm ? infoMm + page.gapMm : 0) +
    headerRowMm +
    (hasTotal ? Math.max(page.rowMm, lineMm(size) + pad2) : 0) +
    notesMm +
    termsMm +
    page.sigMm +
    // 表格线：每行约 0.2 mm，两张表的粗外框各约 0.9 mm
    BORDER_MM * (infoRowMm.length + 1 + (hasTotal ? 1 : 0) + 1) +
    0.9 * (infoRowMm.length ? 2 : 1);
  const rowsPerPage = Math.floor((usable - fixed) / (page.rowMm + BORDER_MM)),
    // 剩下不够一行的高度均分给明细行，表格铺满，签字栏下面不留大块空白。
    rowMm = Math.max(page.rowMm, (usable - fixed) / rowsPerPage - BORDER_MM);
  if (rowsPerPage < 1)
    throw new ImportError(
      `单据“${form.number}”的模板固定区域过高，放不下一行明细。请缩短公司资料或条款，或换更大的纸张。`,
      400,
      'document_layout_overflow',
    );
  return {
    page,
    size,
    small,
    copyLabels,
    showLogo,
    bodyMm,
    keys,
    weights,
    weightSum,
    colMm,
    ...split,
    total,
    draft,
    companyPt,
    titlePt,
    ownText,
    headerLine,
    footerLine,
    headMm,
    hasTotal,
    extraHeadMm,
    sideMm,
    logoColMm,
    perRow,
    infoRows,
    infoRowMm,
    rowMm,
    headerRowMm,
    noteSpan,
    notesMm,
    notesW,
    totalMm: Math.max(page.rowMm, lineMm(size) + pad2),
    infoKeys,
    termText,
    rowsPerPage,
  };
}
/** 每张纸能放几行明细（同一模板下固定）。 */
export const documentRowsPerPage = (form: BusinessForm) => planLayout(form).rowsPerPage;
/**
 * 单据里的数字转成 Excel 数字，显示的小数位与原文一致；金额带千分位（与 displayAmount 一致）。
 * Excel 只有 15 位有效数，超出时返回 null，按文本保留完整原数值，避免悄悄截断。
 */
function excelNumber(text: string, amount: boolean) {
  const v = amount && /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text) ? text.replaceAll(',', '') : text;
  if (
    !/^\d+(\.\d+)?$/.test(v) ||
    v.replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length > 15 ||
    Number(v).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) !==
      v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  )
    return null;
  const decimals = v.split('.')[1]?.length || 0;
  return {
    value: Number(v),
    numFmt: (amount ? '#,##0' : '0') + (decimals ? '.' + '0'.repeat(decimals) : ''),
  };
}
export async function renderBusinessForm(
  form: BusinessForm,
  format: 'docx' | 'xlsx',
): Promise<Buffer> {
  const L = planLayout(form),
    { page, size, small, keys, colMm, total, draft } = L,
    company = form.companyName || factoryName,
    color = form.color || 'E8EEF0',
    font = form.fontFamily || '宋体',
    titleFont = font === '宋体' ? '黑体' : font,
    N = L.rowsPerPage,
    pageCount = Math.max(1, Math.ceil(form.rows.length / N)),
    pages = Array.from({ length: pageCount }, (_, p) => {
      const rows = form.rows.slice(p * N, (p + 1) * N);
      return [...rows, ...Array.from({ length: N - rows.length }, () => keys.map(() => ''))];
    }),
    fail = (field: string, row?: number): never => {
      throw new ImportError(
        `单据“${form.number}”${row ? `第 ${row} 行明细` : '的'}“${field}”内容过长，最小 7 磅仍放不下。请缩短内容或换更大的纸张后重新导出。`,
        400,
        'document_layout_overflow',
      );
    },
    fit = (
      text: string,
      width: number,
      height: number,
      base: number,
      field: string,
      row?: number,
    ) => fitPt(text, width, base, height) ?? fail(field, row),
    cellPt = (text: string, i: number, row?: number) =>
      fit(text, colMm[i] - 3.4, L.rowMm - page.padMm * 2, size, form.headers[i], row),
    notesPt = fit(form.notes, L.notesW, L.notesMm - page.padMm * 2, size, '备注'),
    totalPt = total
      ? fit(totalLine(total), L.bodyMm - 3.4, L.totalMm - page.padMm * 2, size, '合计金额')
      : size,
    // 在明细网格中选择最接近等宽信息格的边界；两种格式使用相同的合并范围。
    slotColumns = (() => {
      const boundaries = [0];
      for (let i = 1; i < L.perRow; i++) {
        let best = boundaries[i - 1] + 1,
          distance = Infinity;
        for (let c = best; c <= keys.length - (L.perRow - i); c++) {
          const d = Math.abs(
            colMm.slice(0, c).reduce((n, x) => n + x, 0) - (L.bodyMm * i) / L.perRow,
          );
          if (d < distance) {
            distance = d;
            best = c;
          }
        }
        boundaries.push(best);
      }
      return [...boundaries, keys.length];
    })(),
    infoCells = L.infoRows.map((items, r) => {
      let slot = 0;
      return items.map(({ k, v, slots }) => {
        const c1 = slotColumns[slot],
          c2 = slotColumns[slot + slots],
          width = colMm.slice(c1, c2).reduce((n, x) => n + x, 0);
        slot += slots;
        return {
          k,
          v,
          c1,
          c2,
          width,
          pt: fit(k + '：' + v, width - 3.4, L.infoRowMm[r] - page.padMm * 2, size, k),
        };
      });
    });
  // 两种格式在生成字节前完成同一轮检查。失败时不创建导出回执、文件或业务状态变更。
  form.rows.forEach((r, i) => r.forEach((text, j) => cellPt(text, j, i + 1)));
  if (form.kind) for (const [k] of L.info) if (!L.infoKeys.includes(k)) fail(k);
  const c0 = L.showLogo && keys.length >= 3 ? 2 : 1,
    wide = keys.length >= 5,
    // 标题栏尽量落在纸面中间：左右两块按列宽各取约三分之一
    cum = colMm.map((_, i) => colMm.slice(0, i + 1).reduce((n, v) => n + v, 0)),
    near = (target: number) =>
      cum.reduce(
        (best, v, i) => (Math.abs(v - target) < Math.abs(cum[best] - target) ? i : best),
        0,
      ) + 1,
    l = wide ? Math.max(c0, Math.min(keys.length - 2, near(L.bodyMm * 0.34))) : keys.length - 1,
    r = wide ? Math.min(keys.length - 1, Math.max(l + 1, near(L.bodyMm * 0.66))) : keys.length - 1,
    headFirstMm = L.headMm - lineMm(small);
  const companyPt = fit(
      company,
      Math.min(
        L.sideMm - L.logoColMm,
        colMm.slice(c0 - 1, l).reduce((n, x) => n + x, 0),
      ) - 3.4,
      headFirstMm - 0.3,
      L.companyPt,
      '公司名称',
    ),
    titlePt = fit(
      form.title,
      Math.min(
        L.bodyMm - L.sideMm * 2 - (spacedTitle(form.title) ? emMm(6) * form.title.length : 0),
        wide ? colMm.slice(l, r).reduce((n, x) => n + x, 0) : L.bodyMm,
      ) - 3.4,
      Math.min(L.headMm - page.padMm * 2 - 1, wide ? headFirstMm - 0.3 : L.extraHeadMm),
      L.titlePt,
      '单据标题',
    ),
    numberPt = fit(
      'No. ' + L.number,
      Math.min(
        L.sideMm,
        colMm.slice(r).reduce((n, x) => n + x, 0),
      ) - 3.4,
      Math.min(lineMm(size + 2), headFirstMm - 0.3),
      size + 2,
      '单号',
    ),
    datePt = L.date
      ? fit(L.date[0] + '：' + L.date[1], L.sideMm - 3.4, lineMm(small), small, L.date[0])
      : small,
    signatureLine = form.signatures.map((s) => s + '：________________').join('　　'),
    signaturePt = Math.min(
      fit(signatureLine, L.bodyMm - 3.4, lineMm(size), size, '签字栏'),
      ...form.signatures.map((s) =>
        fit(s + '：', L.bodyMm / form.signatures.length - 21, lineMm(size), size, '签字栏'),
      ),
    ),
    signaturePts = form.signatures.map(() => signaturePt),
    copyPt = L.copyLabels
      ? fit(L.copyLabels, page.height - page.top - page.bottom, 5.5, 8, '联次说明')
      : 8;
  const title = company + ' ' + form.title + (draft ? ' ' + draft.replace(' · ', ' ') : '');
  if (format === 'docx') {
    const tw = (mm: number) => Math.round(mm * 56.6929),
      hp = (pt: number) => Math.round(pt * 2),
      W = tw(L.bodyMm);
    const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      thin = { style: BorderStyle.SINGLE, size: 4, color: '8C979C' },
      strong = { style: BorderStyle.SINGLE, size: 10, color: '3C4448' };
    const noBorders = Object.fromEntries(
      ['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map((x) => [
        x,
        none,
      ]),
    );
    const gridBorders = {
      top: strong,
      bottom: strong,
      left: strong,
      right: strong,
      insideHorizontal: thin,
      insideVertical: thin,
    };
    const run = (
      text: string,
      o: { bold?: boolean; pt?: number; color?: string; font?: string; spacing?: number } = {},
    ) =>
      new TextRun({
        text,
        bold: o.bold,
        size: hp(o.pt ?? size),
        color: o.color ?? '111111',
        font: o.font ?? font,
        characterSpacing: o.spacing,
      });
    const para = (
      children: (TextRun | ImageRun)[],
      o: {
        align?: 'left' | 'center' | 'right';
        before?: number;
        border?: any;
        /** 本段最大字号；行距按它取固定值（1.3 倍），行高可预期，不受文档网格影响。 */
        pt?: number;
        image?: boolean;
      } = {},
    ) =>
      new Paragraph({
        alignment:
          o.align === 'center'
            ? AlignmentType.CENTER
            : o.align === 'right'
              ? AlignmentType.RIGHT
              : AlignmentType.LEFT,
        spacing: o.image
          ? { before: 0, after: 0 }
          : {
              before: o.before ?? 0,
              after: 0,
              line: Math.round((o.pt ?? size) * 26),
              lineRule: LineRuleType.EXACT,
            },
        border: o.border,
        children,
      });
    const lines = (
      text: string,
      o: Parameters<typeof run>[1] = {},
      align?: 'left' | 'center' | 'right',
    ) => (text || '').split('\n').map((t) => para([run(t, o)], { align, pt: o.pt }));
    const cell = (
      children: Paragraph[],
      o: { width?: number; span?: number; fill?: string; borders?: any } = {},
    ) =>
      new TableCell({
        children,
        columnSpan: o.span && o.span > 1 ? o.span : undefined,
        width: o.width ? { size: o.width, type: WidthType.DXA } : undefined,
        shading: o.fill ? { fill: o.fill, type: ShadingType.CLEAR, color: 'auto' } : undefined,
        verticalAlign: VerticalAlignTable.CENTER,
        // 上下内边距设 0：WPS 会把它加在行高之外，Word 不会；靠垂直居中留白，两边行高一致。
        margins: { top: 0, bottom: 0, left: tw(1.5), right: tw(1.5) },
        borders: o.borders,
      });
    /** 固定高度的空段落：表格之间的间隔、页与页之间的分页都用它，不占多余高度。 */
    const gap = (mm: number, pageBreakBefore = false) =>
      new Paragraph({
        pageBreakBefore,
        spacing: { before: 0, after: 0, line: Math.max(20, tw(mm)), lineRule: LineRuleType.EXACT },
        children: [run('', { pt: 1 })],
      });
    const height = (mm: number) => ({ value: tw(mm), rule: HeightRule.EXACT });
    // 左右两栏等宽，标题栏在中间，所以标题正好在整张纸的水平中线上。
    const sideW = tw(L.sideMm),
      logoW = tw(L.logoColMm),
      companyW = sideW - logoW,
      titleW = W - sideW * 2,
      logoPx = Math.round((page.tight ? 8 : page.small ? 9 : 12.7) / 0.2646);
    const headerTable = () =>
      new Table({
        width: { size: W, type: WidthType.DXA },
        layout: 'fixed',
        columnWidths: [...(L.showLogo ? [logoW] : []), companyW, titleW, sideW],
        borders: noBorders,
        rows: [
          new TableRow({
            height: height(L.headMm),
            cantSplit: true,
            children: [
              ...(L.showLogo
                ? [
                    cell(
                      [
                        para(
                          [
                            new ImageRun({
                              type: 'png',
                              data: brandLogoPng,
                              transformation: { width: logoPx, height: logoPx },
                              altText: { name: '商标', description: '公司商标', title: '商标' },
                            }),
                          ],
                          { image: true },
                        ),
                      ],
                      { width: logoW },
                    ),
                  ]
                : []),
              cell(
                [
                  para(
                    [
                      run(company, {
                        bold: true,
                        pt: companyPt,
                        color: '1F3566',
                        font: titleFont,
                      }),
                    ],
                    { pt: companyPt },
                  ),
                ],
                { width: companyW },
              ),
              cell(
                [
                  para(
                    [
                      run(form.title, {
                        bold: true,
                        pt: titlePt,
                        font: titleFont,
                        spacing: spacedTitle(form.title) ? 120 : undefined,
                      }),
                    ],
                    {
                      align: 'center',
                      pt: titlePt,
                      border: {
                        bottom: { style: BorderStyle.DOUBLE, size: 6, color: '111111', space: 1 },
                      },
                    },
                  ),
                ],
                { width: titleW },
              ),
              cell(
                [
                  para(
                    [
                      run('No. ', { pt: small, color: '4A5559' }),
                      run(L.number, { bold: true, pt: numberPt, color: 'B3261E' }),
                    ],
                    { align: 'right', pt: numberPt },
                  ),
                  ...(L.date
                    ? [
                        para([run(L.date[0] + '：' + L.date[1], { pt: datePt, color: '333333' })], {
                          pt: datePt,
                          align: 'right',
                        }),
                      ]
                    : []),
                ],
                { width: sideW },
              ),
            ],
          }),
        ],
      });
    // 信息格：「标签：内容」写在一格里，标签灰色
    const infoTable = () =>
      new Table({
        width: { size: W, type: WidthType.DXA },
        layout: 'fixed',
        columnWidths: colMm.map((mm) => Math.floor(tw(mm))),
        borders: gridBorders,
        rows: infoCells.map(
          (items, r) =>
            new TableRow({
              cantSplit: true,
              height: height(L.infoRowMm[r]),
              children: items.map(({ k, v, c1, c2, width, pt }) =>
                cell(lines(k + '：' + v, { pt }), { width: tw(width), span: c2 - c1 }),
              ),
            }),
        ),
      });
    const widths = colMm.map((mm) => Math.floor(tw(mm))),
      headerInk = templateHeaderText(color);
    const detailTable = (rows: string[][], last: boolean) => {
      const out = [
        new TableRow({
          tableHeader: true,
          cantSplit: true,
          height: height(L.headerRowMm),
          children: form.headers.map((h, i) =>
            cell([para([run(h, { bold: true, color: headerInk })], { align: 'center' })], {
              width: widths[i],
              fill: color,
            }),
          ),
        }),
        ...rows.map(
          (r) =>
            new TableRow({
              cantSplit: true,
              height: height(L.rowMm),
              children: r.map((v, i) =>
                cell(lines(v, { pt: cellPt(v, i) }, columnAlign(keys[i])), { width: widths[i] }),
              ),
            }),
        ),
      ];
      if (L.hasTotal)
        out.push(
          new TableRow({
            cantSplit: true,
            height: height(L.totalMm),
            children: [
              cell(lines(totalLine(total, last), { bold: true, pt: totalPt }, 'right'), {
                span: widths.length,
              }),
            ],
          }),
        );
      out.push(
        new TableRow({
          cantSplit: true,
          height: height(L.notesMm),
          children: [
            cell([para([run('备注', { bold: true })], { align: 'center' })], {
              span: L.noteSpan,
              fill: 'F1F4F5',
            }),
            cell(lines(form.notes || '', { pt: notesPt }), { span: widths.length - L.noteSpan }),
          ],
        }),
      );
      return new Table({
        width: { size: W, type: WidthType.DXA },
        layout: 'fixed',
        columnWidths: widths,
        borders: gridBorders,
        rows: out,
      });
    };
    const termParas = () =>
      L.termText.map((t, i) => {
        const [head, ...rest] = t.split('：');
        return para(
          [
            run(head + '：', { bold: true, pt: small }),
            run(rest.join('：'), { pt: small, color: '333333' }),
          ],
          { before: i ? 0 : 100, pt: small },
        );
      });
    const sigs = form.signatures,
      sigW = sigs.length ? Math.floor(W / sigs.length) : W,
      sigLabel = (s: string, i: number) =>
        Math.min(sigW - tw(15), tw(textMm(s + '：', signaturePts[i]) + 3.5));
    const signatureTable = () =>
      new Table({
        width: { size: W, type: WidthType.DXA },
        layout: 'fixed',
        columnWidths: sigs.flatMap((s, i) => [
          sigLabel(s, i),
          sigW - sigLabel(s, i) - tw(6),
          tw(6),
        ]),
        borders: noBorders,
        rows: [
          new TableRow({
            height: height(lineMm(size) + page.padMm * 2),
            cantSplit: true,
            children: sigs.flatMap((s, i) => [
              cell(
                [
                  para([run(s + '：', { pt: signaturePts[i] })], {
                    align: 'right',
                    pt: signaturePts[i],
                  }),
                ],
                { width: sigLabel(s, i) },
              ),
              cell([para([run('')])], {
                width: sigW - sigLabel(s, i) - tw(6),
                borders: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '111111' } },
              }),
              cell([para([run('')])], { width: tw(6) }),
            ]),
          }),
        ],
      });
    const sigGapMm = page.sigMm - lineMm(size) - page.padMm * 2;
    const body = pages.flatMap((rows, p) => {
      const last = p === pages.length - 1;
      return [
        ...(p ? [gap(0.4, true)] : []),
        headerTable(),
        gap(page.gapMm + L.extraHeadMm),
        ...(L.infoRows.length ? [infoTable(), gap(page.gapMm)] : []),
        detailTable(rows, last),
        ...termParas(),
        ...(sigs.length ? [gap(sigGapMm), signatureTable()] : []),
        // Word 要求表格后跟一个段落；压成 1 磅，避免多出空白页。
        gap(0.4),
      ];
    });
    // 右侧竖排联次说明：放在页眉里的浮动表格，每页都有
    const usableHeight = page.height - page.top - page.bottom;
    const copyStrip = L.copyLabels
      ? new Table({
          width: { size: tw(6), type: WidthType.DXA },
          layout: 'fixed',
          columnWidths: [tw(6)],
          borders: noBorders,
          float: {
            horizontalAnchor: TableAnchorType.PAGE,
            verticalAnchor: TableAnchorType.PAGE,
            absoluteHorizontalPosition: tw(page.width - page.side - 6),
            absoluteVerticalPosition: tw(page.top),
            overlap: OverlapType.OVERLAP,
          },
          rows: [
            new TableRow({
              height: { value: tw(usableHeight), rule: HeightRule.EXACT },
              children: [
                new TableCell({
                  textDirection: TextDirection.TOP_TO_BOTTOM_RIGHT_TO_LEFT,
                  verticalAlign: VerticalAlignTable.CENTER,
                  margins: { top: 0, bottom: 0, left: 0, right: 0 },
                  children: [
                    para([run(L.copyLabels, { pt: copyPt, color: '4A5559' })], {
                      align: 'center',
                      pt: copyPt,
                    }),
                  ],
                }),
              ],
            }),
          ],
        })
      : null;
    const pageSize = page.landscape
      ? { orientation: PageOrientation.LANDSCAPE, width: tw(page.height), height: tw(page.width) }
      : { orientation: PageOrientation.PORTRAIT, width: tw(page.width), height: tw(page.height) };
    const grey = { pt: 7.5, color: '6B777C' };
    return Packer.toBuffer(
      new Document({
        creator: company,
        title,
        styles: {
          default: {
            document: {
              run: { font, size: hp(size) },
              paragraph: { spacing: { before: 0, after: 0 } },
            },
          },
        },
        sections: [
          {
            properties: {
              page: {
                size: pageSize,
                margin: {
                  top: tw(page.top),
                  bottom: tw(page.bottom),
                  left: tw(page.side),
                  right: tw(page.side),
                  header: tw(page.headerDist),
                  footer: tw(page.footerDist),
                },
              },
            },
            headers: {
              default: new Header({
                children: [
                  ...(copyStrip ? [copyStrip] : []),
                  L.headerLine
                    ? para(
                        [
                          ...(form.headerText
                            ? [run(form.headerText + (draft ? '　' : ''), grey)]
                            : []),
                          ...(draft ? [run(draft, { pt: 7.5, color: 'B3261E', bold: true })] : []),
                        ],
                        { align: form.headerText ? 'left' : 'center', pt: 7.5 },
                      )
                    : gap(0.4),
                ],
              }),
            },
            footers: {
              default: new Footer({
                children: [
                  para(
                    [
                      run((L.footerLine ? L.footerLine + '　　' : '') + '第 ', grey),
                      new TextRun({
                        children: [PageNumber.CURRENT],
                        font,
                        size: 15,
                        color: '6B777C',
                      }),
                      run(' 张 / 共 ', grey),
                      new TextRun({
                        children: [PageNumber.TOTAL_PAGES],
                        font,
                        size: 15,
                        color: '6B777C',
                      }),
                      run(' 张', grey),
                    ],
                    { align: L.footerLine ? 'left' : 'center', pt: 7.5 },
                  ),
                ],
              }),
            },
            children: body,
          },
        ],
      }),
    );
  }
  // —— Excel：同一版式，每张一块，块与块之间分页 ——
  const book = new ExcelJS.Workbook();
  book.creator = company;
  const cols = form.headers.length,
    lastCol = cols + (L.copyLabels ? 1 : 0),
    pt = (mm: number) => mm * 2.835,
    widthsChars = colMm.map((mm) => Math.max(4, mm / 2));
  const sheet = book.addWorksheet(
    form.kind === 'purchase' || form.templateId === 'purchase-default'
      ? '采购订货单'
      : form.kind === 'delivery' || form.templateId === 'delivery-default'
        ? '送货单'
        : form.title,
    { views: [{ showGridLines: false }] },
  );
  sheet.columns = [
    ...widthsChars.map((width) => ({ width })),
    ...(L.copyLabels ? [{ width: 3.2 }] : []),
  ];
  // 按目标纸宽定缩放比例（不用“缩放到一页”，否则 Excel 会忽略手动分页）。列宽按中文字体偏宽估算（WPS 比 Excel 宽），宁可留白不截断。
  const sheetMm = sheet.columns.reduce(
    (n, c) => n + Math.trunc((c.width || 8) * 8.5 + 5) * 0.2646,
    0,
  );
  Object.assign(sheet.pageSetup, {
    // 针式联单不是 Excel 的标准纸型，交给打印机的默认纸（一般就设成联单尺寸）。
    ...(form.paper && form.paper.startsWith('continuous')
      ? {}
      : { paperSize: form.paper === 'a5' ? 11 : 9 }),
    orientation: page.landscape ? 'landscape' : 'portrait',
    // 针式联单没写纸型，打印机默认纸可能是 A4 或 Letter：按三者里最窄的宽度缩放，哪种纸都不会右侧截断。
    scale: Math.max(
      10,
      Math.min(
        100,
        Math.floor(
          ((((form.paper || '').startsWith('continuous')
            ? Math.min(page.width, 215.9)
            : page.width) -
            page.side * 2) /
            sheetMm) *
            100,
        ),
      ),
    ),
    horizontalCentered: true,
    margins: {
      left: page.side / 25.4,
      right: page.side / 25.4,
      top: page.top / 25.4,
      bottom: page.bottom / 25.4,
      header: page.headerDist / 25.4,
      footer: page.footerDist / 25.4,
    },
  });
  const fontOf = (o: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({
    name: font,
    size,
    color: { argb: 'FF111111' },
    ...o,
  });
  const thinLine = { style: 'thin' as const, color: { argb: 'FF8C979C' } },
    strongLine = { style: 'medium' as const, color: { argb: 'FF3C4448' } };
  const put = (
    row: number,
    c1: number,
    c2: number,
    value: ExcelJS.CellValue,
    o: {
      font?: Partial<ExcelJS.Font>;
      align?: 'left' | 'center' | 'right';
      fill?: string;
      wrap?: boolean;
    } = {},
  ) => {
    if (c2 > c1) sheet.mergeCells(row, c1, row, c2);
    const c = sheet.getCell(row, c1);
    c.value = value;
    c.font = fontOf(o.font);
    c.alignment = {
      horizontal: o.align || 'left',
      vertical: 'middle',
      wrapText: o.wrap ?? true,
      // 不再额外缩进三个空格；预检已预留与 Word 相同的左右空间。
    };
    if (o.fill)
      for (let i = c1; i <= c2; i++)
        sheet.getCell(row, i).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF' + o.fill },
        };
    return c;
  };
  const boxRows = (from: number, to: number) => {
    for (let r = from; r <= to; r++)
      for (let c = 1; c <= cols; c++)
        sheet.getCell(r, c).border = {
          top: r === from ? strongLine : thinLine,
          bottom: r === to ? strongLine : thinLine,
          left: c === 1 ? strongLine : thinLine,
          right: c === cols ? strongLine : thinLine,
        };
  };
  const logo = L.showLogo ? book.addImage({ buffer: brandLogoPng as any, extension: 'png' }) : -1;
  const labelFill = 'F1F4F5';
  let next = 1,
    firstHeader = 0;
  pages.forEach((rows, p) => {
    const last = p === pages.length - 1,
      start = next;
    // 抬头：两行，标题跨两行居中
    const headA = next++,
      headB = next++;
    sheet.getRow(headA).height = pt(headFirstMm);
    sheet.getRow(headB).height = pt(lineMm(small));
    if (l > c0) sheet.mergeCells(headA, c0, headA, l);
    put(headA, c0, c0, company, {
      font: { name: titleFont, size: companyPt, bold: true, color: { argb: 'FF1F3566' } },
    });
    put(headA, r + 1, cols, 'No. ' + L.number, {
      font: { bold: true, size: numberPt, color: { argb: 'FFB3261E' } },
      align: 'right',
      wrap: false,
    });
    put(headB, 1, cols, L.date ? L.date[0] + '：' + L.date[1] : '', {
      font: { size: datePt },
      align: 'right',
      wrap: false,
    });
    const titleValue = {
      richText: [
        { text: form.title, font: fontOf({ name: titleFont, size: titlePt, bold: true }) },
      ],
    };
    const titleAt = (row: number, c1: number, c2: number, span: number) => {
      sheet.mergeCells(row, c1, row + span - 1, c2);
      put(row, c1, c1, titleValue, { align: 'center' });
      for (let i = c1; i <= c2; i++)
        sheet.getCell(row + span - 1, i).border = {
          bottom: { style: 'double', color: { argb: 'FF111111' } },
        };
    };
    if (wide) titleAt(headA, l + 1, r, 1);
    else {
      sheet.getRow(next).height = pt(L.extraHeadMm);
      titleAt(next++, 1, cols, 1);
    }
    if (logo >= 0) {
      const colPx = widthsChars[0] * 7 + 5,
        px = Math.max(24, Math.min(colPx - 4, (L.headMm / 0.2646) * 0.85, 48));
      sheet.addImage(logo, {
        tl: { col: 0.08, row: headA - 1 + 0.1 },
        ext: { width: px, height: px },
      });
    }
    sheet.getRow(next++).height = pt(page.gapMm);
    // 信息格：「标签：内容」写在同一格，标签灰色
    const infoStart = next;
    for (const [r, items] of infoCells.entries()) {
      const row = next++;
      for (const { k, v, c1, c2, pt: cellSize } of items)
        put(row, c1 + 1, c2, k + '：' + v, { font: { size: cellSize } });
      sheet.getRow(row).height = pt(L.infoRowMm[r]);
    }
    if (next > infoStart) {
      boxRows(infoStart, next - 1);
      sheet.getRow(next++).height = pt(page.gapMm);
    }
    // 明细：固定行数
    const header = next++;
    if (!firstHeader) firstHeader = header;
    form.headers.forEach((h, i) =>
      put(header, i + 1, i + 1, h, {
        fill: color,
        align: 'center',
        font: { bold: true, color: { argb: 'FF' + templateHeaderText(color) } },
      }),
    );
    sheet.getRow(header).height = pt(L.headerRowMm);
    for (const values of rows) {
      const row = next++;
      values.forEach((v, i) => {
        const n =
          !form.columnKeys || ['index', 'quantity', 'amount'].includes(form.columnKeys[i])
            ? excelNumber(v, keys[i] === 'amount')
            : null;
        const c = put(row, i + 1, i + 1, n ? n.value : v, {
          align: columnAlign(keys[i]),
          font: { size: cellPt(v, i) },
        });
        if (n) c.numFmt = n.numFmt;
      });
      sheet.getRow(row).height = pt(L.rowMm);
    }
    if (L.hasTotal) {
      const row = next++;
      put(row, 1, cols, totalLine(total, last), {
        font: { bold: true, size: totalPt },
        align: 'right',
      });
      sheet.getRow(row).height = pt(L.totalMm);
    }
    {
      const row = next++;
      put(row, 1, L.noteSpan, '备注', { align: 'center', fill: labelFill, font: { bold: true } });
      if (L.noteSpan < cols)
        put(row, L.noteSpan + 1, cols, form.notes || '', { font: { size: notesPt } });
      sheet.getRow(row).height = pt(L.notesMm);
    }
    boxRows(header, next - 1);
    L.termText.forEach((t, i) => {
      const row = next++;
      put(row, 1, cols, t, { font: { size: small, color: { argb: 'FF333333' } } });
      sheet.getRow(row).height = pt(linesFor(t, L.bodyMm, small) * lineMm(small) + (i ? 0 : 1.8));
    });
    if (form.signatures.length) {
      const row = next++;
      put(row, 1, cols, signatureLine, { wrap: false, font: { size: signaturePt } });
      sheet.getCell(row, 1).alignment = { ...sheet.getCell(row, 1).alignment, vertical: 'bottom' };
      sheet.getRow(row).height = pt(page.sigMm);
    }
    if (L.copyLabels) {
      sheet.mergeCells(start, lastCol, next - 1, lastCol);
      const c = sheet.getCell(start, lastCol);
      c.value = L.copyLabels;
      c.font = fontOf({ size: copyPt, color: { argb: 'FF4A5559' } });
      c.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        textRotation: 'vertical',
        wrapText: true,
      };
    }
    if (!last) sheet.getRow(next - 1).addPageBreak();
  });
  sheet.pageSetup.printArea = `A1:${sheet.getColumn(lastCol).letter}${next - 1}`;
  // 页眉：左边模板页眉文字，中间红字“测试样张 / 计划单 非正式”，和 Word 一致，不占表格行。
  if (L.headerLine)
    sheet.headerFooter.oddHeader =
      (form.headerText ? '&L&8' + form.headerText.replaceAll('&', '&&') : '') +
      (draft ? '&C&8&KB3261E' + draft : '');
  sheet.headerFooter.oddFooter =
    '&L&8' + L.footerLine.replaceAll('&', '&&') + '&R&8第 &P 张 / 共 &N 张';
  return Buffer.from(await book.xlsx.writeBuffer());
}
