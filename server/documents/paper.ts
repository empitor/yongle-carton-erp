import { documentPapers, type DocumentPaper } from '../../shared/documents/index.js';
import type { BusinessForm } from '../../shared/documents/index.js';
/**
 * 固定版式：每张纸版式完全相同，明细行数固定、铺满整张纸。货少只填前几行，其余空行留表格线；
 * 超过一张时续页，每张都重复抬头、信息格、备注和签字栏，合计只写在最后一张。
 * 尺寸单位都是 mm，行高按字号估算（WPS / Word 中文排版实测校准）。
 */
export type PageLayout = {
  width: number;
  height: number;
  top: number;
  bottom: number;
  side: number;
  landscape: boolean;
  /** 明细行的最小行高；规划时会把剩余高度均分进去，铺满整张纸。 */
  rowMm: number;
  /** 信息格每行最小行高 */
  infoMm: number;
  padMm: number;
  gapMm: number;
  sigMm: number;
  headerDist: number;
  footerDist: number;
  /** 商标的边长、商标那一栏的宽度 */
  logoMm: number;
  logoColMm: number;
  /** 公司名最大字号、标题字号 */
  companyMaxPt: number;
  titlePt: number;
  /** 明细表最后一行“备注”标签格至少占多宽 */
  notesLabelMm: number;
};
/** Word 单元格左右内边距，各 1.5 mm */
export const CELL_SIDE_PAD_MM = 1.5;
/** 单元格里能写字的宽度 = 列宽减它：左右内边距共 3 mm，再多留 0.4 mm 给表格线和测宽误差 */
export const CELL_TEXT_INSET_MM = 3.4;
/** 页眉页脚那一行的字号 */
export const RUNNING_PT = 7.5;
/** 条款区和明细表之间的间距 */
export const TERMS_GAP_MM = 1.8;
/** 五个字以内的标题拉开的字距 */
export const TITLE_SPACING_PT = 6;

type Density = NonNullable<BusinessForm['density']>;
/** 一种纸的尺寸设置；行高、内边距按疏密各一档 */
type PaperSpec = Omit<PageLayout, 'width' | 'height' | 'landscape' | 'rowMm' | 'padMm'> & {
  rowMm: Record<Density, number>;
  padMm: Record<Density, number>;
};
const a4: PaperSpec = {
  top: 12,
  bottom: 12,
  side: 14,
  rowMm: { compact: 6.8, normal: 7.5 },
  infoMm: 7,
  padMm: { compact: 0.8, normal: 1.1 },
  gapMm: 2.5,
  sigMm: 12,
  headerDist: 6,
  footerDist: 6,
  logoMm: 12.7,
  logoColMm: 15,
  companyMaxPt: 15,
  titlePt: 20,
  notesLabelMm: 16,
};
/** A5 和针式联单这些小纸：字号、行高、间距都收一档 */
const small: Omit<PaperSpec, 'top' | 'bottom' | 'side'> = {
  rowMm: { compact: 5.8, normal: 6.2 },
  infoMm: 5.4,
  padMm: { compact: 0.4, normal: 0.4 },
  gapMm: 1.2,
  sigMm: 8.5,
  headerDist: 2.5,
  footerDist: 2,
  logoMm: 9,
  logoColMm: 11,
  companyMaxPt: 12,
  titlePt: 16,
  notesLabelMm: 13,
};
// 针式联单两侧各有约 12.7 mm 的穿孔带，正文避开。
const smallPapers: Record<Exclude<DocumentPaper, 'a4'>, PaperSpec & { landscape: boolean }> = {
  a5: { ...small, top: 7, bottom: 7, side: 10, landscape: true },
  'continuous-241x140': { ...small, top: 6, bottom: 6, side: 13, landscape: false },
  /** 三等分联单只有 93 mm 高，字号和行高再收一档。 */
  'continuous-241x93': {
    ...small,
    top: 4,
    bottom: 4,
    side: 13,
    landscape: false,
    rowMm: { compact: 5, normal: 5.4 },
    infoMm: 4.8,
    padMm: { compact: 0.3, normal: 0.3 },
    gapMm: 0.6,
    sigMm: 6.5,
    headerDist: 1.5,
    footerDist: 1.2,
    logoMm: 8,
    companyMaxPt: 11,
    titlePt: 14,
  },
};
export function pageLayout(
  form: Pick<BusinessForm, 'paper' | 'orientation' | 'density'>,
): PageLayout {
  const paper = form.paper || 'a4',
    { width, height } = documentPapers[paper],
    density = form.density === 'compact' ? 'compact' : 'normal';
  if (paper === 'a4') {
    const landscape = (form.orientation || 'landscape') === 'landscape';
    return {
      ...a4,
      width: landscape ? height : width,
      height: landscape ? width : height,
      landscape,
      rowMm: a4.rowMm[density],
      padMm: a4.padMm[density],
    };
  }
  const spec = smallPapers[paper];
  return { ...spec, width, height, rowMm: spec.rowMm[density], padMm: spec.padMm[density] };
}
