import { useEffect, useRef, useState } from 'react';
import { drawPdfPage, openPdf, type PdfDocument } from '../ui/index';
import { readMarkFile } from './mark-api';

/** 最多记住几份读过的文件 */
const CACHED_FILES = 8;
/** 预览框量不出宽度时按多宽画 */
const FALLBACK_WIDTH = 320;
/** 同一文件被多款唛头引用时只下载一次，翻页和切换不重复请求。 */
const documents = new Map<string, Promise<{ kind: 'pdf'; doc: PdfDocument } | { kind: 'image' }>>();
function load(url: string) {
  let task = documents.get(url);
  if (!task) {
    task = (async () => {
      const response = await readMarkFile(url);
      if (!response.ok) throw new Error('读取文件失败');
      const type = response.headers.get('content-type') || '';
      if (type.startsWith('image/')) return { kind: 'image' as const };
      const doc = await openPdf(await response.arrayBuffer()).promise;
      return { kind: 'pdf' as const, doc };
    })();
    documents.set(url, task);
    task.catch(() => documents.delete(url));
    // 超过上限丢掉最早读的那份
    const oldest = documents.keys().next();
    if (documents.size > CACHED_FILES && !oldest.done) documents.delete(oldest.value);
  }
  return task;
}

/** 显示图片或 PDF 的某一页。page 为 0 时显示第一页。 */
export default function MarkPreview({
  url,
  page = 0,
  alt = '唛头预览',
  pager = false,
}: {
  url: string;
  page?: number;
  alt?: string;
  /** 大预览里可以翻看整份文件的每一页 */
  pager?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    box = useRef<HTMLDivElement>(null);
  const [kind, setKind] = useState<'pdf' | 'image' | ''>(''),
    [error, setError] = useState(''),
    [current, setCurrent] = useState(Math.max(page, 1)),
    [pages, setPages] = useState(0);
  useEffect(() => setCurrent(Math.max(page, 1)), [page]);
  useEffect(() => {
    let live = true,
      stopDrawing: (() => void) | undefined;
    const failed = () => live && setError('预览失败，可下载查看。');
    setError('');
    void (async () => {
      try {
        const file = await load(url);
        if (!live) return;
        setKind(file.kind);
        if (file.kind !== 'pdf') return;
        setPages(file.doc.numPages);
        // 按预览框的宽度画（高分屏按设备像素画清楚）
        stopDrawing = drawPdfPage(file.doc, {
          page: Math.min(current, file.doc.numPages),
          canvas,
          scale: (pageWidth) => ((box.current?.clientWidth || FALLBACK_WIDTH) * (window.devicePixelRatio || 1)) / pageWidth,
          failed,
        });
      } catch {
        failed();
      }
    })();
    return () => {
      live = false;
      stopDrawing?.();
    };
  }, [url, current]);
  return (
    <div className="mark-preview" ref={box}>
      {error ? (
        <p className="sub">{error}</p>
      ) : kind === 'image' ? (
        <img src={url} alt={alt} />
      ) : (
        <canvas ref={canvas} aria-label={alt} />
      )}
      {pager && pages > 1 && (
        <div className="mark-pager">
          <button disabled={current <= 1} onClick={() => setCurrent((p) => p - 1)}>
            上一页
          </button>
          <span>
            {current} / {pages}
          </span>
          <button disabled={current >= pages} onClick={() => setCurrent((p) => p + 1)}>
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
