// 手工验收：真实本地语音模型 + HTTP 接口端到端（使用内存库与临时账号，不碰正式数据）。
// 用法：npx tsx scripts/speech-e2e.ts <16kHz 单声道 WAV>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { AuthManager } from '../../server/auth.js';
import { createApp } from '../../server/app.js';
import { assistantFixture } from '../../tests/assistant-fixture.js';
import { SPEECH_SAMPLE_RATE } from '../../shared/speech.js';

const require = createRequire(import.meta.url);
const { readWave } = require('sherpa-onnx-node') as {
  readWave: (path: string) => { samples: Float32Array; sampleRate: number };
};
const wavePath = process.argv[2];
if (!wavePath) {
  console.error('用法：npx tsx scripts/speech-e2e.ts <16kHz 单声道 WAV>');
  process.exit(2);
}
const wave = readWave(wavePath);
if (wave.sampleRate !== SPEECH_SAMPLE_RATE)
  throw Error('端到端自检要求16kHz单声道WAV；不能将其他采样率误报为16kHz。');
const pcm = Buffer.alloc(wave.samples.length * 2);
for (let i = 0; i < wave.samples.length; i++) {
  const value = Math.max(-1, Math.min(1, wave.samples[i]));
  pcm.writeInt16LE(value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), i * 2);
}
const fixture = assistantFixture(),
  auth = new AuthManager(':memory:'),
  server = createApp(fixture.store, {
    auth,
    aiSettings: fixture.settings,
    assistant: fixture.manager,
  }).listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
try {
  const setup = await fetch(base + '/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
    body: JSON.stringify({ name: '语音端到端验收', password: 'fictional-speech-e2e-123' }),
  });
  const cookie = setup.headers.get('set-cookie')!.split(';')[0];
  const started = Date.now();
  const response = await fetch(base + '/api/assistant/transcribe', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/octet-stream',
      'X-ERP-Auth-Token': auth.csrf,
    },
    body: new Uint8Array(pcm) as unknown as BodyInit,
  });
  const result = await response.json();
  console.log('status=', response.status);
  console.log('elapsedMs=', Date.now() - started);
  console.log('result=', result);
  if (response.status !== 200 || !String(result.text || '').trim()) process.exitCode = 1;
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  auth.close();
  fixture.close();
}
