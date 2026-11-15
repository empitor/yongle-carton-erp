// 助手聊天附件的上传排队（src/assistant/attachment-queue.ts）：纯数据，不起服务、不渲染页面。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadQueue, type UploadJob } from '../src/assistant/attachment-queue.js';
import type { AttachmentSlot } from '../src/assistant/attachment-slots.js';

const file = new File(['虚构附件'], '虚构.txt');
const slot = (key: string): AttachmentSlot => ({ key, file, name: key + '.txt', size: file.size, status: 'failed' });

test('重试排在别的上传后面、轮到它之前换了账号（会话清掉了）：重试按点的那段会话传，之后再传的附件照样会传', async () => {
  const sent: string[] = [];
  let releaseFirst = () => {};
  const firstRunning = new Promise<void>((done) => {
    releaseFirst = done;
  });
  const queue = uploadQueue(async (job: UploadJob) => {
    sent.push(job.slot.key + '@' + job.threadId);
    if (job.slot.key === 'a') await firstRunning;
  });
  let thread: { id: string } | null = { id: '虚构会话1' };
  void queue.add({ slot: slot('a'), file, threadId: '虚构会话1', account: '虚构账号1' });
  assert.equal(queue.retry(slot('b'), '虚构账号1', () => thread), true);
  // 换账号：当前会话清掉
  thread = null;
  releaseFirst();
  await queue.add({ slot: slot('c'), file, threadId: '虚构会话2', account: '虚构账号2' });
  assert.deepEqual(sent, ['a@虚构会话1', 'b@虚构会话1', 'c@虚构会话2']);
});
