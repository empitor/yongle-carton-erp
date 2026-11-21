import { useRef } from 'react';
import { LoaderCircle, Upload, X } from 'lucide-react';
import type { AiStatus } from '../../shared/ai/index';
import { ORIGINAL_MAX_MB, originalFormats } from '../../shared/import/index';
import { Hint, MenuItem, MoreMenu } from '../ui/index';
import { modeLabels, type FileMode } from './fileStatus';
import { MAX_BATCH } from './useUploadQueue';
import { SEND_NOTE } from './ImportDialog';
import type { fileCounts } from './page-state';

export const ACCEPT = Object.keys(originalFormats).join(',');

/** 选文件的按钮（带隐藏的文件框）。页头和空白页的拖入区共用。 */
export function UploadButton({ upload }: { upload: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="primary" onClick={() => input.current?.click()}>
        <Upload size={16} />
        上传文件
      </button>
      <input
        ref={input}
        type="file"
        aria-label="上传订单文件"
        multiple
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          upload(Array.from(e.target.files || []));
          e.target.value = '';
        }}
      />
    </>
  );
}

/** 还没有文件时整页只有这一个拖入区 */
export function DropZone({ uploadMode, upload }: { uploadMode: FileMode; upload: (files: File[]) => void }) {
  return (
    <section className="aii-dropzone" aria-label="上传文件">
      <Upload size={28} aria-hidden="true" />
      <strong>
        {uploadMode === 'order' ? '把客户订单或到货单拖到这里' : '把' + modeLabels[uploadMode] + '拖到这里'}
      </strong>
      <span>
        支持 Excel、Word、PDF 和图片，一次最多 {MAX_BATCH} 份，每份 {ORIGINAL_MAX_MB}MB 以内。{SEND_NOTE}
      </span>
      <UploadButton upload={upload} />
    </section>
  );
}

/** AI 导入的页头：标题和几个数，右边“更多”（历史与归档）和主按钮“上传文件”。下面是提示条。 */
export default function ImportPageHead({
  empty,
  counts,
  running,
  waiting,
  openHistory,
  upload,
}: {
  empty: boolean;
  counts: ReturnType<typeof fileCounts>;
  /** 正在识别的份数 */
  running: number;
  /** 排队的份数 */
  waiting: number;
  openHistory: () => void;
  upload: (files: File[]) => void;
}) {
  return (
    <header className="oi-workspace-head">
      <div className="page-title">
        <h1>AI 导入</h1>
        {!empty && (
          <div className="oi-head-counts">
            <span>
              待核对 <strong>{counts.reviewing}</strong>
            </span>
            <span>
              待识别 <strong>{counts.waiting}</strong>
            </span>
            {running > 0 && (
              <span>
                <LoaderCircle className="spin" size={13} />
                识别中 <strong>{running}</strong>
              </span>
            )}
            {!!counts.failed && (
              <span className="aii-count-bad">
                识别失败 <strong>{counts.failed}</strong>
              </span>
            )}
            {!!waiting && (
              <span>
                排队 <strong>{waiting}</strong>
              </span>
            )}
          </div>
        )}
      </div>
      <div className="page-actions">
        <MoreMenu text="更多" label="AI 导入更多操作">
          <MenuItem onClick={openHistory}>
            历史与归档
          </MenuItem>
        </MoreMenu>
        {!empty && <UploadButton upload={upload} />}
      </div>
    </header>
  );
}

/** 页头下面的提示条：没填密钥、按哪种类型上传、出错（红）、办完的结果（蓝，可关）。 */
export function ImportBanners({
  ai,
  settingsLink,
  uploadMode,
  error,
  dismissError,
  notice,
  dismissNotice,
}: {
  ai?: AiStatus;
  settingsLink: boolean;
  uploadMode: FileMode;
  error?: string;
  dismissError: () => void;
  notice: string;
  dismissNotice: () => void;
}) {
  return (
    <>
      {ai && !ai.ready && (
        <Hint tone="warning">
          还没填写 DeepSeek 密钥，识别前要先在设置里填好。
          {settingsLink && (
            <>
              {' '}
              <a href="#ai-settings?tab=api">去设置</a>
            </>
          )}
        </Hint>
      )}
      {uploadMode !== 'order' && (
        <Hint tone="info">新上传的文件按{modeLabels[uploadMode]}识别，上传后也可以在右侧改类型。</Hint>
      )}
      {error && (
        <div className="aii-banner tone-danger" role="alert">
          <span>{error}</span>
          <button type="button" onClick={dismissError} aria-label="关闭提示">
            <X size={14} />
          </button>
        </div>
      )}
      {notice && (
        <div className="aii-banner tone-info" role="status">
          <span>{notice}</span>
          <button type="button" onClick={dismissNotice} aria-label="关闭通知">
            <X size={14} />
          </button>
        </div>
      )}
    </>
  );
}
