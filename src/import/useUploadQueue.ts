import { useRef, useState } from 'react';
import { MIB, errorMessage } from '../../shared/core/index';
import { ORIGINAL_MAX_MB } from '../../shared/import/index';
import type { FileMode } from './fileStatus';
import { uploadWorkspaceFile } from './workspace-api';

export type UploadItem = {
  id: string;
  file: File;
  state: 'queued' | 'uploading' | 'failed';
  error?: string;
};

/** 一次最多传几份；多出来的让人分批传。 */
export const MAX_BATCH = 20;
const MAX_BYTES = ORIGINAL_MAX_MB * MIB;

/** 上传好的一份：是不是撞上了还没处理的同一份文件、这份工作区 */
type Uploaded = Awaited<ReturnType<typeof uploadWorkspaceFile>>;
/** 上传成功后给人看的一句话。 */
function uploadNotice(result: Uploaded) {
  return result.duplicate
    ? '相同文件尚未处理，已恢复原任务'
    : result.workspace.historyImport
      ? '该文件此前处理过，已创建新的导入任务；历史记录和原订单凭据保留'
      : '已保存原件，还没有发给 AI 识别';
}

/**
 * AI 导入的上传队列：一份一份传，失败的留在列表里可以重试或丢掉。
 * 传好一份交给 onUploaded（放进工作区、按需要切识别类型、刷新列表）。
 */
export function useUploadQueue({
  token,
  mode,
  onUploaded,
  setNotice,
}: {
  /** 工作区凭证；还没读到工作区列表时为 null，这时不收文件 */
  token: () => string | null;
  /** 新传的文件按哪种类型识别 */
  mode: () => FileMode;
  onUploaded: (result: Uploaded) => Promise<void>;
  setNotice: (text: string) => void;
}) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const queue = useRef<UploadItem[]>([]),
    running = useRef(false),
    dropped = useRef(new Set<string>());
  const mark = (id: string, patch: Partial<UploadItem>) =>
    setUploads((x) => x.map((y) => (y.id === id ? { ...y, ...patch } : y)));
  async function drain() {
    if (running.current) return;
    running.current = true;
    try {
      for (let item = queue.current.shift(); item; item = queue.current.shift()) {
        if (dropped.current.has(item.id)) continue;
        mark(item.id, { state: 'uploading' });
        try {
          if (item.file.size > MAX_BYTES) throw new Error('文件不能超过10MB');
          const result = await uploadWorkspaceFile(token() || '', item.file, mode());
          setUploads((x) => x.filter((y) => y.id !== item.id));
          setNotice(uploadNotice(result));
          await onUploaded(result);
        } catch (e) {
          mark(item.id, { state: 'failed', error: errorMessage(e) });
        }
      }
    } finally {
      running.current = false;
    }
  }
  function upload(files: File[]) {
    if (token() === null) return;
    const items = files
      .slice(0, MAX_BATCH)
      .map((file) => ({ id: crypto.randomUUID(), file, state: 'queued' as const }));
    if (files.length > MAX_BATCH) setNotice('每批最多20个文件，其余文件请分批上传');
    setUploads((x) => [...x, ...items]);
    queue.current.push(...items);
    void drain();
  }
  function retryUpload(id: string) {
    const item = uploads.find((x) => x.id === id);
    if (!item) return;
    queue.current.push({ ...item, state: 'queued' });
    mark(id, { state: 'queued', error: '' });
    void drain();
  }
  function discardUpload(id: string) {
    dropped.current.add(id);
    setUploads((x) => x.filter((y) => y.id !== id));
  }
  return { uploads, upload, retryUpload, discardUpload };
}
