import {
  Document,
  Packer,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  Header,
  Footer,
  PageNumber,
  PageOrientation,
  TextDirection,
  TableAnchorType,
  OverlapType,
  HeightRule,
  VerticalAlignTable,
} from 'docx';
import { lineMm } from './measure.js';
import { RUNNING_PT } from './paper.js';
import type { RenderContext } from './render-context.js';
import { docxKit, hp, noBorders, tw, type DocxKit } from './docx-kit.js';
import { detailTable, headerTable, infoTable, signatureTable, termParas } from './docx-tables.js';
// 出 Word：版式和字号由 render.ts 算好，这里把每张纸的几块排起来，加上页眉（联次竖排、页眉文字）和页脚（页码）。
/** 最矮的段落：分页和表格后面必须跟的那个段落压到这么高，不多出空白页 */
const MIN_GAP_MM = 0.4;
/** 右侧竖排联次说明那一条的宽度 */
const COPY_STRIP_MM = 6;

/** 正文：每张纸重复抬头、信息格、明细表、条款和签字栏，张与张之间分页 */
function pageBody(ctx: RenderContext, k: DocxKit) {
  const { L, page, size, pages, form } = ctx;
  const { gap } = k;
  const sigGapMm = page.sigMm - lineMm(size) - page.padMm * 2;
  return pages.flatMap((rows, p) => {
    const last = p === pages.length - 1;
    return [
      ...(p ? [gap(MIN_GAP_MM, true)] : []),
      headerTable(ctx, k),
      gap(page.gapMm + L.extraHeadMm),
      ...(L.infoRows.length ? [infoTable(ctx, k), gap(page.gapMm)] : []),
      detailTable(ctx, k, rows, last),
      ...termParas(ctx, k),
      ...(form.signatures.length ? [gap(sigGapMm), signatureTable(ctx, k)] : []),
      // Word 要求表格后跟一个段落；压成 1 磅，避免多出空白页。
      gap(MIN_GAP_MM),
    ];
  });
}

/** 右侧竖排联次说明：放在页眉里的浮动表格，每页都有；模板没写联次就没有 */
function copyStrip(ctx: RenderContext, k: DocxKit) {
  const { L, page, copyPt } = ctx;
  if (!L.copyLabels) return null;
  const usableHeight = page.height - page.top - page.bottom;
  return new Table({
    width: { size: tw(COPY_STRIP_MM), type: WidthType.DXA },
    layout: 'fixed',
    columnWidths: [tw(COPY_STRIP_MM)],
    borders: noBorders,
    float: {
      horizontalAnchor: TableAnchorType.PAGE,
      verticalAnchor: TableAnchorType.PAGE,
      absoluteHorizontalPosition: tw(page.width - page.side - COPY_STRIP_MM),
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
              k.para([k.run(L.copyLabels, { pt: copyPt, color: '4A5559' })], {
                align: 'center',
                pt: copyPt,
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

const grey = { pt: RUNNING_PT, color: '6B777C' };

/** 页眉：联次竖排，加一行模板的页眉文字和红字“测试样张 / 计划单 非正式” */
function pageHeader(ctx: RenderContext, k: DocxKit, strip: Table | null) {
  const { L, draft, form } = ctx;
  const { run, para, gap } = k;
  return new Header({
    children: [
      ...(strip ? [strip] : []),
      L.headerLine
        ? para(
            [
              ...(form.headerText ? [run(form.headerText + (draft ? '　' : ''), grey)] : []),
              ...(draft ? [run(draft, { pt: RUNNING_PT, color: 'B3261E', bold: true })] : []),
            ],
            { align: form.headerText ? 'left' : 'center', pt: RUNNING_PT },
          )
        : gap(MIN_GAP_MM),
    ],
  });
}

/** 页脚：我方联系人、地址和模板页脚文字，后面“第 N 张 / 共 M 张” */
function pageFooter(ctx: RenderContext, k: DocxKit) {
  const { L, font } = ctx;
  const { run, para } = k;
  return new Footer({
    children: [
      para(
        [
          run((L.footerLine ? L.footerLine + '　　' : '') + '第 ', grey),
          new TextRun({
            children: [PageNumber.CURRENT],
            font,
            size: hp(RUNNING_PT),
            color: '6B777C',
          }),
          run(' 张 / 共 ', grey),
          new TextRun({
            children: [PageNumber.TOTAL_PAGES],
            font,
            size: hp(RUNNING_PT),
            color: '6B777C',
          }),
          run(' 张', grey),
        ],
        { align: L.footerLine ? 'left' : 'center', pt: RUNNING_PT },
      ),
    ],
  });
}

export async function renderDocx(ctx: RenderContext): Promise<Buffer> {
  const { page, size, font, company, title } = ctx;
  const k = docxKit(ctx);
  const body = pageBody(ctx, k),
    strip = copyStrip(ctx, k);
  const pageSize = page.landscape
    ? { orientation: PageOrientation.LANDSCAPE, width: tw(page.height), height: tw(page.width) }
    : { orientation: PageOrientation.PORTRAIT, width: tw(page.width), height: tw(page.height) };
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
          headers: { default: pageHeader(ctx, k, strip) },
          footers: { default: pageFooter(ctx, k) },
          children: body,
        },
      ],
    }),
  );
}
