import { useRef, useState } from 'react';
import { MIB, errorMessage } from '../../shared/core/index';
import { ORIGINAL_MAX_MB } from '../../shared/import/index';
import type { FileMode } from './fileStatus';
import { uploadWorkspaceFile } from './workspace-api';

/** 上传一份的结果（交回给安卓 App）：成功时是不是撞上了还没处理的同一份文件；没成功时的原因 */
export type UploadReport = { duplicate: boolean } | { error: string };

export type UploadItem = {
  id: string;
  file: File;
  state: 'queued' | 'uploading' | 'failed';
  error?: string;
  /** 第一次上传的结果交给谁（安卓 App 分享进来的文件要回给 App）；重试时不再交 */
  report?: (result: UploadReport) => void;
};

/** 一次最多传几份；多出来的让人分批传。 */
export const MAX_BATCH = 20;
/** 一份最大多少字节（和服务端收原件的上限一致） */
export const MAX_FILE_BYTES = ORIGINAL_MAX_MB * MIB;
export const TOO_LARGE = '文件不能超过' + ORIGINAL_MAX_MB + 'MB';
/** 工作区还没读好（拿不到工作区凭证）时交来的文件 */
export const NOT_READY = 'AI 导入页还没准备好，这份没有上传';
/** 排队时被人从列表里移除的文件 */
const DROPPED = '上传前已从列表移除，没有上传';

/** 传一份要做的几件事（不依赖 React；上传函数从这里传进来） */
type UploadStep<R> = {
  /** 这一份排队时已被人从列表里移除 */
  dropped: boolean;
  /** 开始传：列表里标成“正在上传” */
  start: () => void;
  send: (file: File) => Promise<R>;
  /** 传上去了：移出列表、提示、放进工作区并刷新列表 */
  done: (result: R) => Promise<void>;
  /** 没传上：列表里标成失败 */
  failed: (message: string) => void;
};

/**
 * 处理队列里的一份，结果只交一次（安卓 App 分享来的文件要回给 App）：排队时被移除交“已移除”；
 * 传上去就交成功，之后刷新列表出错也不再当成没传上；没传上交原因。
 */
export async function uploadOne<R extends { duplicate: boolean }>(item: UploadItem, step: UploadStep<R>) {
  let report = item.report;
  const reportOnce = (result: UploadReport) => {
    const to = report;
    report = undefined;
    to?.(result);
  };
  if (step.dropped) return reportOnce({ error: DROPPED });
  step.start();
  try {
    if (item.file.size > MAX_FILE_BYTES) throw new Error(TOO_LARGE);
    const result = await step.send(item.file);
    reportOnce({ duplicate: result.duplicate });
    await step.done(result);
  } catch (e) {
    step.failed(errorMessage(e));
    reportOnce({ error: errorMessage(e) });
  }
}

/**
 * 收下一批要传的文件，排成队里的几份（最多 MAX_BATCH 份）。拿不到工作区凭证（工作区还没读好）时一份不收，
 * 结果照样交（“还没准备好”），返回 null。
 */
export function queueItems(files: File[], token: string | null, report?: (result: UploadReport) => void): UploadItem[] | null {
  if (token === null) {
    report?.({ error: NOT_READY });
    return null;
  }
  return files.slice(0, MAX_BATCH).map((file) => ({ id: crypto.randomUUID(), file, state: 'queued', report }));
}

/** 重试的那一份：重新排队，结果不再交（第一次已经交过了） */
export const forRetry = (item: UploadItem): UploadItem => ({ ...item, state: 'queued', error: '', report: undefined });

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
        const id = item.id;
        await uploadOne(item, {
          dropped: dropped.current.has(id),
          start: () => mark(id, { state: 'uploading' }),
          send: (file) => uploadWorkspaceFile(token() || '', file, mode()),
          async done(result) {
            setUploads((x) => x.filter((y) => y.id !== id));
            setNotice(uploadNotice(result));
            await onUploaded(result);
          },
          failed: (message) => mark(id, { state: 'failed', error: message }),
        });
      }
    } finally {
      running.current = false;
    }
  }
  function upload(files: File[], report?: (result: UploadReport) => void) {
    const items = queueItems(files, token(), report);
    if (!items) return;
    if (files.length > MAX_BATCH) setNotice('每批最多' + MAX_BATCH + '份文件，其余文件请分批上传');
    setUploads((x) => [...x, ...items]);
    queue.current.push(...items);
    void drain();
  }
  function retryUpload(id: string) {
    const item = uploads.find((x) => x.id === id);
    if (!item) return;
    queue.current.push(forRetry(item));
    mark(id, { state: 'queued', error: '' });
    void drain();
  }
  function discardUpload(id: string) {
    dropped.current.add(id);
    setUploads((x) => x.filter((y) => y.id !== id));
  }
  return { uploads, upload, retryUpload, discardUpload };
}
