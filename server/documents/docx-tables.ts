import { Table, TableRow, WidthType, BorderStyle, ImageRun, type IBordersOptions } from 'docx';
import { spacedTitle, templateHeaderText, totalLine } from '../../shared/documents/index.js';
import { brandLogoPng } from './brand-logo.js';
import { columnAlign } from './layout.js';
import { MM_PER_PX, lineMm, textMm } from './measure.js';
import { TITLE_SPACING_PT } from './paper.js';
import type { RenderContext } from './render-context.js';
import { TWIPS_PER_PT, gridBorders, noBorders, tw, type DocxKit } from './docx-kit.js';
/** 签字栏每个签字位：横线至少多长、“xx：”标签右边留的空、末尾空白格多宽 */
const SIGNATURE = { minLineMm: 15, labelPadMm: 3.5, tailMm: 6 } as const;
// Word 每张纸上的几块：抬头、信息格、明细表（含合计、备注）、条款、签字栏。尺寸和字号由 render.ts 算好。

/** 抬头左边的商标 */
function logoCell(ctx: RenderContext, k: DocxKit, width: number) {
  const px = Math.round(ctx.page.logoMm / MM_PER_PX);
  const image = new ImageRun({
    type: 'png',
    data: brandLogoPng,
    transformation: { width: px, height: px },
    altText: { name: '商标', description: '公司商标', title: '商标' },
  });
  return k.cell([k.para([image], { image: true })], { width });
}

/** 抬头中间的标题：短标题拉开字距，下面一条双线 */
function titleCell(ctx: RenderContext, k: DocxKit, width: number) {
  const { form, titlePt, titleFont } = ctx;
  const text = k.run(form.title, {
    bold: true,
    pt: titlePt,
    font: titleFont,
    spacing: spacedTitle(form.title) ? TITLE_SPACING_PT * TWIPS_PER_PT : undefined,
  });
  const border: IBordersOptions = { bottom: { style: BorderStyle.DOUBLE, size: 6, color: '111111', space: 1 } };
  return k.cell([k.para([text], { align: 'center', pt: titlePt, border })], { width });
}

/** 抬头右边：单号，下面一行日期 */
function numberCell(ctx: RenderContext, k: DocxKit, width: number) {
  const { L, small, numberPt, datePt } = ctx;
  const { run, para } = k;
  const number = para(
    [
      run('No. ', { pt: small, color: '4A5559' }),
      run(L.number, { bold: true, pt: numberPt, color: 'B3261E' }),
    ],
    { align: 'right', pt: numberPt },
  );
  const date = L.date
    ? [para([run(L.date[0] + '：' + L.date[1], { pt: datePt, color: '333333' })], { pt: datePt, align: 'right' })]
    : [];
  return k.cell([number, ...date], { width });
}

/** 抬头一行：左边商标和公司名，中间标题，右边单号和日期。左右两栏等宽，所以标题正好在整张纸的水平中线上。 */
export function headerTable(ctx: RenderContext, k: DocxKit) {
  const { L, company, titleFont, companyPt } = ctx;
  const { run, para, cell, height, W } = k;
  const sideW = tw(L.sideMm),
    logoW = tw(L.logoColMm),
    companyW = sideW - logoW,
    titleW = W - sideW * 2;
  const companyCell = cell(
    [para([run(company, { bold: true, pt: companyPt, color: '1F3566', font: titleFont })], { pt: companyPt })],
    { width: companyW },
  );
  return new Table({
    width: { size: W, type: WidthType.DXA },
    layout: 'fixed',
    columnWidths: [...(L.showLogo ? [logoW] : []), companyW, titleW, sideW],
    borders: noBorders,
    rows: [
      new TableRow({
        height: height(L.headMm),
        cantSplit: true,
        children: [
          ...(L.showLogo ? [logoCell(ctx, k, logoW)] : []),
          companyCell,
          titleCell(ctx, k, titleW),
          numberCell(ctx, k, sideW),
        ],
      }),
    ],
  });
}

/** 信息格：「标签：内容」写在一格里，标签灰色 */
export function infoTable(ctx: RenderContext, k: DocxKit) {
  const { L, colMm, infoCells } = ctx;
  const { lines, cell, height, W } = k;
  return new Table({
    width: { size: W, type: WidthType.DXA },
    layout: 'fixed',
    columnWidths: colMm.map((mm) => Math.floor(tw(mm))),
    borders: gridBorders,
    rows: infoCells.map(
      (items, r) =>
        new TableRow({
          cantSplit: true,
          height: height(L.infoRowMm[r]),
          children: items.map(({ k: label, v, c1, c2, width, pt }) =>
            cell(lines(label + '：' + v, { pt }), { width: tw(width), span: c2 - c1 }),
          ),
        }),
    ),
  });
}

/** 明细表：表头、这一张的明细行（不够的留空行），订货单有合计（只在最后一张写数），最后一行备注。 */
export function detailTable(ctx: RenderContext, k: DocxKit, rows: string[][], last: boolean) {
  const { L, keys, colMm, total, color, cellPt, notesPt, totalPt, form } = ctx;
  const { run, para, lines, cell, height, W } = k;
  const widths = colMm.map((mm) => Math.floor(tw(mm))),
    headerInk = templateHeaderText(color);
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
}

/** 条款（交货安排、交货要求、付款条件……）：明细表下面一条一段，标题加粗 */
export function termParas(ctx: RenderContext, k: DocxKit) {
  const { L, small } = ctx;
  const { run, para } = k;
  return L.termText.map((t, i) => {
    const [head, ...rest] = t.split('：');
    return para(
      [
        run(head + '：', { bold: true, pt: small }),
        run(rest.join('：'), { pt: small, color: '333333' }),
      ],
      { before: i ? 0 : 100, pt: small },
    );
  });
}

/** 签字栏：每个签字位一段“xx：”加一条下划线 */
export function signatureTable(ctx: RenderContext, k: DocxKit) {
  const { page, size, signaturePts, form } = ctx;
  const { run, para, cell, height, W } = k;
  const sigs = form.signatures,
    sigW = sigs.length ? Math.floor(W / sigs.length) : W,
    sigLabel = (s: string, i: number) =>
      Math.min(sigW - tw(SIGNATURE.minLineMm), tw(textMm(s + '：', signaturePts[i]) + SIGNATURE.labelPadMm)),
    tailW = tw(SIGNATURE.tailMm);
  return new Table({
    width: { size: W, type: WidthType.DXA },
    layout: 'fixed',
    columnWidths: sigs.flatMap((s, i) => [sigLabel(s, i), sigW - sigLabel(s, i) - tailW, tailW]),
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
            width: sigW - sigLabel(s, i) - tailW,
            borders: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '111111' } },
          }),
          cell([para([run('')])], { width: tailW }),
        ]),
      }),
    ],
  });
}
