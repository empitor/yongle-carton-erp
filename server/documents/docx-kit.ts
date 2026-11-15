import {
  Paragraph,
  TextRun,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  ImageRun,
  HeightRule,
  VerticalAlignTable,
  ShadingType,
  LineRuleType,
  type IBordersOptions,
  type IRunOptions,
  type ITableCellBorders,
} from 'docx';
import { LINE_HEIGHT_RATIO } from './measure.js';
import { CELL_SIDE_PAD_MM } from './paper.js';
import type { RenderContext } from './render-context.js';
// 出 Word 用的小零件：文字、段落、单元格、固定高度的间隔。字号、字体按这张单据的模板。

/** 1 mm、1 磅合多少 twip（Word 的长度单位） */
const TWIPS_PER_MM = 56.6929;
export const TWIPS_PER_PT = 20;
/** 毫米换成 Word 的 twip */
export const tw = (mm: number) => Math.round(mm * TWIPS_PER_MM);
/** 磅换成 Word 的半磅 */
export const hp = (pt: number) => Math.round(pt * 2);
const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  thin = { style: BorderStyle.SINGLE, size: 4, color: '8C979C' },
  strong = { style: BorderStyle.SINGLE, size: 10, color: '3C4448' };
export const noBorders = Object.fromEntries(
  ['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map((x) => [x, none]),
);
export const gridBorders = {
  top: strong,
  bottom: strong,
  left: strong,
  right: strong,
  insideHorizontal: thin,
  insideVertical: thin,
};
/** 固定行距：每磅字号合多少 twip（字号的 1.3 倍） */
const LINE_TWIPS_PER_PT = LINE_HEIGHT_RATIO * TWIPS_PER_PT;
export type RunOptions = {
  bold?: boolean;
  pt?: number;
  color?: string;
  font?: string;
  spacing?: number;
};

export function docxKit(ctx: RenderContext) {
  const { size, font, L } = ctx;
  const run = (text: string, o: RunOptions = {}) => {
    // TextRun 也收纯文字，先按选项的类型写好再交给它
    const options: IRunOptions = {
      text,
      bold: o.bold,
      size: hp(o.pt ?? size),
      color: o.color ?? '111111',
      font: o.font ?? font,
      characterSpacing: o.spacing,
    };
    return new TextRun(options);
  };
  const para = (
    children: (TextRun | ImageRun)[],
    o: {
      align?: 'left' | 'center' | 'right';
      before?: number;
      border?: IBordersOptions;
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
            line: Math.round((o.pt ?? size) * LINE_TWIPS_PER_PT),
            lineRule: LineRuleType.EXACT,
          },
      border: o.border,
      children,
    });
  const lines = (text: string, o: RunOptions = {}, align?: 'left' | 'center' | 'right') =>
    (text || '').split('\n').map((t) => para([run(t, o)], { align, pt: o.pt }));
  const cell = (
    children: Paragraph[],
    o: { width?: number; span?: number; fill?: string; borders?: ITableCellBorders } = {},
  ) =>
    new TableCell({
      children,
      columnSpan: o.span && o.span > 1 ? o.span : undefined,
      width: o.width ? { size: o.width, type: WidthType.DXA } : undefined,
      shading: o.fill ? { fill: o.fill, type: ShadingType.CLEAR, color: 'auto' } : undefined,
      verticalAlign: VerticalAlignTable.CENTER,
      // 上下内边距设 0：WPS 会把它加在行高之外，Word 不会；靠垂直居中留白，两边行高一致。
      margins: { top: 0, bottom: 0, left: tw(CELL_SIDE_PAD_MM), right: tw(CELL_SIDE_PAD_MM) },
      borders: o.borders,
    });
  /** 固定高度的空段落：表格之间的间隔、页与页之间的分页都用它，不占多余高度。 */
  const gap = (mm: number, pageBreakBefore = false) =>
    new Paragraph({
      pageBreakBefore,
      spacing: { before: 0, after: 0, line: Math.max(TWIPS_PER_PT, tw(mm)), lineRule: LineRuleType.EXACT },
      children: [run('', { pt: 1 })],
    });
  const height = (mm: number) => ({ value: tw(mm), rule: HeightRule.EXACT });
  return { run, para, lines, cell, gap, height, W: tw(L.bodyMm) };
}
export type DocxKit = ReturnType<typeof docxKit>;
