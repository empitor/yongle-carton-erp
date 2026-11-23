// 安卓 App 里保存文件（src/app-save.ts）：发 save-file 等 App 回 save-result，存好才算完；没接通、没存成、等不到、重新接通都报错
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAppSaver } from '../../src/app-save.js';

const TIMEOUT_MS = 5000;
function setup() {
  const sent: unknown[] = [],
    saver = createAppSaver(TIMEOUT_MS);
  const connect = () => saver.connect((message) => sent.push(message));
  return { saver, sent, connect };
}
/** 发出去的 save-file 里要看的几项 */
const sentFile = z.object({ id: z.number(), data: z.string() });
const bytesOf = (text: string) => new TextEncoder().encode(text).buffer;
const result = (id: number, ok: boolean, message?: string) => ({ type: 'save-result', id, ok, ...(message ? { message } : {}) });

afterEach(() => mock.timers.reset());

test('没接通时保存直接报错，不发消息', async () => {
  const { saver, sent } = setup();
  await assert.rejects(saver.save(bytesOf('x'), 'text/plain', 'a.txt'), { message: '安卓 App 还没准备好，文件没有保存。请稍等几秒再试。' });
  assert.deepEqual(sent, []);
});

test('接通后发 save-file（编号从 1 递增、内容是 base64），App 回存好了才算完', async () => {
  const { saver, sent, connect } = setup();
  connect();
  let saved = false;
  const first = saver.save(bytesOf('送货单内容'), 'application/vnd.ms-excel', '送货单.xlsx').then(() => (saved = true));
  const second = saver.save(bytesOf('订货单'), 'application/pdf', '订货单.pdf');
  assert.deepEqual(sent[0], {
    type: 'save-file',
    id: 1,
    name: '送货单.xlsx',
    mime: 'application/vnd.ms-excel',
    data: Buffer.from('送货单内容').toString('base64'),
  });
  assert.equal(sentFile.parse(sent[1]).id, 2);
  await Promise.resolve();
  assert.equal(saved, false);
  assert.equal(saver.receive(result(1, true)), true);
  assert.equal(saver.receive(result(2, true)), true);
  await Promise.all([first, second]);
  assert.equal(saved, true);
});

test('大文件分段转 base64，结果和整段转的一样', async () => {
  const { saver, sent, connect } = setup();
  connect();
  const bytes = Uint8Array.from({ length: 0x8000 * 2 + 5 }, (_, i) => (i * 7) % 256);
  const done = saver.save(bytes.buffer, 'application/pdf', '大.pdf');
  assert.equal(sentFile.parse(sent[0]).data, Buffer.from(bytes).toString('base64'));
  saver.receive(result(1, true));
  await done;
});

test('App 回没存成时按它给的原因报错；不在等的编号丢掉', async () => {
  const { saver, connect } = setup();
  connect();
  const save = saver.save(bytesOf('x'), 'text/plain', 'a.txt');
  assert.equal(saver.receive(result(99, true)), true);
  saver.receive(result(1, false, '手机存储空间不够，没有保存。'));
  await assert.rejects(save, { message: '手机存储空间不够，没有保存。' });
});

test('页面重新接通时还在等的保存一律按没存成，说法留余地（App 那头可能已经存好）', async () => {
  const { saver, connect } = setup();
  connect();
  const save = saver.save(bytesOf('x'), 'text/plain', 'a.txt');
  connect();
  await assert.rejects(save, { message: '页面重新连上了安卓 App，没等到保存结果，文件可能没有保存。请到手机“下载”里看一看，没有就再试一次。' });
});

test('发不出去时马上报没存成，不等到超时', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const saver = createAppSaver(TIMEOUT_MS);
  saver.connect(() => {
    throw new Error('端口坏了');
  });
  await assert.rejects(saver.save(bytesOf('x'), 'text/plain', 'a.txt'), { message: '没能把文件交给安卓 App，文件没有保存。请再试一次。' });
});

test('等不到回话时到点报错，之后来的回话不再算', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { saver, connect } = setup();
  connect();
  const save = saver.save(bytesOf('x'), 'text/plain', 'a.txt');
  mock.timers.tick(TIMEOUT_MS);
  await assert.rejects(save, { message: '安卓 App 没有回话，文件可能没有保存。请到手机“下载”里看一看，没有就再试一次。' });
  assert.equal(saver.receive(result(1, true)), true);
});

test('别的消息、多了字段的回话不认', () => {
  const { saver } = setup();
  assert.equal(saver.receive({ type: 'back-result', id: 1, result: 'home' }), false);
  assert.equal(saver.receive({ ...result(1, true), extra: 1 }), false);
});
