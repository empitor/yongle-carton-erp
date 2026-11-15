import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
// 按字体量文字有多宽、占几行，找放得下的字号；服务器上缺中文字体时启动就报错。
/** 1 磅合多少 mm */
const MM_PER_PT = 0.3528;
/** 屏幕上 1 像素合多少 mm（96 dpi），图片和 Excel 列宽换算用 */
export const MM_PER_PX = 0.2646;
/** 行高是字号的几倍（Word 里按固定行距写同一个倍数） */
export const LINE_HEIGHT_RATIO = 1.3;
/** 最小字号：缩到它还放不下就拒绝导出 */
export const MIN_PT = 7;
/** 找字号时每次往下缩多少磅 */
const PT_STEP = 0.5;
/** 拉丁字母、数字最窄按几分之一个 em 算 */
const MIN_LATIN_EM = 0.55;
/** 测出的宽度再留 6% 余量 */
const WIDTH_MARGIN = 1.06;
/** 宽度小于它按它算，避免除以零 */
const MIN_WIDTH_MM = 0.1;
export const emMm = (pt: number) => pt * MM_PER_PT;

const measureContext = createCanvas(1, 1).getContext('2d');
// Linux 字体包是 TTC 集合；canvas 有些版本只登记集合首个 JP 族，仍包含完整 CJK 字形。
const linuxMeasurementFont = GlobalFonts.has('Noto Serif CJK SC')
  ? 'Noto Serif CJK SC'
  : 'Noto Serif CJK JP';
export function checkDocumentFonts() {
  if (process.platform === 'linux' && !GlobalFonts.has(linuxMeasurementFont))
    throw new Error(
      '缺少 Linux 中文字体 Noto Serif CJK，请安装 fonts-noto-cjk 并刷新字体缓存后启动。',
    );
}
/** 按字体测宽，避免把 W、数字和窄拉丁字母都当成半个汉字；额外留 6% 余量。 */
export const textMm = (t: string, pt: number) => {
  measureContext.font = `${pt}px "${process.platform === 'linux' ? linuxMeasurementFont : '宋体'}"`;
  // 某些运行环境会用窄字形替代宋体汉字；汉字至少按一个 em 预留。
  return (
    [...t.replaceAll('\t', '    ')].reduce(
      (n, ch) =>
        n +
        (/[⺀-￯]/.test(ch)
          ? pt
          : Math.max(
              measureContext.measureText(ch).width,
              /[WM]/.test(ch) ? pt : pt * MIN_LATIN_EM,
            )),
      0,
    ) *
    MM_PER_PT *
    WIDTH_MARGIN
  );
};
export const lineMm = (pt: number) => emMm(pt) * LINE_HEIGHT_RATIO;
export const linesFor = (text: string, widthMm: number, pt: number) =>
  (text || '')
    .split('\n')
    .reduce((n, t) => n + Math.max(1, Math.ceil(textMm(t, pt) / Math.max(MIN_WIDTH_MM, widthMm))), 0);
/** 在给定高度里从基准字号往下找能放下的字号，最小 7 磅；Word、Excel 共用同一判断，不裁字。 */
export function fitPt(text: string, widthMm: number, basePt: number, heightMm: number) {
  for (let p = basePt; p >= MIN_PT; p -= PT_STEP)
    if (linesFor(text, widthMm, p) * lineMm(p) <= heightMm) return p;
  return null;
}
