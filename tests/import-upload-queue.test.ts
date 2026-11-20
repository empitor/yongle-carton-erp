// AI 导入上传队列（src/import/useUploadQueue.ts 的 queueItems、uploadOne）：安卓 App 分享来的文件结果只交一次，没收下也交
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BATCH,
  MAX_FILE_BYTES,
  NOT_READY,
  TOO_LARGE,
  forRetry,
  queueItems,
  uploadOne,
  type UploadItem,
  type UploadReport,
} from '../src/import/useUploadQueue.js';

/** 一份排队的文件，结果记进 reports；steps 记下列表上做了什么 */
function setup(send: () => Promise<{ duplicate: boolean }>, options: { dropped?: boolean; done?: () => Promise<void> } = {}) {
  const reports: UploadReport[] = [],
    steps: string[] = [];
  const item: UploadItem = { id: 'u1', file: new File(['虚构'], '虚构订单.pdf'), state: 'queued', report: (r) => reports.push(r) };
  const step = {
    dropped: options.dropped ?? false,
    start: () => steps.push('正在上传'),
    send,
    done: options.done ?? (() => Promise.resolve()),
    failed: (message: string) => steps.push('失败：' + message),
  };
  return { item, step, reports, steps };
}

test('传上去了交一次成功（带是不是撞上同一份）', async () => {
  const { item, step, reports, steps } = setup(() => Promise.resolve({ duplicate: true }));
  await uploadOne(item, step);
  assert.deepEqual(reports, [{ duplicate: true }]);
  assert.deepEqual(steps, ['正在上传']);
});

test('没传上交一次原因，列表里标成失败', async () => {
  const { item, step, reports, steps } = setup(() => Promise.reject(new Error('网络断了')));
  await uploadOne(item, step);
  assert.deepEqual(reports, [{ error: '网络断了' }]);
  assert.deepEqual(steps, ['正在上传', '失败：网络断了']);
});

test('传上去以后刷新列表出错，不再交第二次', async () => {
  const { item, step, reports } = setup(() => Promise.resolve({ duplicate: false }), {
    done: () => Promise.reject(new Error('列表没读到')),
  });
  await uploadOne(item, step);
  assert.deepEqual(reports, [{ duplicate: false }]);
});

test('排队时被人从列表里移除的不上传，交“已移除”', async () => {
  let sent = false;
  const { item, step, reports, steps } = setup(
    () => {
      sent = true;
      return Promise.resolve({ duplicate: false });
    },
    { dropped: true },
  );
  await uploadOne(item, step);
  assert.equal(sent, false);
  assert.deepEqual(steps, []);
  assert.deepEqual(reports, [{ error: '上传前已从列表移除，没有上传' }]);
});

test('超过上限的不上传，交原因', async () => {
  const { item, step, reports } = setup(() => Promise.resolve({ duplicate: false }));
  await uploadOne({ ...item, file: new File([new Uint8Array(MAX_FILE_BYTES + 1)], '大.pdf') }, step);
  assert.deepEqual(reports, [{ error: TOO_LARGE }]);
});

test('失败后重试的那一次不再交结果', async () => {
  const { item, step, reports } = setup(() => Promise.reject(new Error('网络断了')));
  await uploadOne(item, step);
  await uploadOne(forRetry({ ...item, state: 'failed', error: '网络断了' }), { ...step, send: () => Promise.resolve({ duplicate: false }) });
  assert.deepEqual(reports, [{ error: '网络断了' }]);
});

test('工作区还没读好（拿不到凭证）时一份不收，结果照样交“还没准备好”', () => {
  const reports: UploadReport[] = [];
  assert.equal(queueItems([new File(['虚构'], 'a.pdf')], null, (r) => reports.push(r)), null);
  assert.deepEqual(reports, [{ error: NOT_READY }]);
});

test('拿得到凭证时排进队，每份带着交结果的函数，一次最多收 MAX_BATCH 份', () => {
  const report = () => {};
  const files = Array.from({ length: MAX_BATCH + 2 }, (_, i) => new File(['虚构'], i + '.pdf'));
  const items = queueItems(files, 'ai-token', report) ?? [];
  assert.equal(items.length, MAX_BATCH);
  assert.ok(items.every((x) => x.state === 'queued' && x.report === report));
});
