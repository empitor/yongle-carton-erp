import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { assistantFixture } from './assistant-fixture.js';
import {
  pcmToSamples,
  transcribePcm,
  setSpeechEngineForTests,
  SPEECH_MAX_SAMPLES,
} from '../server/assistant/speech.js';

const pcm = (values: number[]) => {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer;
};

test('本地语音识别：PCM 转换、注入引擎与结果时长', async () => {
  setSpeechEngineForTests({ transcribe: (samples) => '识别到 ' + samples.length + ' 个采样点' });
  try {
    const result = await transcribePcm(pcm([0, 16384, -16384]));
    assert.equal(result.text, '识别到 3 个采样点');
    assert.equal(result.durationMs, 0);
    const samples = pcmToSamples(pcm([16384, -16384]));
    assert.equal(samples.length, 2);
    assert.ok(Math.abs(samples[0] - 0.5) < 0.01);
  } finally {
    setSpeechEngineForTests(null);
  }
});

test('本地语音识别：空音频、奇数长度和超过 60 秒被拒绝', async () => {
  setSpeechEngineForTests({ transcribe: () => '不应执行' });
  try {
    await assert.rejects(() => transcribePcm(Buffer.alloc(0)), /音频数据/);
    await assert.rejects(() => transcribePcm(Buffer.alloc(3)), /格式/);
    await assert.rejects(() => transcribePcm(Buffer.alloc((SPEECH_MAX_SAMPLES + 1) * 2)), /60 秒/);
  } finally {
    setSpeechEngineForTests(null);
  }
});

test('本地语音识别：串行保护与引擎失败提示', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  setSpeechEngineForTests({
    transcribe: async () => {
      await gate;
      return '完成';
    },
  });
  try {
    const first = transcribePcm(pcm([1, 2]));
    await assert.rejects(() => transcribePcm(pcm([3, 4])), /正在处理/);
    release();
    assert.equal((await first).text, '完成');
  } finally {
    setSpeechEngineForTests(null);
  }
  setSpeechEngineForTests({
    transcribe: () => {
      throw new Error('boom');
    },
  });
  try {
    await assert.rejects(() => transcribePcm(pcm([1, 2])), (error: unknown) => {
      assert.match((error as Error).message, /本地语音识别失败/);
      assert(!(error as Error).message.includes('boom'));
      return true;
    });
  } finally {
    setSpeechEngineForTests(null);
  }
  setSpeechEngineForTests({ transcribe: () => '失败后可再次识别' });
  try {
    assert.equal((await transcribePcm(pcm([1, 2]))).text, '失败后可再次识别');
  } finally {
    setSpeechEngineForTests(null);
  }
});

test('语音识别接口要求登录和页面凭证，成功返回文字', async () => {
  const f = assistantFixture(),
    auth = new AuthManager(':memory:'),
    server = createApp(f.store, {
      auth,
      aiSettings: f.settings,
      assistant: f.manager,
    }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    const setup = await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '语音验收', password: 'fictional-speech-password-123' }),
    });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const send = (body: Buffer, csrf = true) =>
      fetch(base + '/api/assistant/transcribe', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/octet-stream',
          ...(csrf ? { 'X-ERP-Auth-Token': auth.csrf } : {}),
        },
        body: new Uint8Array(body) as unknown as BodyInit,
      });
    const audio = pcm(new Array(16000).fill(0));
    setSpeechEngineForTests({ transcribe: () => '第一句话' });
    try {
      assert.equal((await send(audio, false)).status, 403);
      const ok = await send(audio);
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { text: '第一句话', durationMs: 1000 });
      const anonymous = await fetch(base + '/api/assistant/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-ERP-Auth-Token': auth.csrf },
        body: new Uint8Array(audio) as unknown as BodyInit,
      });
      assert.equal(anonymous.status, 401);
      const tooLong = await send(Buffer.alloc((SPEECH_MAX_SAMPLES + 1) * 2));
      assert.equal(tooLong.status, 413);
    } finally {
      setSpeechEngineForTests(null);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    auth.close();
    f.close();
  }
});
test('语音识别等待中退出登录，后端不再返回原账号的识别文字', async () => {
  const f = assistantFixture(),
    auth = new AuthManager(':memory:'),
    server = createApp(f.store, { auth, aiSettings: f.settings, assistant: f.manager }).listen(
      0,
      '127.0.0.1',
    );
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  setSpeechEngineForTests({
    transcribe: async () => {
      entered();
      await gate;
      return '不应返回的旧账号文字';
    },
  });
  try {
    const setup = await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '语音隔离验收', password: 'fictional-speech-isolation-123' }),
    });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const pending = fetch(base + '/api/assistant/transcribe', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/octet-stream',
        'X-ERP-Auth-Token': auth.csrf,
      },
      body: new Uint8Array(pcm([1, 2, 3])),
    });
    await started;
    const logout = await fetch(base + '/api/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-ERP-Auth-Token': auth.csrf,
      },
      body: '{}',
    });
    assert.equal(logout.status, 200);
    release();
    const response = await pending;
    assert.equal(response.status, 403);
    assert(!(await response.text()).includes('不应返回的旧账号文字'));
  } finally {
    release?.();
    setSpeechEngineForTests(null);
    await new Promise<void>((r) => server.close(() => r()));
    auth.close();
    f.close();
  }
});
