import type { AttachmentSlot } from './attachment-slots';

/** 一份附件传到哪段会话、算哪个账号的：排进来时就定好 */
export type UploadJob = { slot: AttachmentSlot; file: File; threadId: string; account: string };

/**
 * 聊天附件的上传排队：一份传完再传下一份（upload 自己接住出错，不往外抛）。
 * 每份传到哪段会话在排进来时就定好，排到它时不再去读“当前会话”：那时可能已经换了账号、会话清掉了，
 * 读空了会抛错，排在后面的就再也不传了。不依赖 React，测试里直接调（tests/assistant-upload-queue.test.ts）。
 */
export function uploadQueue(upload: (job: UploadJob) => Promise<void>) {
  let tail: Promise<void> = Promise.resolve();
  const add = (job: UploadJob) => {
    tail = tail.then(() => upload(job));
    return tail;
  };
  return {
    add,
    /**
     * 重试没传成的一格：要有原文件、登录账号和打开着的会话，会话按点重试这一刻的算（currentThread 读当前会话）。
     * 排上了返回 true。
     */
    retry(slot: AttachmentSlot, account: string | undefined, currentThread: () => { id: string } | null) {
      const file = slot.file,
        thread = currentThread();
      if (!file || !account || !thread) return false;
      void add({ slot, file, threadId: thread.id, account });
      return true;
    },
  };
}
