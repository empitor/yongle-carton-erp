// 语音：录音包成 WAV 交给 DeepSeek 识别、按消息编号朗读。全部用假 DeepSeek，不发真实请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { AppError } from '../server/core/index.js';
import { AiConnectionError } from '../server/ai/index.js';
import { checkPcm, pcmToWav } from '../server/assistant/speech/wav.js';
import { transcribePcm } from '../server/assistant/speech/service.js';
import { SPEECH_MAX_SAMPLES } from '../shared/assistant/speech.js';
import { jsonResponse } from './fake-deepseek-wire.js';
import { halfSecond, pcm, speechServer } from './speech-fixture.js';
import { readAs } from './read-result.js';

const speechError = (status: number, pattern: RegExp) => (e: unknown) =>
  e instanceof AppError && e.status === status && pattern.test(e.message);
const messageOf = async (response: Response) => readAs(await response.json(), { message: z.string() }).message;

test('WAV 头：44 字节，PCM、单声道、16 位、16 kHz，长度字段和数据对得上', () => {
  const data = pcm([1, -1, 32767]),
    wav = pcmToWav(data);
  assert.equal(wav.length, 44 + data.length);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + data.length);
  assert.equal(wav.subarray(8, 16).toString(), 'WAVEfmt ');
  assert.deepEqual([wav.readUInt32LE(16), wav.readUInt16LE(20), wav.readUInt16LE(22)], [16, 1, 1]);
  assert.deepEqual([wav.readUInt32LE(24), wav.readUInt32LE(28), wav.readUInt16LE(32), wav.readUInt16LE(34)], [16000, 32000, 2, 16]);
  assert.equal(wav.subarray(36, 40).toString(), 'data');
  assert.equal(wav.readUInt32LE(40), data.length);
  assert.deepEqual(wav.subarray(44), data);
  assert.equal(pcmToWav(data, 48000).readUInt32LE(28), 96000);
});

test('录音核对：空的、奇数字节、不到 0.3 秒、超过 60 秒都拒收，说中文', () => {
  assert.throws(() => checkPcm(Buffer.alloc(0)), /没有收到录音/);
  assert.throws(() => checkPcm(Buffer.alloc(9601)), /格式不对/);
  assert.throws(() => checkPcm(pcm([1, 2, 3])), /录音太短/);
  assert.throws(() => checkPcm(Buffer.alloc((SPEECH_MAX_SAMPLES + 1) * 2)), speechError(413, /60 秒/));
  assert.equal(checkPcm(halfSecond()), 8000);
  assert.equal(checkPcm(Buffer.alloc(SPEECH_MAX_SAMPLES * 2)), SPEECH_MAX_SAMPLES);
});

test('识别：交给 DeepSeek 的是 WAV，时长按采样点算，空结果和上游报错都说清楚、不透传原文', async () => {
  const sent: Buffer[] = [];
  const ok = { speechToText: async (wav: Buffer) => {
    sent.push(wav);
    return { text: '  你好  ', durationMs: 1 };
  } };
  assert.deepEqual(await transcribePcm(ok, halfSecond(), 'a'), { text: '你好', durationMs: 500 });
  const got = sent.at(-1);
  assert.ok(got);
  assert.equal(got.subarray(0, 4).toString(), 'RIFF');
  assert.equal(got.length, 44 + 16000);
  const empty = { speechToText: async () => ({ text: ' ', durationMs: 0 }) };
  await assert.rejects(transcribePcm(empty, halfSecond(), 'a'), speechError(422, /没有识别到文字/));
  const quota = { speechToText: async () => Promise.reject(new AiConnectionError('quota', 'DeepSeek 账户余额不足，请到 DeepSeek 开放平台充值后重试。', 422)) };
  await assert.rejects(transcribePcm(quota, halfSecond(), 'a'), (e) => e instanceof AppError && e.code === 'quota' && /余额不足/.test(e.message));
  const boom = { speechToText: async () => Promise.reject(new Error('secret upstream text')) };
  await assert.rejects(transcribePcm(boom, halfSecond(), 'a'), (e) => e instanceof AppError && !e.message.includes('secret') && /语音识别失败/.test(e.message));
  // 录音不对时不发给 DeepSeek
  let called = false;
  await assert.rejects(transcribePcm({ speechToText: async () => ((called = true), { text: 'x', durationMs: 0 }) }, Buffer.alloc(3), 'a'));
  assert.equal(called, false);
});

