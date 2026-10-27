import { SPEECH_MAX_SECONDS, SPEECH_SAMPLE_RATE } from '../../shared/speech';
export type CaptureEnvironment = {
  getUserMedia: () => Promise<MediaStream>;
  createContext: () => AudioContext;
};
const browserEnvironment: CaptureEnvironment = {
  getUserMedia: () =>
    navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    }),
  createContext: () => {
    const Context =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    try {
      return new Context({ sampleRate: SPEECH_SAMPLE_RATE });
    } catch (e) {
      if ((e as DOMException).name !== 'NotSupportedError') throw e;
      return new Context();
    }
  },
};
/** One recording owns all audio resources, including those arriving after cancellation. */
export class MicrophoneCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
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
    private environment: CaptureEnvironment = browserEnvironment,
  ) {}
  async start(): Promise<boolean> {
    try {
      const stream = await this.environment.getUserMedia();
      this.stream = stream;
      if (this.cancelled) {
        this.release();
        return false;
      }
      const context = this.environment.createContext();
      this.context = context;
      this.source = context.createMediaStreamSource(stream);
      this.processor = context.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = (event) => {
        if (!this.running || this.cancelled) return;
        const input = event.inputBuffer.getChannelData(0),
          remaining = Math.max(
            0,
            Math.floor(context.sampleRate * SPEECH_MAX_SECONDS) - this.sampleCount,
          );
        if (remaining > 0) {
          const chunk = new Float32Array(input.subarray(0, remaining));
          this.chunks.push(chunk);
          this.sampleCount += chunk.length;
        }
        if (this.sampleCount >= context.sampleRate * SPEECH_MAX_SECONDS && !this.limitNotified) {
          this.limitNotified = true;
          queueMicrotask(() => {
            if (this.running && !this.cancelled) this.onLimit();
          });
        }
      };
      this.source.connect(this.processor);
      this.processor.connect(context.destination);
      if (context.state === 'suspended') await context.resume();
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
  finish() {
    const chunks = this.chunks,
      sampleRate = this.context?.sampleRate || SPEECH_SAMPLE_RATE;
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
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch {}
      this.processor = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {}
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => {
        t.removeEventListener('ended', this.ended);
        t.stop();
      });
      this.stream = null;
    }
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }
}
