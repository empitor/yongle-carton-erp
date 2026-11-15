import { useEffect, useRef, useState, type RefObject } from 'react';
import { attachmentAccept, attachmentLimits, errorMessage } from '../../shared/core/index';
import { attachmentSlots, type AttachmentSlot } from './attachment-slots';
import { readAuthState } from '../ui/index';
import { cancelAttachmentUpload, deleteAttachment, uploadAttachment } from './assistant-api';
import type { ChatAttachment } from './assistant-types';
import type { ChatThread } from './thread-view';
import { uploadQueue, type UploadJob } from './attachment-queue';

/** 一份附件最多传多久（超时的提示里写的“60秒”就是它） */
const UPLOAD_TIMEOUT_MS = 60_000;

/** 待发附件的格子，和传附件要记住的：哪个账号、能停下的请求 */
function useSlotList(userId: string | undefined) {
  const [slots, setSlots] = useState<AttachmentSlot[]>([]),
    ref = useRef(slots),
    owner = useRef(userId),
    controllers = useRef(new Set<AbortController>());
  owner.current = userId;
  const update = (f: (old: AttachmentSlot[]) => AttachmentSlot[]) => {
    ref.current = f(ref.current);
    setSlots(ref.current);
  };
  useEffect(() => {
    for (const c of controllers.current) c.abort();
    controllers.current.clear();
    update(() => []);
  }, [userId]);
  useEffect(
    () => () => {
      for (const c of controllers.current) c.abort();
    },
    [],
  );
  return { slots, ref, owner, controllers, update };
}
type SlotList = ReturnType<typeof useSlotList>;

/** 传一份：传前现读登录状态，确认还是同一个账号；传完、失败都改这一格 */
async function uploadSlot(list: SlotList, { slot, file, threadId, account }: UploadJob) {
  const { owner, ref, update, controllers } = list;
  if (owner.current !== account || !ref.current.some((s) => s.key === slot.key)) return;
  const c = new AbortController();
  controllers.current.add(c);
  update((old) => old.map((s) => (s.key === slot.key ? { ...s, status: 'uploading', error: '' } : s)));
  try {
    const auth = await readAuthState();
    if (auth.actor?.id !== account || owner.current !== account) throw Error('登录账号已变化，请重新上传。');
    const result = await uploadAttachment(threadId, file, {
      token: auth.csrf,
      signal: AbortSignal.any([c.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]),
      name: slot.name,
      uploadId: slot.key,
    });
    if (owner.current !== account) return;
    update((old) => old.map((s) => (s.key === slot.key ? { ...s, status: 'ready', meta: result, error: '' } : s)));
  } catch (e) {
    if (owner.current === account)
      update((old) => old.map((s) => (s.key === slot.key ? { ...s, status: 'failed', error: uploadFailure(e) } : s)));
  } finally {
    controllers.current.delete(c);
  }
}

/** 没传成时格子上写的话：超时、网断、被停下各有说法，别的照原错误 */
function uploadFailure(e: unknown) {
  const name = e instanceof Error ? e.name : '';
  if (name === 'TimeoutError') return '上传超过60秒，可重试；相同上传凭据不会重复保存。';
  if (name === 'TypeError') return '网络连接失败，请检查服务后重试。';
  if (name === 'AbortError') return '上传已中断，可重试。';
  return errorMessage(e);
}

/** 选好的文件能不能传：格式、单份大小 */
function checkFiles(files: File[]) {
  for (const f of files) {
    const ext = '.' + f.name.split('.').at(-1)?.toLowerCase();
    if (!attachmentAccept.split(',').includes(ext))
      throw Error('不支持 ' + f.name + '，请选择图片、PDF、Word、Excel、CSV或TXT。');
    if (!f.size || f.size > attachmentLimits.fileBytes) throw Error('每份附件须大于0且不超过10MB。');
  }
}

/** 加上这几份后会不会超过一条消息的份数、合计大小 */
const overLimit = (old: { size: number }[], added: { size: number }[]) =>
  old.length + added.length > attachmentLimits.messageCount ||
  old.reduce((n, f) => n + f.size, 0) + added.reduce((n, f) => n + f.size, 0) > attachmentLimits.messageBytes;

/**
 * 待发附件：选文件后先确保有会话，再按顺序一份一份传；失败的可重试，传好的、没传完的都能移除，
 * 聊天记录里的附件可以再用一次。换账号时停掉在传的、清空格子。
 */
export function useAssistantUploads(
  userId: string | undefined,
  threadRef: RefObject<ChatThread | null>,
  ensureThread: () => Promise<ChatThread>,
  onError: (s: string) => void,
) {
  const list = useSlotList(userId);
  const { slots, ref, owner, update } = list;
  // 排队只建一次；uploadSlot 只用 list 里不变的 ref 和设置函数，拿第一次渲染的就行
  const [queue] = useState(() => uploadQueue((job) => uploadSlot(list, job)));
  const restore = (files: ChatAttachment[]) => {
    if (!ref.current.some((s) => s.status === 'queued' || s.status === 'uploading')) update(() => attachmentSlots(files));
  };
  const add = async (files: File[]) => {
    if (!userId) {
      onError('请先登录，再上传附件。');
      return;
    }
    try {
      if (!files.length) return;
      checkFiles(files);
      const account = userId,
        current = await ensureThread();
      if (owner.current !== account) return;
      if (overLimit(ref.current, files)) throw Error('每条消息最多6份附件，合计不超过30MB。');
      const next = files.map((file) => ({ key: crypto.randomUUID(), file, name: file.name, size: file.size, status: 'queued' as const }));
      update((old) => [...old, ...next]);
      for (const slot of next) void queue.add({ slot, file: slot.file, threadId: current.id, account });
    } catch (e) {
      onError(errorMessage(e));
    }
  };
  const retry = (s: AttachmentSlot) => {
    // 排上了才把这一格改回“等待上传”（排队是异步的，轮到它时已经改好）
    if (queue.retry(s, userId, () => threadRef.current))
      update((old) => old.map((x) => (x.key === s.key ? { ...x, status: 'queued', error: '' } : x)));
  };
  const remove = async (s: AttachmentSlot) => {
    const account = userId;
    try {
      if (s.meta) await deleteAttachment(s.meta.id);
      else if (threadRef.current) await cancelAttachmentUpload(threadRef.current.id, s.key);
      if (owner.current === account) update((old) => old.filter((x) => x.key !== s.key));
    } catch (e) {
      if (owner.current === account) onError(errorMessage(e));
    }
  };
  const reuse = (a: ChatAttachment) => {
    if (a.deleted || ref.current.some((s) => s.meta?.id === a.id)) return;
    if (overLimit(ref.current, [a])) {
      onError('附件数量或总大小超过本条消息上限。');
      return;
    }
    update((old) => [...old, ...attachmentSlots([a])]);
  };
  return {
    slots,
    add,
    retry,
    remove,
    reuse,
    restore,
    reset: () => update(() => []),
    working: slots.some((s) => s.status === 'queued' || s.status === 'uploading'),
    failed: slots.some((s) => s.status === 'failed'),
    ready: slots.flatMap((s) => (s.meta && !s.meta.deleted ? [s.meta] : [])),
  };
}
