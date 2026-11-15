import { useEffect, useRef, useState } from 'react';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { errorMessage } from '../../shared/core/index';
import { textField } from '../ui/index';
import { readAttachmentBytes } from './assistant-api';
import type { ChatAttachment } from './assistant-types';

/** 画到画布上的 PDF 页面边长最多多少像素（放大也不超过，免得画布太大画不出来） */
const MAX_CANVAS_SIDE = 2048;
/** pdf.js 解出的单张图片最多多少像素，超过的不解（防止恶意文件撑爆内存） */
const MAX_IMAGE_PIXELS = 20_000_000;

/**
 * 附件预览里正在看的这一份：文本读出原文，PDF 交给 pdf.js 打开、按页码和缩放画到画布上；
 * 换一份附件时页码、缩放、内容和出错都从头来。图片和 Office 文件不用读，由页面直接显示或给下载。
 */
export function useAttachmentDocument(file: ChatAttachment) {
  const [zoom, setZoom] = useState(1),
    [page, setPage] = useState(1),
    [pages, setPages] = useState(0),
    [error, setError] = useState(''),
    [text, setText] = useState(''),
    [loading, setLoading] = useState(false),
    [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // 预览窗口的附件列表打开时就定了（GlobalAssistant 的 previewFiles），同一份附件一直是同一个对象：换了 file 就是换了附件
  useEffect(() => {
    setPdf(null);
    setZoom(1);
    setPage(1);
    setPages(0);
    setText('');
    setError('');
    if (file.deleted) {
      setError('附件已删除。');
      return;
    }
    setLoading(false);
    if (file.kind !== 'pdf' && file.kind !== 'text') return;
    return openDocument(file, {
      setText,
      setLoading,
      setError,
      opened: (doc) => {
        setPdf(doc);
        setPages(doc.numPages);
      },
    });
  }, [file]);
  useEffect(() => (pdf ? drawPage(pdf, { page, zoom, canvas, setError }) : undefined), [pdf, page, zoom]);
  return { zoom, setZoom, page, setPage, pages, error, setError, text, loading, canvas };
}

type OpenHandlers = {
  setText: (text: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (message: string) => void;
  opened: (doc: PDFDocumentProxy) => void;
};

/** 读附件原文件：文本直接解码，PDF 交给 pdf.js 打开。返回停下这次读取的函数（换附件、关预览时调）。 */
function openDocument(file: ChatAttachment, on: OpenHandlers) {
  let live = true,
    loadingTask: PDFDocumentLoadingTask | undefined;
  const c = new AbortController();
  on.setLoading(true);
  void (async () => {
    try {
      const bytes = await readAttachmentBytes(file, c.signal);
      if (file.kind === 'text') {
        if (live) on.setText(new TextDecoder().decode(bytes));
        return;
      }
      const lib = await import('pdfjs-dist');
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      loadingTask = lib.getDocument({
        data: new Uint8Array(bytes),
        enableXfa: false,
        maxImageSize: MAX_IMAGE_PIXELS,
        stopAtErrors: true,
        useSystemFonts: true,
      });
      const doc = await loadingTask.promise;
      if (!live) return void (await loadingTask.destroy());
      on.opened(doc);
    } catch (e) {
      if (live) on.setError('预览失败：' + errorMessage(e) + '。可尝试下载原文件核对。');
    } finally {
      if (live) on.setLoading(false);
    }
  })();
  return () => {
    live = false;
    c.abort();
    void loadingTask?.destroy().catch(() => {
      // 关预览、换附件时收拾 pdf.js 的加载：收拾不成也不影响页面，这份已经不显示了
    });
  };
}

/** 画哪一页、放大多少、画到哪块画布上；画不出来时在哪说 */
type PageDrawing = {
  page: number;
  zoom: number;
  canvas: { current: HTMLCanvasElement | null };
  setError: (message: string) => void;
};

/** 把 PDF 的一页画到画布上（边长不超过 MAX_CANVAS_SIDE）。返回取消这次绘制的函数。 */
function drawPage(pdf: PDFDocumentProxy, { page, zoom, canvas, setError }: PageDrawing) {
  let live = true,
    render: RenderTask | undefined;
  void (async () => {
    try {
      const p = await pdf.getPage(page);
      if (!live || !canvas.current) return;
      const original = p.getViewport({ scale: 1 }),
        scale = Math.min(zoom, MAX_CANVAS_SIDE / original.width, MAX_CANVAS_SIDE / original.height),
        viewport = p.getViewport({ scale }),
        element = canvas.current;
      element.width = Math.ceil(viewport.width);
      element.height = Math.ceil(viewport.height);
      element.style.width = element.width + 'px';
      render = p.render({ canvas: element, viewport });
      await render.promise;
    } catch (e) {
      // 翻页、缩放时上一次没画完的被取消，不算出错
      if (live && textField(e, 'name') !== 'RenderingCancelledException') setError('PDF页面渲染失败。请下载原文件查看。');
    }
  })();
  return () => {
    live = false;
    render?.cancel();
  };
}
