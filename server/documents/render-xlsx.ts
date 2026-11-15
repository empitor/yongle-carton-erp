import ExcelJS from 'exceljs';
import { templateHeaderText, totalLine } from '../../shared/documents/index.js';
import type { BusinessForm } from '../../shared/documents/index.js';
import { brandLogoPng } from './brand-logo.js';
import { columnAlign } from './layout.js';
import { MM_PER_PX, lineMm, linesFor } from './measure.js';
import { TERMS_GAP_MM } from './paper.js';
import type { RenderContext } from './render-context.js';
/** Excel 行高的单位是磅：1 mm 合多少磅 */
const ROW_PT_PER_MM = 2.835;
const MM_PER_INCH = 25.4;
/** Excel 数字只有 15 位有效数 */
const EXCEL_DIGITS = 15;
/** Letter 纸宽：针式联单按 A4、Letter、联单里最窄的宽度缩放 */
const LETTER_WIDTH_MM = 215.9;
/** 打印缩放比例的下限（%） */
const MIN_SCALE = 10;
/**
 * 列宽：Excel 的列宽以字符计，按 mm 的一半估、至少 4 个字符；没设宽度的列按 8 个字符。
 * 换成像素时中文字体偏宽（WPS 比 Excel 宽）按每字符 8.5 px 估，商标那一列按 Excel 标准 7 px，另加 5 px 边距。
 */
const excelColumn = { minChars: 4, defaultChars: 8, wideCharPx: 8.5, charPx: 7, padPx: 5 } as const;
/** 有联次说明时右侧多一列放竖排的联次 */
const COPY_COLUMN_CHARS = 3.2;
/** Excel 的纸型编号 */
const excelPaperSize = { a4: 9, a5: 11 } as const;
/** 商标：边长按抬头高度的 85% 取、限制在 24 到 48 px，不超出所在列；左上角偏移（以格计） */
const logoBox = { minPx: 24, maxPx: 48, insetPx: 4, headShare: 0.85, colOffset: 0.08, rowOffset: 0.1 } as const;
const labelFill = 'F1F4F5';
const thinLine = { style: 'thin' as const, color: { argb: 'FF8C979C' } },
  strongLine = { style: 'medium' as const, color: { argb: 'FF3C4448' } };
/** 毫米换成 Excel 行高的磅 */
const rowPt = (mm: number) => mm * ROW_PT_PER_MM;
const inches = (mm: number) => mm / MM_PER_INCH;

/** 去掉小数末尾的 0 和多余的小数点（12.500 → 12.5，12.0 → 12） */
const trimDecimals = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
/**
 * 单据里的数字转成 Excel 数字，显示的小数位与原文一致；金额带千分位（与 displayAmount 一致）。
 * Excel 只有 15 位有效数，超出时返回 null，按文本保留完整原数值，避免悄悄截断。
 */
function excelNumber(text: string, amount: boolean) {
  const v = amount && /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text) ? text.replaceAll(',', '') : text;
  if (
    !/^\d+(\.\d+)?$/.test(v) ||
    v.replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length > EXCEL_DIGITS ||
    Number(v).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) !==
      trimDecimals(v)
  )
    return null;
  const decimals = v.split('.')[1]?.length || 0;
  return {
    value: Number(v),
    numFmt: (amount ? '#,##0' : '0') + (decimals ? '.' + '0'.repeat(decimals) : ''),
  };
}

const sheetName = (form: BusinessForm) =>
  form.kind === 'purchase' || form.templateId === 'purchase-default'
    ? '采购订货单'
    : form.kind === 'delivery' || form.templateId === 'delivery-default'
      ? '送货单'
      : form.title;

