import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { textField } from './read-body';

/*
 * PDF 预览的公共件（唛头、助手附件都用）：打开一份 PDF、把其中一页画到画布上、换页或关掉时取消。
 * pdf.js 只在这里引（tests/ui-kit.test.ts 守着）；它和后台线程都点了才加载，不进首屏，
 * 后台线程的地址也动态引入：后端测试静态加载到这里时不会碰到 Vite 专用的 ?url。
 */

/** 打开好的一份 PDF */
export type PdfDocument = PDFDocumentProxy;

/** 画到画布上的边长最多多少像素（放大也不超过，免得画布太大画不出来） */
const MAX_CANVAS_SIDE = 2048;
/** pdf.js 解出的单张图片最多多少像素，超过的不解（防止恶意文件撑爆内存） */
const MAX_IMAGE_PIXELS = 20_000_000;

/** 打开一份 PDF。promise 交回打开好的文档；destroy 停下还没打开完的读取、放掉已打开的文档。 */
export function openPdf(bytes: ArrayBuffer) {
  let task: PDFDocumentLoadingTask | undefined,
    stopped = false;
  const promise = (async () => {
    const [lib, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    task = lib.getDocument({
      data: new Uint8Array(bytes),
      enableXfa: false,
      maxImageSize: MAX_IMAGE_PIXELS,
      stopAtErrors: true,
      useSystemFonts: true,
    });
    if (stopped) void task.destroy();
    return task.promise;
  })();
  const destroy = async () => {
    stopped = true;
    await task?.destroy();
  };
  return { promise, destroy };
}

/** 画哪一页、画到哪块画布上、按页面原宽（PDF 的点）算放大倍数，画不出来时怎么说 */
type PageDrawing = {
  page: number;
  canvas: { current: HTMLCanvasElement | null };
  scale: (pageWidth: number) => number;
  failed: () => void;
};

/**
 * 把 PDF 的一页画到画布上（边长不超过 MAX_CANVAS_SIDE），画布的像素大小跟着页面定。
 * 返回取消这次绘制的函数：翻页、缩放、关掉时上一次没画完的被取消，不算出错。
 */
export function drawPdfPage(doc: PdfDocument, { page, canvas, scale, failed }: PageDrawing) {
  let live = true,
    render: RenderTask | undefined;
  void (async () => {
    try {
      const p = await doc.getPage(page);
      const element = canvas.current;
      if (!live || !element) return;
      const original = p.getViewport({ scale: 1 }),
        fit = Math.min(scale(original.width), MAX_CANVAS_SIDE / original.width, MAX_CANVAS_SIDE / original.height),
        viewport = p.getViewport({ scale: fit });
      element.width = Math.ceil(viewport.width);
      element.height = Math.ceil(viewport.height);
      render = p.render({ canvas: element, viewport });
      await render.promise;
    } catch (e) {
      if (live && textField(e, 'name') !== 'RenderingCancelledException') failed();
    }
  })();
  return () => {
    live = false;
    render?.cancel();
  };
}
