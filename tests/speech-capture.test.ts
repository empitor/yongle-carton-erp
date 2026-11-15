// 录音（src/assistant/capture.ts）和它在浏览器里的音频环境（capture-graph.ts，AudioWorklet）：
// 用替身的麦克风、音频环境和录音节点走开始、收样本、到上限、停止、出错、取消和释放，不靠真实时间。
// 音频线程里的处理器（capture-worklet.js）和真实浏览器里的录音在 scripts/ui-check/flow-speech.mjs 看。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MicrophoneCapture, type CaptureEnvironment } from '../src/assistant/capture.js';
import { openCaptureGraph } from '../src/assistant/capture-graph.js';
import { mergeAudioChunks, resampleAudio, encodePcm16LE } from '../src/assistant/audio.js';
import { pcmToWav } from '../server/speech/wav.js';

type Failure = 'module' | 'source' | 'connect' | 'resume';
type Stats = {
  stopped: number;
  closed: number;
  sourceDisconnected: number;
  nodeDisconnected: number;
  portClosed: number;
  resumed: number;
  created: number;
  sources: number;
  modules: string[];
};
type FakeTrack = {
  stop(): void;
  addEventListener(type: 'ended', fn: () => void): void;
  removeEventListener(type: 'ended', fn: () => void): void;
};
type FakeStream = { getTracks(): FakeTrack[] };
type Destination = { speakers: true };
type FakePort = { onmessage: ((event: MessageEvent<unknown>) => void) | null; close(): void };
type FakeNode = { port: FakePort; connect(destination: Destination): void; disconnect(): void };

/** 替身的麦克风和音频环境；failure 指定建音频环境时哪一步出错，module 给了就等它加载处理器模块 */
function device(options: { failure?: Failure; pending?: Promise<FakeStream>; module?: Promise<void>; rate?: number } = {}) {
  const stats: Stats = { stopped: 0, closed: 0, sourceDisconnected: 0, nodeDisconnected: 0, portClosed: 0, resumed: 0, created: 0, sources: 0, modules: [] };
  const ended = new Set<() => void>();
  const track: FakeTrack = {
    stop: () => void stats.stopped++,
    addEventListener: (_type, fn) => void ended.add(fn),
    removeEventListener: (_type, fn) => void ended.delete(fn),
  };
  const stream: FakeStream = { getTracks: () => [track] };
  const port: FakePort = { onmessage: null, close: () => void stats.portClosed++ };
  const node: FakeNode = {
    port,
    connect() {
      if (options.failure === 'connect') throw Error('connect');
    },
    disconnect: () => void stats.nodeDisconnected++,
  };
  const source = { connect: (_node: FakeNode) => undefined, disconnect: () => void stats.sourceDisconnected++ };
  const context = {
    sampleRate: options.rate || 16000,
    state: options.failure === 'resume' ? 'suspended' : 'running',
    destination: { speakers: true } satisfies Destination,
    audioWorklet: {
      addModule: (url: URL) => {
        stats.modules.push(fileURLToPath(url));
        if (options.failure === 'module') return Promise.reject(Error('module'));
        return options.module ?? Promise.resolve();
      },
    },
    createMediaStreamSource(_stream: FakeStream) {
      if (options.failure === 'source') throw Error('source');
      stats.sources++;
      return source;
    },
    resume: () => {
      stats.resumed++;
      return Promise.reject(Error('resume'));
    },
    close() {
      stats.closed++;
      this.state = 'closed';
      return Promise.resolve();
    },
  };
  const environment: CaptureEnvironment<FakeStream> = {
    getUserMedia: () => options.pending ?? Promise.resolve(stream),
    openGraph: (s) => {
      stats.created++;
      return openCaptureGraph<FakeStream, Destination, FakeNode, typeof context>(s, context, () => node);
    },
  };
  return {
    stats,
    ended,
    stream,
    port,
    environment,
    /** 音频线程交来一小块样本 */
    emit: (data: unknown) => port.onmessage?.(new MessageEvent('message', { data })),
  };
}
const noop = () => {};

test('音频合并/线性重采样保持原算法，PCM明确小端且端点与无效采样安全', () => {
  assert.deepEqual(
    [...mergeAudioChunks([new Float32Array([1, 2]), new Float32Array([3])])],
    [1, 2, 3],
  );
  assert.deepEqual([...resampleAudio(new Float32Array([0, 1, 0, -1]), 32000, 16000)], [0, 0]);
  const same = new Float32Array([0.25, -0.5]);
  assert.equal(resampleAudio(same, 16000, 16000), same);
  assert.equal(resampleAudio(new Float32Array(), 48000, 16000).length, 0);
  const bytes = Buffer.from(encodePcm16LE(new Float32Array([-2, -1, 0, 0.5, 1, 2, NaN])));
  assert.deepEqual(
    Array.from({ length: 7 }, (_, i) => bytes.readInt16LE(i * 2)),
    [-32768, -32768, 0, 16384, 32767, 32767, 0],
  );
  // 服务端原样包进 WAV，样本不变
  assert.deepEqual(pcmToWav(bytes).subarray(44), bytes);
});

