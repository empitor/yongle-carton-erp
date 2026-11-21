import { SPEECH_MAX_SECONDS, SPEECH_SAMPLE_RATE } from '../../shared/assistant/index';

/*
 * 一次录音：要麦克风、接上音频环境收样本、数到上限通知停、交出录到的样本、取消和释放。
 * 浏览器里怎么建音频环境（AudioWorklet）在 capture-graph.ts，这里只管录音本身，替身环境下能单独测。
 */

/** 录音用到的音轨：停掉、听“断开”（拔了麦克风） */
export type CaptureTrack = {
  stop(): void;
  addEventListener(type: 'ended', listener: () => void): void;
  removeEventListener(type: 'ended', listener: () => void): void;
};
export type CaptureStream = { getTracks(): CaptureTrack[] };
/** 一次录音的音频环境：麦克风接到录音节点，样本一小块一小块交给 onSamples */
export type CaptureGraph = {
  readonly sampleRate: number;
  /** 接好节点、开始送样本（音频环境暂停着就恢复）；半路出错由调用方 close */
  start(onSamples: (samples: Float32Array) => void): Promise<void>;
  /** 断开节点、关掉音频环境；没接好的、关过的不用管 */
  close(): void;
};
export type CaptureEnvironment<S extends CaptureStream> = {
  getUserMedia(): Promise<S>;
  openGraph(stream: S): CaptureGraph;
};

/** One recording owns all audio resources, including those arriving after cancellation. */
export class MicrophoneCapture<S extends CaptureStream> {
  private stream: S | null = null;
  private graph: CaptureGraph | null = null;
  private chunks: Float32Array[] = [];
  private sampleCount = 0;
  private cancelled = false;
  private running = false;
  private limitNotified = false;
  private ended = () => {
    if (this.running && !this.cancelled) this.onEnded();
  };
  constructor(
    private onLimit: () => void,
    private onEnded: () => void,
    private environment: CaptureEnvironment<S>,
  ) {}
  async start(): Promise<boolean> {
    try {
      const stream = await this.environment.getUserMedia();
      this.stream = stream;
      if (this.cancelled) {
        this.release();
        return false;
      }
      const graph = this.environment.openGraph(stream);
      this.graph = graph;
      await graph.start((samples) => this.receive(samples, graph.sampleRate));
      if (this.cancelled) {
        this.release();
        return false;
      }
      this.running = true;
      stream.getTracks().forEach((t) => t.addEventListener('ended', this.ended));
      return true;
    } catch (e) {
      this.cancel();
      throw e;
    }
  }
  /** 收一小块样本：按实际采样数数到上限（SPEECH_MAX_SECONDS），到了只通知一次 */
  private receive(input: Float32Array, sampleRate: number) {
    if (!this.running || this.cancelled) return;
    const limit = Math.floor(sampleRate * SPEECH_MAX_SECONDS),
      remaining = Math.max(0, limit - this.sampleCount);
    if (remaining > 0) {
      const chunk = new Float32Array(input.subarray(0, remaining));
      this.chunks.push(chunk);
      this.sampleCount += chunk.length;
    }
    if (this.sampleCount >= sampleRate * SPEECH_MAX_SECONDS && !this.limitNotified) {
      this.limitNotified = true;
      queueMicrotask(() => {
        if (this.running && !this.cancelled) this.onLimit();
      });
    }
  }
  finish() {
    const chunks = this.chunks,
      sampleRate = this.graph?.sampleRate || SPEECH_SAMPLE_RATE;
    this.chunks = [];
    this.cancelled = true;
    this.release();
    return { chunks, sampleRate };
  }
  cancel() {
    this.cancelled = true;
    this.chunks = [];
    this.release();
  }
  private release() {
    this.running = false;
    const graph = this.graph;
    this.graph = null;
    graph?.close();
    if (this.stream) {
      this.stream.getTracks().forEach((t) => {
        t.removeEventListener('ended', this.ended);
        t.stop();
      });
      this.stream = null;
    }
  }
}
