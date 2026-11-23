// 机器人下载文件（server/inbox/bots/media.ts）：正文超过上限当场取消，回答的结尾随后才到时，
// 不再往已经关掉的流里写，不留没人接的异常。不连网：https.request 换成本地假连接。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadMedia, FileTooLarge } from '../../server/inbox/bots/media.js';
import { fakeHttpsRequest } from './https-request-fake.js';

/** 让排在后面的 I/O 回调（假连接晚一拍推进来的结尾）都跑完 */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

test('下载超限取消以后，回答结尾晚到：只报文件过大，不再冒出“流已关闭”的异常', async () => {
  const stray: unknown[] = [];
  const keep = (error: unknown) => stray.push(error);
  process.on('uncaughtException', keep);
  try {
    const fake = fakeHttpsRequest([{ body: Buffer.from('12345'), lateEnd: true }]);
    await assert.rejects(
      downloadMedia('https://media.example.invalid/f', { checkHost: async () => '203.0.114.1', requestImpl: fake.request }, { limit: 4 }),
      FileTooLarge,
    );
    await settle();
    assert.deepEqual(stray.map(String), []);
  } finally {
    process.off('uncaughtException', keep);
  }
});
