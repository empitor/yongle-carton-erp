import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText,
  Image as ImageIcon,
  X,
  Download,
  RotateCcw,
  Plus,
  Minus,
  Paperclip,
} from 'lucide-react';
import type { AssistantAttachment } from '../shared/assistant-attachments';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './assistant-attachments.css';
export const attachmentUrl = (a: AssistantAttachment, download = false) =>
  '/api/assistant/attachments/' +
  encodeURIComponent(a.id) +
  '/file' +
  (download ? '?download=1' : '');
export const fileSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;
export type AttachmentSlot = {
  key: string;
  file?: File;
  meta?: AssistantAttachment;
  name: string;
  size: number;
  status: 'queued' | 'uploading' | 'ready' | 'failed';
  error?: string;
};
export function AttachmentCards({
  slots,
  preview,
  remove,
  retry,
  reuse,
  disabled = false,
}: {
  slots: AttachmentSlot[];
  preview: (a: AssistantAttachment) => void;
  remove?: (a: AttachmentSlot) => void;
  retry?: (a: AttachmentSlot) => void;
  reuse?: (a: AssistantAttachment) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ga-attachments" aria-label="聊天附件">
      {slots.map((s) => (
        <article
          className={'ga-attachment ' + (s.status === 'failed' ? 'is-error' : '')}
          key={s.key}
        >
          <button
            type="button"
            className="ga-attachment-open"
            disabled={!s.meta || s.meta.deleted}
            onClick={() => s.meta && preview(s.meta)}
            aria-label={'预览附件 ' + s.name}
          >
            {s.meta?.kind === 'image' && !s.meta.deleted ? (
              <img src={attachmentUrl(s.meta)} alt="" />
            ) : s.meta?.kind === 'image' ? (
              <ImageIcon size={22} />
            ) : (
              <FileText size={22} />
            )}
            <span>
              <strong title={s.name}>{s.name}</strong>
              <small>
                {fileSize(s.size)} ·{' '}
                {s.meta?.deleted
                  ? '已删除'
                  : s.status === 'uploading'
                    ? '上传中…'
                    : s.status === 'queued'
                      ? '等待上传'
                      : s.status === 'failed'
                        ? '上传失败'
                        : s.meta?.transfer === 'text'
                          ? '发送UTF-8原文'
                          : '原文件已保存'}
              </small>
              {s.meta?.transfer === 'file' && !s.meta.deleted && (
                <small title={s.meta.parseNotice}>
                  {s.meta.renderedPages
                    ? `含${s.meta.renderedPages}页扫描转图`
                    : s.meta.textAvailable
                      ? '可补充兼容文字（非完整排版）'
                      : '未能转换内容，请下载核对或改为图片'}
                </small>
              )}
            </span>
          </button>
          {s.status === 'failed' && retry && (
            <button
              type="button"
              aria-label={'重试上传 ' + s.name}
              onClick={() => retry(s)}
              disabled={disabled}
            >
              <RotateCcw size={14} />
            </button>
          )}
          {s.meta && !s.meta.deleted && reuse && (
            <button
              type="button"
              aria-label={'带入下条消息 ' + s.name}
              onClick={() => reuse(s.meta!)}
              disabled={disabled}
            >
              <Paperclip size={14} />
            </button>
          )}
          {remove && !s.meta?.deleted && (
            <button
              type="button"
              aria-label={'移除附件 ' + s.name}
              disabled={disabled || s.status === 'uploading'}
              onClick={() => remove(s)}
            >
              <X size={14} />
            </button>
          )}
          {s.error && <p role="alert">{s.error}</p>}
        </article>
      ))}
    </div>
  );
}
export const attachmentSlots = (files: AssistantAttachment[]): AttachmentSlot[] =>
  files.map((a) => ({ key: a.id, meta: a, name: a.name, size: a.size, status: 'ready' }));
