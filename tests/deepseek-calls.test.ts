// 每个 DeepSeek 接口的调用都直接拿假传输函数测，不经过设置管理器、不起整个系统
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDeepSeek, fakeKey, httpError } from './fake-deepseek.js';
import { jsonResponse } from './fake-deepseek-wire.js';
import { deleteFile, uploadFile, withUploadedFiles, type UploadInput } from '../server/ai/files.js';
import { speechToText, textToSpeech } from '../server/ai/speech.js';
import { webFetch, webSearch } from '../server/ai/web.js';
import { getBalance } from '../server/ai/balance.js';
import { pcmToWav } from '../server/speech/wav.js';
import { AiConnectionError } from '../server/ai/errors.js';

async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

test('文件：上传 purpose 排在 file 前、带 1 小时过期；用途不对或认不出的不发；删除 404 算删了；包装在成功、失败、job 抛错、上传一半失败时都删干净', async () => {
  const fake = fakeDeepSeek();
  const one = await uploadFile(fake.transport, fakeKey, { name: '虚构订单.xlsx', data: Buffer.from('x'), purpose: 'user_data' });
  const uploaded = fake.files.get(one.id);
  assert.ok(uploaded);
  assert.equal(uploaded.expiresSeconds, 3600);
  const sent = fake.calls.find((c) => c.path === '/files');
  assert.ok(sent);
  assert.ok(sent.fields);
  assert.ok(sent.fields.indexOf('purpose') < sent.fields.indexOf('file'));
  const before = fake.calls.length;
  await assert.rejects(uploadFile(fake.transport, fakeKey, { name: 'a.pdf', data: Buffer.from('x'), purpose: 'user_data' }), /文档要按文档解析/);
  await assert.rejects(uploadFile(fake.transport, fakeKey, { name: 'a.exe', data: Buffer.from('x'), purpose: 'user_data' }), /读不了/);
  assert.equal(fake.calls.length, before, '不对的不发出去');
  await deleteFile(fake.transport, fakeKey, one.id);
  await deleteFile(fake.transport, fakeKey, one.id);
  assert.equal(fake.files.size, 0);
  const api = {
    upload: (input: UploadInput, o: { signal?: AbortSignal; expiresSeconds?: number }) => uploadFile(fake.transport, fakeKey, input, o),
    remove: (id: string) => deleteFile(fake.transport, fakeKey, id),
  };
  const files: UploadInput[] = [
    { name: 'a.pdf', data: Buffer.from('%PDF-a'), purpose: 'text_recognition' },
    { name: 'b.png', data: Buffer.from('png'), purpose: 'user_data' },
  ];
  const progress: number[] = [];
  const ids = await withUploadedFiles(api, files, async (parts) => {
    assert.equal(fake.files.size, 2);
    return parts.map((p) => p.file_id);
  }, { onProgress: (done) => progress.push(done) });
  assert.equal(ids.length, 2);
  assert.deepEqual(progress.sort(), [1, 2]);
  assert.equal(fake.files.size, 0);
  await assert.rejects(withUploadedFiles(api, files, async () => Promise.reject(new Error('虚构失败'))), /虚构失败/);
  assert.equal(fake.files.size, 0, 'job 抛错也删');
  fake.next('/files', httpError(400).response());
  await assert.rejects(
    withUploadedFiles(api, files, async () => 1),
    (e: unknown) => e instanceof AiConnectionError && e.code === 'unreadable',
  );
  assert.equal(fake.files.size, 0);
  let failed = 0;
  const flaky = { ...api, remove: async () => { throw new Error('删不掉'); } };
  await withUploadedFiles(flaky, files.slice(0, 1), async () => 1, { onCleanupFailure: (n) => (failed = n) });
  assert.equal(failed, 1, '删不掉只计数，不抛错');
});

test('语音：WAV 转文字；文字转语音流式拿到 PCM，中途断开报“朗读中途断了”', async () => {
  const fake = fakeDeepSeek({ asrText: '五百只' });
  assert.deepEqual(await speechToText(fake.transport, fakeKey, pcmToWav(Buffer.alloc(8000 * 2))), { text: '五百只', durationMs: 500 });
  await assert.rejects(speechToText(fake.transport, fakeKey, Buffer.alloc(9 * 1024 * 1024)), /最多 8 MB/);
  const audio = await textToSpeech(fake.transport, fakeKey, '虚构', { signal: new AbortController().signal, voice: 'tide' });
  let bytes = 0;
  for await (const chunk of chunks(audio.body)) bytes += chunk.byteLength;
  assert.equal(bytes, 4800);
  const ttsCall = fake.calls.at(-1);
  assert.ok(ttsCall);
  assert.equal(ttsCall.body.voice_id, 'tide');
  fake.next('/v1/tools/tts', () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(10));
        c.error(new TypeError('terminated'));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'audio/pcm' } });
  });
  const broken = await textToSpeech(fake.transport, fakeKey, '虚构', { signal: new AbortController().signal });
  await assert.rejects(async () => {
    for await (const _ of chunks(broken.body));
  }, /朗读中途断了/);
});

test('联网：搜索把原问题一起带上；读网页 403、404 有中文提示，内网地址不发出去', async () => {
  const fake = fakeDeepSeek({ pages: { 'https://example.com/a': { title: 'A', content: '正文' }, 'https://example.com/b': 403 } });
  const results = await webSearch(fake.transport, fakeKey, { query: '瓦楞纸板', count: 10, originalQuestion: '瓦楞纸板是什么' }, async () => {});
  assert.equal(results[0].siteName, '虚构站点');
  const searchCall = fake.calls.at(-1);
  assert.ok(searchCall);
  assert.equal(searchCall.body.ori_question, '瓦楞纸板是什么');
  assert.equal((await webFetch(fake.transport, fakeKey, 'https://example.com/a')).content, '正文');
  await assert.rejects(webFetch(fake.transport, fakeKey, 'https://example.com/b'), /不允许读取/);
  await assert.rejects(webFetch(fake.transport, fakeKey, 'https://example.com/c'), /打不开/);
  const before = fake.calls.length;
  await assert.rejects(webFetch(fake.transport, fakeKey, 'http://192.168.1.1/'), /公网/);
  assert.equal(fake.calls.length, before);
});

test('查余额：可用、不可用、密钥不对', async () => {
  const fake = fakeDeepSeek();
  assert.equal((await getBalance(fake.transport, fakeKey)).available, true);
  fake.next('/user/balance', jsonResponse({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.10' }] }));
  const low = await getBalance(fake.transport, fakeKey);
  assert.deepEqual(low.balances, [{ currency: 'USD', total: '0.10', granted: '0.00', toppedUp: '0.00' }]);
  assert.equal(low.available, false);
  await assert.rejects(
    getBalance(fake.transport, 'sk-wrong'),
    (e: unknown) => e instanceof AiConnectionError && e.code === 'authentication',
  );
});
