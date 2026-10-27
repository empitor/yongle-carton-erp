import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MicrophoneCapture, type CaptureEnvironment } from '../src/speech/capture.js';
import { mergeAudioChunks, resampleAudio, encodePcm16LE } from '../src/speech/audio.js';
import { pcmToSamples } from '../server/speech/service.js';
function device(options: { failure?: string; pending?: Promise<MediaStream>; rate?: number } = {}) {
  const stats = {
    stopped: 0,
    closed: 0,
    sourceDisconnected: 0,
    processorDisconnected: 0,
    resumed: 0,
    created: 0,
  };
  const ended = new Set<() => void>();
  const track = {
    stop() {
      stats.stopped++;
    },
    addEventListener(_event: string, fn: () => void) {
      ended.add(fn);
    },
    removeEventListener(_event: string, fn: () => void) {
      ended.delete(fn);
    },
  };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const processor = {
    onaudioprocess: null as ((e: AudioProcessingEvent) => void) | null,
    connect() {
      if (options.failure === 'connect') throw Error('connect');
    },
    disconnect() {
      stats.processorDisconnected++;
    },
  };
  const source = {
    connect() {},
    disconnect() {
      stats.sourceDisconnected++;
    },
  };
  const context = {
    sampleRate: options.rate || 16000,
    state: options.failure === 'resume' ? 'suspended' : 'running',
    createMediaStreamSource() {
      if (options.failure === 'source') throw Error('source');
      return source;
    },
    createScriptProcessor() {
      return processor;
    },
    destination: {},
    async close() {
      stats.closed++;
      this.state = 'closed';
    },
    async resume() {
      stats.resumed++;
      throw Error('resume');
    },
  };
  const environment: CaptureEnvironment = {
    getUserMedia: () => options.pending || Promise.resolve(stream),
    createContext: () => {
      stats.created++;
      return context as unknown as AudioContext;
    },
  };
  return {
    stats,
    ended,
    track,
    stream,
    processor,
    environment,
    emit: (samples: Float32Array) =>
      processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => samples },
      } as unknown as AudioProcessingEvent),
  };
}
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
    [...Array(7)].map((_, i) => bytes.readInt16LE(i * 2)),
    [-32768, -32768, 0, 16384, 32767, 32767, 0],
  );
  assert.equal(pcmToSamples(bytes).length, 7);
});
test('等待权限时取消，迟到的媒体流立即停止且不创建AudioContext', async () => {
  let release!: (s: MediaStream) => void;
  const gate = new Promise<MediaStream>((r) => (release = r)),
    d = device({ pending: gate });
  const c = new MicrophoneCapture(
      () => {},
      () => {},
      d.environment,
    ),
    pending = c.start();
  c.cancel();
  release(d.stream);
  assert.equal(await pending, false);
  assert.equal(d.stats.stopped, 1);
  assert.equal(d.stats.created, 0);
});
test('创建音频节点/连接/恢复失败，已获得的流与上下文全部释放', async () => {
  for (const failure of ['source', 'connect', 'resume']) {
    const d = device({ failure }),
      c = new MicrophoneCapture(
        () => {},
        () => {},
        d.environment,
      );
    await assert.rejects(c.start());
    assert.equal(d.stats.stopped, 1);
    assert.equal(d.stats.closed, 1);
    assert.equal(d.processor.onaudioprocess, null);
    c.cancel();
    assert.equal(d.stats.closed, 1);
  }
});
test('录音以实际采样数限制60秒，结束立即清理回调/节点/音轨；新录音可再次开始', async () => {
  for (let i = 0; i < 3; i++) {
    const d = device({ rate: 10 });
    let limits = 0;
    const c = new MicrophoneCapture(
      () => limits++,
      () => {},
      d.environment,
    );
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
    assert.equal(d.stats.processorDisconnected, 1);
    assert.equal(d.processor.onaudioprocess, null);
    assert.equal(d.ended.size, 0);
    c.cancel();
    assert.equal(d.stats.stopped, 1);
  }
});
test('拒绝权限可通过新录音重试；设备断开可通知，取消不再接收音频', async () => {
  const d = device(),
    denied: CaptureEnvironment = {
      ...d.environment,
      getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    };
  await assert.rejects(
    new MicrophoneCapture(
      () => {},
      () => {},
      denied,
    ).start(),
    { name: 'NotAllowedError' },
  );
  assert.equal(d.stats.created, 0);
  let disconnected = 0;
  const c = new MicrophoneCapture(
    () => {},
    () => disconnected++,
    d.environment,
  );
  await c.start();
  for (const fn of d.ended) fn();
  assert.equal(disconnected, 1);
  c.cancel();
  d.emit(new Float32Array(100));
  assert.equal(c.finish().chunks.length, 0);
  assert.equal(d.stats.stopped, 1);
});