/** 工作表、列宽和打印设置：按目标纸宽定缩放比例（不用“缩放到一页”，否则 Excel 会忽略手动分页） */
function setupSheet(book: ExcelJS.Workbook, ctx: RenderContext) {
  const { L, page, colMm, form } = ctx;
  const sheet = book.addWorksheet(sheetName(form), { views: [{ showGridLines: false }] });
  const widthsChars = colMm.map((mm) => Math.max(excelColumn.minChars, mm / 2));
  sheet.columns = [
    ...widthsChars.map((width) => ({ width })),
    ...(L.copyLabels ? [{ width: COPY_COLUMN_CHARS }] : []),
  ];
  // 列宽按中文字体偏宽估算（WPS 比 Excel 宽），宁可留白不截断。
  const sheetMm = sheet.columns.reduce(
    (n, c) =>
      n +
      Math.trunc((c.width || excelColumn.defaultChars) * excelColumn.wideCharPx + excelColumn.padPx) *
        MM_PER_PX,
    0,
  );
  const continuous = (form.paper || '').startsWith('continuous');
  // 针式联单没写纸型，打印机默认纸可能是 A4 或 Letter：按三者里最窄的宽度缩放，哪种纸都不会右侧截断。
  const printableMm = (continuous ? Math.min(page.width, LETTER_WIDTH_MM) : page.width) - page.side * 2;
  Object.assign(sheet.pageSetup, {
    // 针式联单不是 Excel 的标准纸型，交给打印机的默认纸（一般就设成联单尺寸）。
    ...(continuous ? {} : { paperSize: form.paper === 'a5' ? excelPaperSize.a5 : excelPaperSize.a4 }),
    orientation: page.landscape ? 'landscape' : 'portrait',
    scale: Math.max(MIN_SCALE, Math.min(100, Math.floor((printableMm / sheetMm) * 100))),
    horizontalCentered: true,
    margins: {
      left: inches(page.side),
      right: inches(page.side),
      top: inches(page.top),
      bottom: inches(page.bottom),
      header: inches(page.headerDist),
      footer: inches(page.footerDist),
    },
  });
  return { sheet, widthsChars };
}

type PutOptions = {
  font?: Partial<ExcelJS.Font>;
  align?: 'left' | 'center' | 'right';
  fill?: string;
  wrap?: boolean;
};
/** 往表里一行一行写：next 是下一行的行号 */
class SheetWriter {
  next = 1;
  readonly cols: number;
  constructor(
    readonly sheet: ExcelJS.Worksheet,
    readonly ctx: RenderContext,
  ) {
    this.cols = ctx.form.headers.length;
  }
  /** 占下一行，设好行高（mm） */
  row(heightMm: number) {
    const row = this.next++;
    this.sheet.getRow(row).height = rowPt(heightMm);
    return row;
  }
  font(o: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> {
    return { name: this.ctx.font, size: this.ctx.size, color: { argb: 'FF111111' }, ...o };
  }
  put(row: number, c1: number, c2: number, value: ExcelJS.CellValue, o: PutOptions = {}) {
    const sheet = this.sheet;
    if (c2 > c1) sheet.mergeCells(row, c1, row, c2);
    const c = sheet.getCell(row, c1);
    c.value = value;
    c.font = this.font(o.font);
    // 不再额外缩进三个空格；预检已预留与 Word 相同的左右空间。
    c.alignment = { horizontal: o.align || 'left', vertical: 'middle', wrapText: o.wrap ?? true };
    if (o.fill)
      for (let i = c1; i <= c2; i++)
        sheet.getCell(row, i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + o.fill } };
    return c;
  }
  boxRows(from: number, to: number) {
    for (let r = from; r <= to; r++)
      for (let c = 1; c <= this.cols; c++)
        this.sheet.getCell(r, c).border = {
          top: r === from ? strongLine : thinLine,
          bottom: r === to ? strongLine : thinLine,
          left: c === 1 ? strongLine : thinLine,
          right: c === this.cols ? strongLine : thinLine,
        };
  }
}