test('识别：每个账号同时只识别一段，别的账号不受影响，失败后能再识别', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = { speechToText: async () => (await gate, { text: '完成', durationMs: 0 }) };
  const first = transcribePcm(slow, halfSecond(), '甲');
  await assert.rejects(transcribePcm(slow, halfSecond(), '甲'), speechError(429, /还在识别/));
  const other = transcribePcm({ speechToText: async () => ({ text: '乙的话', durationMs: 0 }) }, halfSecond(), '乙');
  assert.equal((await other).text, '乙的话');
  release();
  assert.equal((await first).text, '完成');
  await assert.rejects(transcribePcm({ speechToText: async () => Promise.reject(new Error('x')) }, halfSecond(), '甲'));
  assert.equal((await transcribePcm({ speechToText: async () => ({ text: '又能用了', durationMs: 0 }) }, halfSecond(), '甲')).text, '又能用了');
});

test('识别接口：要登录和页面凭证，录音包成 WAV 发给假 DeepSeek，太长的拒收', async () => {
  const s = await speechServer();
  try {
    const audio = Buffer.alloc(16000 * 2);
    assert.equal((await s.send('/transcribe', audio, { csrf: false })).status, 403);
    const ok = await s.send('/transcribe', audio);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { text: '第一句话', durationMs: 1000 });
    const asr = s.fake.calls.filter((c) => c.path === '/v1/tools/asr');
    assert.equal(asr.length, 1);
    assert.equal(asr[0].body.file?.bytes.length, 44 + audio.length);
    assert.equal(asr[0].headers.get('authorization'), 'Bearer ' + s.fake.key);
    const anonymous = await fetch(s.base + '/api/assistant/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-ERP-Auth-Token': s.auth.csrf },
      body: new Uint8Array(audio),
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await s.send('/transcribe', Buffer.alloc((SPEECH_MAX_SAMPLES + 1) * 2))).status, 413);
    assert.equal(s.fake.calls.filter((c) => c.path === '/v1/tools/asr').length, 1);
  } finally {
    await s.close();
  }
});

test('没有离线兜底：没填密钥时识别、朗读都回 503 并说清原因；余额不足、网络不通按 DeepSeek 的情况说', async () => {
  const none = await speechServer({ key: false });
  try {
    const state = await fetch(none.base + '/api/assistant', { headers: { Cookie: none.cookie } });
    assert.equal(readAs(await state.json(), { speechAvailable: z.boolean() }).speechAvailable, false);
    for (const [path, body, prefix] of [
      ['/transcribe', halfSecond(), '语音输入用不了'],
      ['/speak', { threadId: 'x', messageId: 'y' }, '朗读用不了'],
    ] as const) {
      const r = await none.send(path, body);
      const message = await messageOf(r);
      assert.equal(r.status, 503);
      assert.match(message, new RegExp(prefix + '：还没填写 DeepSeek 密钥'));
      assert.doesNotMatch(message, /key_required|speech|undefined/);
    }
    assert.equal(none.fake.calls.length, 0);
  } finally {
    await none.close();
  }
  const s = await speechServer();
  try {
    s.fake.next('/v1/tools/asr', jsonResponse({ error: { message: 'Insufficient Balance' } }, 402));
    const poor = await s.send('/transcribe', halfSecond());
    assert.equal(poor.status, 422);
    assert.match(await messageOf(poor), /余额不足/);
    s.fake.next('/v1/tools/asr', () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    });
    const offline = await s.send('/transcribe', halfSecond());
    assert.equal(offline.status, 502);
    const message = await messageOf(offline);
    assert.match(message, /连不上 DeepSeek/);
    assert.doesNotMatch(message, /fetch failed|ENOTFOUND/);
  } finally {
    await s.close();
  }
});

test('识别等待中退出登录，不返回原账号的文字', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  const s = await speechServer({
    asrText: '不应返回的旧账号文字',
    wrap: (inner) => async (req) => {
      if (new URL(req.url).pathname === '/v1/tools/asr') {
        entered();
        await gate;
      }
      return inner(req);
    },
  });
  try {
    const pending = s.send('/transcribe', halfSecond());
    await started;
    const logout = await fetch(s.base + '/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: s.cookie, 'Content-Type': 'application/json', 'X-ERP-Auth-Token': s.auth.csrf },
      body: '{}',
    });
    assert.equal(logout.status, 200);
    release();
    const response = await pending;
    assert.equal(response.status, 403);
    assert(!(await response.text()).includes('不应返回的旧账号文字'));
  } finally {
    release();
    await s.close();
  }
});

test('识别：浏览器断开就取消发给 DeepSeek 的请求', async () => {
  let entered!: () => void, cancelled!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    upstreamCancelled = new Promise<void>((r) => (cancelled = r));
  const s = await speechServer({
    wrap: (inner) => async (req) => {
      if (new URL(req.url).pathname === '/v1/tools/asr') {
        entered();
        await new Promise<void>((r) => req.signal.addEventListener('abort', () => (cancelled(), r())));
      }
      return inner(req);
    },
  });
  try {
    const browser = new AbortController();
    const pending = s.send('/transcribe', halfSecond(), { signal: browser.signal }).catch(() => null);
    await started;
    browser.abort();
    await pending;
    await upstreamCancelled;
  } finally {
    await s.close();
  }
});
