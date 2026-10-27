import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  attachmentAccept,
  attachmentLimits,
  type AssistantAttachment,
} from '../shared/assistant-attachments';
import { attachmentSlots, type AttachmentSlot } from './AssistantAttachments';
import { managementRequest } from './session';
export function useAssistantUploads(
  userId: string | undefined,
  threadRef: MutableRefObject<any>,
  ensureThread: () => Promise<any>,
  onError: (s: string) => void,
) {
  const [slots, setSlots] = useState<AttachmentSlot[]>([]),
    ref = useRef(slots),
    owner = useRef(userId),
    queue = useRef(Promise.resolve()),
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
  const restore = (files: AssistantAttachment[]) => {
    if (!ref.current.some((s) => s.status === 'queued' || s.status === 'uploading'))
      update(() => attachmentSlots(files));
  };
  const upload = async (slot: AttachmentSlot, threadId: string, account: string) => {
    if (owner.current !== account || !ref.current.some((s) => s.key === slot.key)) return;
    const c = new AbortController();
    controllers.current.add(c);
    update((old) =>
      old.map((s) => (s.key === slot.key ? { ...s, status: 'uploading', error: '' } : s)),
    );
    try {
      const auth = await fetch('/api/auth/state', { cache: 'no-store' }).then((r) => r.json());
      if (auth.actor?.id !== account || owner.current !== account)
        throw Error('登录账号已变化，请重新上传。');
      const r = await fetch('/api/assistant/threads/' + threadId + '/attachments', {
        method: 'POST',
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(60000)]),
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-ERP-Auth-Token': auth.csrf,
          'X-File-Name': encodeURIComponent(slot.name),
          'X-Upload-Id': slot.key,
        },
        body: slot.file,
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.message || '上传失败');
      if (owner.current !== account) return;
      update((old) =>
        old.map((s) =>
          s.key === slot.key ? { ...s, status: 'ready', meta: result, error: '' } : s,
        ),
      );
    } catch (e) {
      if (owner.current === account)
        update((old) =>
          old.map((s) =>
            s.key === slot.key
              ? {
                  ...s,
                  status: 'failed',
                  error:
                    (e as Error).name === 'TimeoutError'
                      ? '上传超过60秒，可重试；相同上传凭据不会重复保存。'
                      : (e as Error).name === 'TypeError'
                        ? '网络连接失败，请检查服务后重试。'
                        : (e as Error).name === 'AbortError'
                          ? '上传已中断，可重试。'
                          : (e as Error).message,
                }
              : s,
          ),
        );
    } finally {
      controllers.current.delete(c);
    }
  };
  const add = async (files: File[]) => {
    if (!userId) {
      onError('请先登录，再上传附件。');
      return;
    }
    try {
      if (!files.length) return;
      for (const f of files) {
        const ext = '.' + f.name.split('.').at(-1)?.toLowerCase();
        if (!attachmentAccept.split(',').includes(ext))
          throw Error('不支持 ' + f.name + '，请选择图片、PDF、Word、Excel、CSV或TXT。');
        if (!f.size || f.size > attachmentLimits.fileBytes)
          throw Error('每份附件须大于0且不超过10MB。');
      }
      const account = userId,
        current = await ensureThread();
      if (owner.current !== account) return;
      const old = ref.current;
      if (
        old.length + files.length > 6 ||
        old.reduce((n, f) => n + f.size, 0) + files.reduce((n, f) => n + f.size, 0) >
          attachmentLimits.messageBytes
      )
        throw Error('每条消息最多6份附件，合计不超过30MB。');
      const next = files.map((file) => ({
        key: crypto.randomUUID(),
        file,
        name: file.name,
        size: file.size,
        status: 'queued' as const,
      }));
      update((old) => [...old, ...next]);
      for (const slot of next)
        queue.current = queue.current.then(() => upload(slot, current.id, account));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const retry = (s: AttachmentSlot) => {
    if (!s.file || !userId || !threadRef.current) return;
    update((old) => old.map((x) => (x.key === s.key ? { ...x, status: 'queued', error: '' } : x)));
    queue.current = queue.current.then(() => upload(s, threadRef.current.id, userId));
  };
  const remove = async (s: AttachmentSlot) => {
    const account = userId;
    try {
      if (s.meta)
        await managementRequest('/assistant/attachments/' + s.meta.id + '/delete', {
          acknowledged: true,
        });
      else if (threadRef.current)
        await managementRequest(
          '/assistant/threads/' + threadRef.current.id + '/attachments/cancel-upload',
          { uploadId: s.key, acknowledged: true },
        );
      if (owner.current === account) update((old) => old.filter((x) => x.key !== s.key));
    } catch (e) {
      if (owner.current === account) onError((e as Error).message);
    }
  };
  const reuse = (a: AssistantAttachment) => {
    if (a.deleted || ref.current.some((s) => s.meta?.id === a.id)) return;
    if (
      ref.current.length >= 6 ||
      ref.current.reduce((n, s) => n + s.size, 0) + a.size > attachmentLimits.messageBytes
    ) {
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