/** 标题：跨几列居中，下面一条双线 */
function putTitle(w: SheetWriter, row: number, c1: number, c2: number) {
  const { form, titleFont, titlePt } = w.ctx;
  const titleValue = {
    richText: [{ text: form.title, font: w.font({ name: titleFont, size: titlePt, bold: true }) }],
  };
  w.sheet.mergeCells(row, c1, row, c2);
  w.put(row, c1, c1, titleValue, { align: 'center' });
  for (let i = c1; i <= c2; i++)
    w.sheet.getCell(row, i).border = { bottom: { style: 'double', color: { argb: 'FF111111' } } };
}

/** 抬头：两行，左边公司名、右边单号，下一行日期；标题在宽表里放第一行中间，窄表单独一行 */
function writeHead(w: SheetWriter, logo: number, widthsChars: number[]) {
  const { L, small, company, titleFont, companyPt, numberPt, datePt, c0, l, r, wide, headFirstMm } = w.ctx;
  const headA = w.row(headFirstMm),
    headB = w.row(lineMm(small));
  if (l > c0) w.sheet.mergeCells(headA, c0, headA, l);
  w.put(headA, c0, c0, company, {
    font: { name: titleFont, size: companyPt, bold: true, color: { argb: 'FF1F3566' } },
  });
  w.put(headA, r + 1, w.cols, 'No. ' + L.number, {
    font: { bold: true, size: numberPt, color: { argb: 'FFB3261E' } },
    align: 'right',
    wrap: false,
  });
  w.put(headB, 1, w.cols, L.date ? L.date[0] + '：' + L.date[1] : '', {
    font: { size: datePt },
    align: 'right',
    wrap: false,
  });
  if (wide) putTitle(w, headA, l + 1, r);
  else putTitle(w, w.row(L.extraHeadMm), 1, w.cols);
  if (logo >= 0) {
    const colPx = widthsChars[0] * excelColumn.charPx + excelColumn.padPx,
      px = Math.max(
        logoBox.minPx,
        Math.min(colPx - logoBox.insetPx, (L.headMm / MM_PER_PX) * logoBox.headShare, logoBox.maxPx),
      );
    w.sheet.addImage(logo, {
      tl: { col: logoBox.colOffset, row: headA - 1 + logoBox.rowOffset },
      ext: { width: px, height: px },
    });
  }
  w.row(w.ctx.page.gapMm);
}

/** 信息格：「标签：内容」写在同一格，有信息格时下面再空一段 */
function writeInfo(w: SheetWriter) {
  const { L, infoCells, page } = w.ctx;
  const infoStart = w.next;
  for (const [r, items] of infoCells.entries()) {
    const row = w.row(L.infoRowMm[r]);
    for (const { k, v, c1, c2, pt } of items) w.put(row, c1 + 1, c2, k + '：' + v, { font: { size: pt } });
  }
  if (w.next > infoStart) {
    w.boxRows(infoStart, w.next - 1);
    w.row(page.gapMm);
  }
}

/** 明细表：表头、固定行数的明细、合计（只在最后一张写数）、备注 */
function writeDetail(w: SheetWriter, rows: string[][], last: boolean) {
  const { L, keys, color, cellPt, notesPt, totalPt, total, form } = w.ctx;
  const header = w.row(L.headerRowMm);
  form.headers.forEach((h, i) =>
    w.put(header, i + 1, i + 1, h, {
      fill: color,
      align: 'center',
      font: { bold: true, color: { argb: 'FF' + templateHeaderText(color) } },
    }),
  );
  for (const values of rows) {
    const row = w.row(L.rowMm);
    values.forEach((v, i) => {
      const n =
        !form.columnKeys || ['index', 'quantity', 'amount'].includes(form.columnKeys[i])
          ? excelNumber(v, keys[i] === 'amount')
          : null;
      const c = w.put(row, i + 1, i + 1, n ? n.value : v, {
        align: columnAlign(keys[i]),
        font: { size: cellPt(v, i) },
      });
      if (n) c.numFmt = n.numFmt;
    });
  }
  if (L.hasTotal)
    w.put(w.row(L.totalMm), 1, w.cols, totalLine(total, last), {
      font: { bold: true, size: totalPt },
      align: 'right',
    });
  const notesRow = w.row(L.notesMm);
  w.put(notesRow, 1, L.noteSpan, '备注', { align: 'center', fill: labelFill, font: { bold: true } });
  if (L.noteSpan < w.cols)
    w.put(notesRow, L.noteSpan + 1, w.cols, form.notes || '', { font: { size: notesPt } });
  w.boxRows(header, w.next - 1);
}