test('等待权限时取消，迟到的媒体流立即停止且不创建音频环境', async () => {
  let release: (s: FakeStream) => void = noop;
  const gate = new Promise<FakeStream>((r) => (release = r)),
    d = device({ pending: gate });
  const c = new MicrophoneCapture(noop, noop, d.environment),
    pending = c.start();
  c.cancel();
  release(d.stream);
  assert.equal(await pending, false);
  assert.equal(d.stats.stopped, 1);
  assert.equal(d.stats.created, 0);
});

test('加载处理器模块时取消：模块加载完也不再接麦克风，流和音频环境都释放', async () => {
  let loaded: () => void = noop;
  const d = device({ module: new Promise<void>((r) => (loaded = r)) });
  const c = new MicrophoneCapture(noop, noop, d.environment),
    pending = c.start();
  await Promise.resolve();
  c.cancel();
  loaded();
  assert.equal(await pending, false);
  assert.equal(d.stats.sources, 0, '没接麦克风');
  assert.equal(d.stats.stopped, 1);
  assert.equal(d.stats.closed, 1);
});

test('加载处理器、接麦克风、连节点、恢复音频环境失败：已拿到的流、节点、音频环境全部释放，再取消不重复关', async () => {
  for (const failure of ['module', 'source', 'connect', 'resume'] as const) {
    const d = device({ failure }),
      c = new MicrophoneCapture(noop, noop, d.environment);
    await assert.rejects(c.start(), { message: failure });
    assert.equal(d.stats.stopped, 1, failure);
    assert.equal(d.stats.closed, 1, failure);
    assert.equal(d.port.onmessage, null, failure);
    c.cancel();
    assert.equal(d.stats.closed, 1, failure);
    assert.equal(d.stats.stopped, 1, failure);
  }
});

test('录音节点由音频线程模块 capture-worklet.js 提供：加载的是项目里这个文件', async () => {
  const d = device(),
    c = new MicrophoneCapture(noop, noop, d.environment);
  assert.equal(await c.start(), true);
  assert.equal(d.stats.modules.length, 1);
  const [module] = d.stats.modules;
  assert.ok(module?.endsWith('capture-worklet.js'));
  assert.ok(existsSync(module));
  c.cancel();
});

test('收样本：一小块一小块攒起来，停止时按实际采样率交出全部；不是样本的消息不收', async () => {
  const d = device({ rate: 48000 }),
    c = new MicrophoneCapture(noop, noop, d.environment);
  await c.start();
  for (let i = 0; i < 3; i++) d.emit(new Float32Array(128).fill(i));
  d.emit('不是样本');
  d.emit([1, 2, 3]);
  const r = c.finish();
  assert.equal(r.sampleRate, 48000);
  const all = mergeAudioChunks(r.chunks);
  assert.equal(all.length, 384, '停止前收到的最后一块也在');
  assert.deepEqual([all[0], all[128], all[383]], [0, 1, 2]);
});

test('录音以实际采样数限制60秒，结束立即清理回调/节点/音轨；新录音可再次开始', async () => {
  for (let i = 0; i < 3; i++) {
    const d = device({ rate: 10 });
    let limits = 0;
    const c = new MicrophoneCapture(() => limits++, noop, d.environment);
    await c.start();
    d.emit(new Float32Array(1000));
    d.emit(new Float32Array(1000));
    await Promise.resolve();
    assert.equal(limits, 1);
    const r = c.finish();
    assert.equal(r.sampleRate, 10);
    assert.equal(mergeAudioChunks(r.chunks).length, 600);
    assert.equal(d.stats.stopped, 1);
    assert.equal(d.stats.closed, 1);
    assert.equal(d.stats.sourceDisconnected, 1);
    assert.equal(d.stats.nodeDisconnected, 1);
    assert.equal(d.stats.portClosed, 1);
    assert.equal(d.port.onmessage, null);
    assert.equal(d.ended.size, 0);
    c.cancel();
    assert.equal(d.stats.stopped, 1);
    assert.equal(d.stats.closed, 1);
  }
});

test('拒绝权限可通过新录音重试；设备断开可通知，取消不再接收音频', async () => {
  const d = device(),
    denied: CaptureEnvironment<FakeStream> = {
      ...d.environment,
      getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    };
  await assert.rejects(new MicrophoneCapture(noop, noop, denied).start(), { name: 'NotAllowedError' });
  assert.equal(d.stats.created, 0);
  let disconnected = 0;
  const c = new MicrophoneCapture(noop, () => disconnected++, d.environment);
  await c.start();
  for (const fn of d.ended) fn();
  assert.equal(disconnected, 1);
  c.cancel();
  d.emit(new Float32Array(100));
  assert.equal(c.finish().chunks.length, 0);
  assert.equal(d.stats.stopped, 1);
});