export function AttachmentPreview({
  files,
  initialId,
  close,
}: {
  files: AssistantAttachment[];
  initialId: string;
  close: () => void;
}) {
  const [id, setId] = useState(initialId),
    [zoom, setZoom] = useState(1),
    [page, setPage] = useState(1),
    [pages, setPages] = useState(0),
    [error, setError] = useState(''),
    [text, setText] = useState(''),
    [loading, setLoading] = useState(false),
    [pdf, setPdf] = useState<any>(null);
  const canvas = useRef<HTMLCanvasElement>(null),
    root = useRef<HTMLElement>(null);
  const file = files.find((f) => f.id === id) || files[0];
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    root.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
      if (e.key === 'Tab') {
        const items = [
            ...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]'),
          ],
          first = items[0],
          last = items.at(-1);
        if (!items.length) return;
        if (
          e.shiftKey &&
          (document.activeElement === first || document.activeElement === root.current)
        ) {
          e.preventDefault();
          last?.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last || document.activeElement === root.current)
        ) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      prior?.focus();
    };
  }, []);
  useEffect(() => {
    let live = true,
      doc: any,
      loadingTask: any;
    const c = new AbortController();
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
    if (
      file.kind !== 'pdf' &&
      file.kind !== 'text' &&
      !(file.kind === 'office' && file.textAvailable)
    )
      return;
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(
          file.kind === 'office'
            ? '/api/assistant/attachments/' + file.id + '/text'
            : attachmentUrl(file),
          { signal: c.signal },
        );
        if (!response.ok) throw new Error((await response.json()).message || '附件无法读取');
        if (file.kind === 'office') {
          const data = await response.json();
          if (live) setText(data.text || '');
          return;
        }
        const bytes = await response.arrayBuffer();
        if (file.kind === 'text') {
          if (live) setText(new TextDecoder().decode(bytes));
        } else {
          const lib = await import('pdfjs-dist');
          lib.GlobalWorkerOptions.workerSrc = workerUrl;
          const task = lib.getDocument({
            data: new Uint8Array(bytes),
            enableXfa: false,
            maxImageSize: 20000000,
            stopAtErrors: true,
            useSystemFonts: true,
          });
          loadingTask = task;
          doc = await task.promise;
          if (!live) {
            await task.destroy();
            return;
          }
          setPdf(doc);
          setPages(doc.numPages);
        }
      } catch (e) {
        if (live) setError('预览失败：' + (e as Error).message + '。可尝试下载原文件核对。');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
      c.abort();
      void loadingTask?.destroy().catch(() => {});
    };
  }, [file.id]);
  useEffect(() => {
    if (!pdf) return;
    let live = true,
      render: any;
    void (async () => {
      try {
        const p = await pdf.getPage(page);
        if (!live || !canvas.current) return;
        const original = p.getViewport({ scale: 1 }),
          scale = Math.min(zoom, 2048 / original.width, 2048 / original.height),
          viewport = p.getViewport({ scale }),
          element = canvas.current;
        element.width = Math.ceil(viewport.width);
        element.height = Math.ceil(viewport.height);
        element.style.width = element.width + 'px';
        render = p.render({ canvas: element, viewport });
        await render.promise;
      } catch (e) {
        if (live && (e as Error).name !== 'RenderingCancelledException')
          setError('PDF页面渲染失败。请下载原文件查看。');
      }
    })();
    return () => {
      live = false;
      render?.cancel();
    };
  }, [pdf, page, zoom]);
  return createPortal(
    <div className="ga-preview-overlay" data-global-assistant="true">
      <section
        ref={root}
        tabIndex={-1}
        className="ga-preview"
        role="dialog"
        aria-modal="true"
        aria-label="聊天附件预览"
      >
        <header>
          <div>
            <strong>{file.name}</strong>
            <small>
              {fileSize(file.size)} · {file.mime}
            </small>
          </div>
          <a href={attachmentUrl(file, true)} aria-label="下载原附件">
            <Download size={18} />
            下载
          </a>
          <button onClick={close} aria-label="关闭附件预览">
            <X size={20} />
          </button>
        </header>
        <nav aria-label="切换预览附件">
          {files.map((f) => (
            <button
              key={f.id}
              className={f.id === file.id ? 'selected' : ''}
              onClick={() => setId(f.id)}
            >
              {f.name}
            </button>
          ))}
        </nav>
        {['image', 'pdf'].includes(file.kind) && (
          <div className="ga-preview-controls">
            <button aria-label="缩小附件" onClick={() => setZoom((v) => Math.max(0.25, v - 0.25))}>
              <Minus size={16} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button aria-label="放大附件" onClick={() => setZoom((v) => Math.min(4, v + 0.25))}>
              <Plus size={16} />
            </button>
            <button onClick={() => setZoom(1)}>适合窗口</button>
            {file.kind === 'pdf' && (
              <>
                <button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>
                  上一页
                </button>
                <span>
                  {page}/{pages || '…'}页
                </span>
                <button disabled={page >= pages} onClick={() => setPage((v) => v + 1)}>
                  下一页
                </button>
              </>
            )}
          </div>
        )}
        <div className="ga-preview-content">
          {loading && <p role="status">正在读取附件…</p>}
          {error && <p role="alert">{error}</p>}
          {file.kind === 'image' && !file.deleted && (
            <img
              src={attachmentUrl(file)}
              alt={file.name}
              style={{ width: `${zoom * 100}%` }}
              onError={() => setError('图片预览加载失败，请重新登录或下载检查。')}
            />
          )}
          {file.kind === 'pdf' && <canvas ref={canvas} />}{' '}
          {file.kind === 'text' && <pre>{text}</pre>}
          {file.kind === 'office' && (
            <div className="ga-office-info">
              <FileText size={46} />
              <h3>Office 原文件</h3>
              <p>当前不提供 Word / Excel 的完整排版预览，请下载后用 Office 或 WPS 核对。</p>
              <p>发送时按输入框中的文档发送方式处理。{file.parseNotice}</p>
              {file.textAvailable && (
                <details>
                  <summary>查看提取文字（非完整预览）</summary>
                  <pre>{text || '正在读取…'}</pre>
                </details>
              )}
              <a href={attachmentUrl(file, true)}>下载 {file.name}</a>
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
