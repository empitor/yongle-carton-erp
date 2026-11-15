import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { FileText, X, Download, Plus, Minus } from 'lucide-react';
import type { ChatAttachment } from './assistant-types';
import { attachmentUrl, fileSize, remoteCopyNote } from './attachment-slots';
import { useAttachmentDocument } from './useAttachmentDocument';

/**
 * 聊天附件预览窗口：几份附件之间切换；图片和 PDF 能缩放，PDF 翻页；文本显示原文；Office 文件只给下载。
 * Esc 关闭，Tab 在窗口里转，关掉后焦点回到原处。
 */
export function AttachmentPreview({
  files,
  initialId,
  close,
}: {
  files: ChatAttachment[];
  initialId: string;
  close: () => void;
}) {
  const [id, setId] = useState(initialId);
  const root = useRef<HTMLElement>(null);
  const file = files.find((f) => f.id === id) || files[0];
  const doc = useAttachmentDocument(file);
  const { zoom, setZoom, page, setPage, pages } = doc;
  useDialogKeys(root, close);
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
          {doc.loading && <p role="status">正在读取附件…</p>}
          {doc.error && <p role="alert">{doc.error}</p>}
          {file.kind === 'image' && !file.deleted && (
            <img
              src={attachmentUrl(file)}
              alt={file.name}
              style={{ width: `${zoom * 100}%` }}
              onError={() => doc.setError('图片预览加载失败，请重新登录或下载检查。')}
            />
          )}
          {file.kind === 'pdf' && <canvas ref={doc.canvas} />}{' '}
          {file.kind === 'text' && <pre>{doc.text}</pre>}
          {file.kind === 'office' && <OfficeInfo file={file} />}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** Office 原文件不做排版预览，只说明并给下载 */
function OfficeInfo({ file }: { file: ChatAttachment }) {
  return (
    <div className="ga-office-info">
      <FileText size={46} />
      <h3>Office 原文件</h3>
      <p>这里不提供 Word / Excel 的排版预览，请下载后用 Office 或 WPS 核对。</p>
      <p>让小甬小勒读这份文件时，原文件会交给 DeepSeek 读。{remoteCopyNote}</p>
      <a href={attachmentUrl(file, true)}>下载 {file.name}</a>
    </div>
  );
}

/** 窗口打开时焦点进来：Esc 关闭（不让助手面板也收到），Tab 只在窗口里的按钮和链接之间转；关掉后焦点回到原处 */
function useDialogKeys(root: RefObject<HTMLElement | null>, close: () => void) {
  // 只在窗口打开时装一次：close 每次渲染都是新的，按键时经 ref 取最新的；root 是同一个 ref，不会让它重跑
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const prior = document.activeElement;
    root.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === 'Tab' && root.current) trapTab(e, root.current);
    };
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      if (prior instanceof HTMLElement || prior instanceof SVGElement) prior.focus();
    };
  }, [root]);
}

function trapTab(e: KeyboardEvent, box: HTMLElement) {
  const items = [...box.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')],
    first = items[0],
    last = items.at(-1);
  if (!items.length) return;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === box)) {
    e.preventDefault();
    last?.focus();
  } else if (!e.shiftKey && (active === last || active === box)) {
    e.preventDefault();
    first?.focus();
  }
}