/** 条款一条一行，签字栏一行（文字靠下） */
function writeTermsAndSignatures(w: SheetWriter) {
  const { L, small, page, signatureLine, signaturePt, form } = w.ctx;
  L.termText.forEach((t, i) => {
    const row = w.row(linesFor(t, L.bodyMm, small) * lineMm(small) + (i ? 0 : TERMS_GAP_MM));
    w.put(row, 1, w.cols, t, { font: { size: small, color: { argb: 'FF333333' } } });
  });
  if (form.signatures.length) {
    const row = w.row(page.sigMm);
    w.put(row, 1, w.cols, signatureLine, { wrap: false, font: { size: signaturePt } });
    w.sheet.getCell(row, 1).alignment = { ...w.sheet.getCell(row, 1).alignment, vertical: 'bottom' };
  }
}

/** 右侧竖排联次说明：这一张从头到尾合并成一格 */
function writeCopyLabels(w: SheetWriter, start: number, lastCol: number) {
  const { L, copyPt } = w.ctx;
  w.sheet.mergeCells(start, lastCol, w.next - 1, lastCol);
  const c = w.sheet.getCell(start, lastCol);
  c.value = L.copyLabels;
  c.font = w.font({ size: copyPt, color: { argb: 'FF4A5559' } });
  c.alignment = { horizontal: 'center', vertical: 'middle', textRotation: 'vertical', wrapText: true };
}

/** 页眉：左边模板页眉文字，中间红字“测试样张 / 计划单 非正式”，和 Word 一致，不占表格行。页脚带页码。 */
function writeHeaderFooter(sheet: ExcelJS.Worksheet, ctx: RenderContext) {
  const { L, draft, form } = ctx;
  if (L.headerLine)
    sheet.headerFooter.oddHeader =
      (form.headerText ? '&L&8' + form.headerText.replaceAll('&', '&&') : '') +
      (draft ? '&C&8&KB3261E' + draft : '');
  sheet.headerFooter.oddFooter =
    '&L&8' + L.footerLine.replaceAll('&', '&&') + '&R&8第 &P 张 / 共 &N 张';
}

/** 出 Excel：同一版式，每张一块，块与块之间分页。版式和字号由 render-context.ts 算好。 */
export async function renderXlsx(ctx: RenderContext): Promise<Buffer> {
  const { L, pages, company } = ctx;
  const book = new ExcelJS.Workbook();
  book.creator = company;
  const { sheet, widthsChars } = setupSheet(book, ctx);
  const w = new SheetWriter(sheet, ctx),
    lastCol = w.cols + (L.copyLabels ? 1 : 0);
  const logo = L.showLogo
    ? book.addImage({ base64: brandLogoPng.toString('base64'), extension: 'png' })
    : -1;
  pages.forEach((rows, p) => {
    const last = p === pages.length - 1,
      start = w.next;
    writeHead(w, logo, widthsChars);
    writeInfo(w);
    writeDetail(w, rows, last);
    writeTermsAndSignatures(w);
    if (L.copyLabels) writeCopyLabels(w, start, lastCol);
    if (!last) sheet.getRow(w.next - 1).addPageBreak();
  });
  sheet.pageSetup.printArea = `A1:${sheet.getColumn(lastCol).letter}${w.next - 1}`;
  writeHeaderFooter(sheet, ctx);
  return Buffer.from(await book.xlsx.writeBuffer());
}
