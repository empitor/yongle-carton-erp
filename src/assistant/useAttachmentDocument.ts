import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../shared/core/index';
import { drawPdfPage, openPdf, type PdfDocument } from '../ui/index';
import { readAttachmentBytes } from './assistant-api';
import type { ChatAttachment } from './assistant-types';

/**
 * 附件预览里正在看的这一份：文本读出原文，PDF 用 src/ui 的公共件打开、按页码和缩放画到画布上；
 * 换一份附件时页码、缩放、内容和出错都从头来。图片和 Office 文件不用读，由页面直接显示或给下载。
 */
export function useAttachmentDocument(file: ChatAttachment) {
  const [zoom, setZoom] = useState(1),
    [page, setPage] = useState(1),
    [pages, setPages] = useState(0),
    [error, setError] = useState(''),
    [text, setText] = useState(''),
    [loading, setLoading] = useState(false),
    [pdf, setPdf] = useState<PdfDocument | null>(null);
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
  useEffect(
    () =>
      pdf
        ? drawPdfPage(pdf, { page, canvas, scale: () => zoom, failed: () => setError('PDF页面渲染失败。请下载原文件查看。') })
        : undefined,
    [pdf, page, zoom],
  );
  return { zoom, setZoom, page, setPage, pages, error, setError, text, loading, canvas };
}

type OpenHandlers = {
  setText: (text: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (message: string) => void;
  opened: (doc: PdfDocument) => void;
};

/** 读附件原文件：文本直接解码，PDF 交给公共件打开。返回停下这次读取的函数（换附件、关预览时调）。 */
function openDocument(file: ChatAttachment, on: OpenHandlers) {
  let live = true,
    opening: ReturnType<typeof openPdf> | undefined;
  const c = new AbortController();
  on.setLoading(true);
  void (async () => {
    try {
      const bytes = await readAttachmentBytes(file, c.signal);
      if (file.kind === 'text') {
        if (live) on.setText(new TextDecoder().decode(bytes));
        return;
      }
      opening = openPdf(bytes);
      const doc = await opening.promise;
      if (!live) return void (await opening.destroy());
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
    void opening?.destroy().catch(() => {
      // 关预览、换附件时收拾 pdf.js 的加载：收拾不成也不影响页面，这份已经不显示了
    });
  };
}
