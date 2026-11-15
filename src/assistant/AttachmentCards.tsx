import { FileText, Image as ImageIcon, X, RotateCcw, Paperclip } from 'lucide-react';
import type { ChatAttachment } from './assistant-types';
import { attachmentUrl, fileSize, slotStatusText, type AttachmentSlot } from './attachment-slots';

/** 一排附件卡片（输入框上方的待发附件、聊天记录里的附件）：缩略图、名字、大小和状态，按给的动作带重试、带入下条、移除。 */
export function AttachmentCards({
  slots,
  preview,
  remove,
  retry,
  reuse,
  disabled = false,
}: {
  slots: AttachmentSlot[];
  preview: (a: ChatAttachment) => void;
  remove?: (a: AttachmentSlot) => void;
  retry?: (a: AttachmentSlot) => void;
  reuse?: (a: ChatAttachment) => void;
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
            <AttachmentThumb meta={s.meta} />
            <span>
              <strong title={s.name}>{s.name}</strong>
              <small>
                {fileSize(s.size)} · {slotStatusText(s)}
              </small>
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
              onClick={() => s.meta && reuse(s.meta)}
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

/** 卡片左边的小图：图片附件直接显示，删了的图片和别的文件给图标 */
function AttachmentThumb({ meta }: { meta?: ChatAttachment }) {
  if (meta?.kind !== 'image') return <FileText size={22} />;
  return meta.deleted ? <ImageIcon size={22} /> : <img src={attachmentUrl(meta)} alt="" />;
}
