// 读出来（前端）：PCM 转浮点、奇数字节拼接、无缝排程、按钮的几种样子、用不了时的说明。不起浏览器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FIRST_LEAD_SECONDS,
  PcmDecoder,
  PcmPlayer,
  RESUME_LEAD_SECONDS,
  scheduleAt,
  type PlaybackContext,
  type PlaybackSource,
} from '../src/assistant/read-aloud-audio.js';
import { ReadAloudButton } from '../src/assistant/ReadAloudButton.js';
import { readAloudUnavailable } from '../src/assistant/useReadAloud.js';
import { speechUnavailable } from '../src/assistant/useAssistantSpeech.js';

const le16 = (...values: number[]) => {
  const bytes = new Uint8Array(values.length * 2);
  values.forEach((v, i) => new DataView(bytes.buffer).setInt16(i * 2, v, true));
  return bytes;
};

test('PCM 转浮点：16 位小端有符号，奇数字节留到下一块拼上', () => {
  const d = new PcmDecoder();
  assert.deepEqual([...d.push(le16(0, 16384, -16384, -32768, 32767))], [0, 0.5, -0.5, -1, 32767 / 32768]);
  const whole = le16(1000, -2000, 3000);
  const parts = [whole.subarray(0, 1), whole.subarray(1, 4), whole.subarray(4, 4), whole.subarray(4, 5), whole.subarray(5)];
  const out = parts.flatMap((p) => [...d.push(p)]);
  assert.deepEqual(out, [1000 / 32768, -2000 / 32768, 3000 / 32768]);
  assert.equal(d.push(new Uint8Array()).length, 0);
});

test('排程：第一段晚 0.1 秒开始，后面紧接着放；网络慢断档后从现在稍后接上', () => {
  assert.equal(scheduleAt(0, 5, true), 5 + FIRST_LEAD_SECONDS);
  assert.equal(scheduleAt(5.3, 5.1, false), 5.3);
  assert.equal(scheduleAt(5.3, 6, false), 6 + RESUME_LEAD_SECONDS);
});

/** 假 AudioContext：记下每段什么时候开始放、多长 */
function fakeContext() {
  const started: { at: number; length: number; source: PlaybackSource }[] = [];
  const context = {
    currentTime: 2,
    destination: { channelCount: 1 },
    createBuffer: (_c: number, length: number) => {
      const data = new Float32Array(length);
      return { length, getChannelData: () => data };
    },
    createBufferSource: () => {
      const source: PlaybackSource = {
        buffer: null,
        onended: null,
        connect: () => undefined,
        start(at: number) {
          assert.ok(source.buffer);
          started.push({ at, length: source.buffer.length, source });
        },
      };
      return source;
    },
  } satisfies PlaybackContext;
  return { context, started };
}

test('播放：攒够一小段再排，前后无缝；收完排掉剩下的，等最后一段放完', async () => {
  const { context, started } = fakeContext();
  const player = new PcmPlayer(context, 24000, 2400);
  player.push(new Float32Array(1000));
  assert.equal(started.length, 0);
  assert.equal(player.playing, false);
  player.push(new Float32Array(1400));
  assert.equal(started.length, 1);
  assert.equal(player.playing, true);
  assert.equal(started[0].at, 2 + FIRST_LEAD_SECONDS);
  assert.equal(started[0].length, 2400);
  player.push(new Float32Array(2400));
  assert.ok(Math.abs(started[1].at - (2.1 + 0.1)) < 1e-9);
  player.push(new Float32Array(10));
  let done = false;
  const finished = player.finish().then(() => (done = true));
  assert.equal(started.length, 3);
  assert.equal(started[2].length, 10);
  await Promise.resolve();
  assert.equal(done, false);
  const ended = started[2].source.onended;
  assert.ok(ended, '最后一段要挂上 onended，finish() 靠它结束');
  ended(new Event('ended'));
  await finished;
  // 没有数据时直接结束
  await new PcmPlayer(fakeContext().context, 24000).finish();
});

test('播放：网络慢、上一段已经放完时，下一段从现在稍后开始', () => {
  const { context, started } = fakeContext();
  const player = new PcmPlayer(context, 24000, 10);
  player.push(new Float32Array(24));
  context.currentTime = 10;
  player.push(new Float32Array(24));
  assert.equal(started[1].at, 10 + RESUME_LEAD_SECONDS);
});

test('读出来按钮：平时是喇叭；读这条时是停止、准备中转圈；读别的消息时这条不受影响', () => {
  const reader = (over: object = {}) => ({ messageId: null, phase: 'idle' as const, error: null, unavailable: '', toggle() {}, ...over });
  const render = (r: object, messageId = 'm1') =>
    renderToStaticMarkup(createElement(ReadAloudButton, { reader: reader(r), threadId: 't', messageId }));
  const idle = render({});
  assert.match(idle, /aria-label="读出来"/);
  assert.match(idle, /aria-pressed="false"/);
  assert.doesNotMatch(idle, /aria-disabled/);
  const loading = render({ messageId: 'm1', phase: 'loading' });
  assert.match(loading, /aria-label="停止朗读"/);
  assert.match(loading, /class="[^"]*spin/);
  assert.match(loading, /正在准备朗读/);
  assert.match(render({ messageId: 'm1', phase: 'playing' }), /aria-pressed="true"/);
  assert.match(render({ messageId: 'm2', phase: 'playing' }), /aria-label="读出来"/);
  const failed = render({ error: { messageId: 'm1', message: 'DeepSeek 账户余额不足，请到 DeepSeek 开放平台充值后重试。' } });
  assert.match(failed, /role="alert"[^>]*>DeepSeek 账户余额不足/);
  assert.doesNotMatch(render({ error: { messageId: 'm2', message: '别的消息出错' } }), /别的消息出错/);
});

test('没填密钥：朗读和语音输入都说清原因（中文，不带英文字段名），按钮仍在但标成不可用', () => {
  assert.equal(readAloudUnavailable({ ready: true, message: '可以使用。' }), '');
  assert.equal(readAloudUnavailable(null), '');
  assert.equal(speechUnavailable(undefined), '');
  const reason = readAloudUnavailable({ ready: false, message: '还没填写 DeepSeek 密钥。请管理员到 设置 → API 配置 填写。' });
  assert.equal(reason, '朗读用不了：还没填写 DeepSeek 密钥。请管理员到 设置 → API 配置 填写。');
  assert.match(speechUnavailable({ ready: false }), /^语音输入用不了：还没填写 DeepSeek 密钥/);
  for (const text of [reason, speechUnavailable({ ready: false })])
    assert.doesNotMatch(text.replace(/DeepSeek|API/g, ''), /[A-Za-z_]{3,}/);
  const html = renderToStaticMarkup(
    createElement(ReadAloudButton, {
      reader: { messageId: null, phase: 'idle', error: null, unavailable: reason, toggle() {} },
      threadId: 't',
      messageId: 'm1',
    }),
  );
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /title="朗读用不了：还没填写 DeepSeek 密钥/);
});
