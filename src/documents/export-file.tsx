// 导出文件的下载和预览：导出窗口和订货单窗口共用（拆出来，两个窗口就不用互相引用）
import { useEffect, useRef, useState } from 'react';
import type { DocumentExportStatus } from '../../shared/documents/index';
import { errorMessage } from '../../shared/core/index';
import { completeExport, downloadExportFile } from './document-api';
import { Hint } from '../ui/index';
import { emit } from '../ui/index';

/** 临时下载地址留多久（毫秒） */
const OBJECT_URL_LIFETIME = 60000;
/** 一份导出好的文件：下载地址、校验值、文件名、导出编号，交付后改不改状态 */
type ExportedFile = Pick<DocumentExportStatus, 'url' | 'sha256' | 'filename' | 'exportId' | 'markOrdered' | 'markShipped'>;
/** 预览 Word 排版拿到的文件内容；exportId 只当刷新的键 */
export type WordFile = { bytes: ArrayBuffer; exportId: string };

/** 把读到的文件内容交给浏览器下载（文件名带扩展名）；临时地址一分钟后释放。 */
export function saveBytes(bytes: ArrayBuffer, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type })),
    a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME);
}
/** 下载、核对校验值、交给浏览器保存，再告诉服务端交付完成（这时才改业务状态） */
export async function deliverBusinessFile(file: Pick<ExportedFile, 'url' | 'sha256' | 'filename' | 'exportId'>) {
  if (!/^\/api\/documents\/[a-f0-9-]+\/file$/.test(file.url)) throw new Error('下载地址无效。');
  const { bytes, type } = await downloadExportFile(file.url),
    hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
  if (hash !== file.sha256) throw new Error('文件校验失败，未修改业务状态。');
  saveBytes(bytes, type, file.filename);
  const result = await completeExport(file.exportId, hash);
  emit('erp-business-changed');
  return result;
}
export function ExportFileCard({ file }: { file: ExportedFile }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [failed, setFailed] = useState(false);
  return (
    <div className="export-file-card">
      <strong>{file.filename}</strong>
      <span>
        {file.markOrdered
          ? '完整下载后变成待到货'
          : file.markShipped
            ? '完整下载后出库，送货单变“送货中”'
            : '重复下载不改变库存及实物状态'}
      </span>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await deliverBusinessFile(file);
            setFailed(false);
            setMessage('文件已交付。');
          } catch (e) {
            // 服务端的原话照原样显示（例如文件过期、这份订货单已作废），不显示成交付成功
            setFailed(true);
            setMessage(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '正在交付…' : '下载文件'}
      </button>
      {message &&
        (failed ? (
          <div role="alert">
            <Hint tone="danger">{message}</Hint>
          </div>
        ) : (
          <p role="status">{message}</p>
        ))}
    </div>
  );
}

export function WordFilePreview({ file }: { file: WordFile }) {
  const target = useRef<HTMLDivElement>(null),
    [error, setError] = useState('');
  // 换了一份预览（exportId 变了）才重画；画的时候取最新的文件内容
  const latest = useRef(file);
  useEffect(() => {
    latest.current = file;
  });
  useEffect(() => {
    let active = true;
    const element = target.current;
    if (!element) return;
    void (async () => {
      try {
        const { renderAsync } = await import('docx-preview');
        if (active)
          await renderAsync(latest.current.bytes, element, undefined, {
            className: 'erp-word',
            inWrapper: true,
            renderAltChunks: false,
            ignoreLastRenderedPageBreak: false,
          });
      } catch (e) {
        if (active) setError(errorMessage(e));
      }
    })();
    return () => {
      active = false;
    };
  }, [file.exportId]);
  return (
    <>
      {error && (
        <div role="alert">
          <Hint tone="danger">{error}</Hint>
        </div>
      )}
      <p className="adm-muted adm-word-note">
        这是服务端生成的 Word 排版。浏览器不模拟 Word 自动分页，最终打印分页以办公软件为准。
      </p>
      <div className="word-file-preview" ref={target} />
    </>
  );
}
