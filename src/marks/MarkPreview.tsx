import { useEffect, useRef, useState } from 'react';

/** 同一文件被多款唛头引用时只下载一次，翻页和切换不重复请求。 */
const documents = new Map<string, Promise<{ kind: 'pdf'; doc: any } | { kind: 'image' }>>();
function load(url: string) {
  let task = documents.get(url);
  if (!task) {
    task = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error('读取文件失败');
      const type = response.headers.get('content-type') || '';
      if (type.startsWith('image/')) return { kind: 'image' as const };
      const bytes = await response.arrayBuffer();
      const [lib, worker] = await Promise.all([
        import('pdfjs-dist'),
        // 动态引入：产品详情被后端测试静态加载时，不会碰到 Vite 专用的 ?url
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      const doc = await lib.getDocument({
        data: new Uint8Array(bytes),
        enableXfa: false,
        useSystemFonts: true,
      }).promise;
      return { kind: 'pdf' as const, doc };
    })();
    documents.set(url, task);
    task.catch(() => documents.delete(url));
    if (documents.size > 8) documents.delete(documents.keys().next().value!);
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
      render: any;
    setError('');
    void (async () => {
      try {
        const file = await load(url);
        if (!live) return;
        setKind(file.kind);
        if (file.kind !== 'pdf') return;
        setPages(file.doc.numPages);
        const pdfPage = await file.doc.getPage(Math.min(current, file.doc.numPages));
        const target = canvas.current;
        if (!live || !target) return;
        const width = box.current?.clientWidth || 320;
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({
          scale: (width * (window.devicePixelRatio || 1)) / base.width,
        });
        target.width = viewport.width;
        target.height = viewport.height;
        render = pdfPage.render({ canvas: target, canvasContext: target.getContext('2d'), viewport });
        await render.promise;
      } catch (e) {
        if (live && (e as Error).name !== 'RenderingCancelledException')
          setError('预览失败，可下载查看。');
      }
    })();
    return () => {
      live = false;
      render?.cancel();
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
