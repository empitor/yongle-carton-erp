/**
 * 朗读的播放：服务端流回来的是 24 kHz、16 位小端、单声道的裸 PCM，
 * 一块块转成浮点、攒够一小段就排进 AudioContext，前后无缝接着放。
 * 只管声音怎么排，不发请求、不管界面；AudioContext 从外面传进来，测试用假的。
 */

/** 播放器用到的 AudioBuffer、AudioBufferSourceNode、目的地那几样：真的 AudioContext 照样能传，测试用假的 */
type PlaybackBuffer = { readonly length: number; getChannelData(channel: number): Float32Array };
type PlaybackDestination = Pick<AudioNode, 'channelCount'>;
export type PlaybackSource = {
  buffer: PlaybackBuffer | null;
  onended: ((ev: Event) => unknown) | null;
  connect(destination: PlaybackDestination): unknown;
  start(when: number): void;
};
/** 用到的 AudioContext 那几样 */
export type PlaybackContext = {
  readonly currentTime: number;
  readonly destination: PlaybackDestination;
  createBuffer(channels: number, length: number, sampleRate: number): PlaybackBuffer;
  createBufferSource(): PlaybackSource;
};

/** 第一段晚 0.1 秒开始，给后面的数据留点余量；中途断档后接上时留 0.02 秒，免得爆音 */
export const FIRST_LEAD_SECONDS = 0.1;
export const RESUME_LEAD_SECONDS = 0.02;

/** 这一段什么时候开始放：接着上一段放；上一段已经放完（网络慢断档了）就从现在稍后开始。 */
export function scheduleAt(next: number, now: number, first: boolean): number {
  return Math.max(next, now + (first ? FIRST_LEAD_SECONDS : RESUME_LEAD_SECONDS));
}

/** 16 位小端 PCM 转成 -1 到 1 的浮点；一块的字节数是奇数时，多出来的那个字节留给下一块拼上。 */
export class PcmDecoder {
  private carry: number | null = null;
  push(bytes: Uint8Array): Float32Array {
    const total = bytes.length + (this.carry === null ? 0 : 1);
    const out = new Float32Array(total >> 1);
    let i = 0,
      k = 0;
    if (this.carry !== null && bytes.length) {
      out[k++] = toFloat(this.carry | (bytes[0] << 8));
      i = 1;
    }
    for (; i + 1 < bytes.length; i += 2) out[k++] = toFloat(bytes[i] | (bytes[i + 1] << 8));
    this.carry = total % 2 ? (i < bytes.length ? bytes[i] : this.carry) : null;
    return out;
  }
}
const toFloat = (u16: number) => ((u16 & 0x8000 ? u16 - 0x10000 : u16) / 32768);

/** 把浮点样本排进 AudioContext。攒够 batch 个样本（默认 0.1 秒）排一段，最后 finish() 排掉剩下的。 */
export class PcmPlayer {
  private next = 0;
  private started = false;
  private last: PlaybackSource | null = null;
  private pending: Float32Array[] = [];
  private pendingLength = 0;
  constructor(
    private readonly context: PlaybackContext,
    private readonly sampleRate: number,
    private readonly batch = Math.round(sampleRate / 10),
  ) {}
  /** 已经排上第一段（界面从“准备中”换成“正在读”） */
  get playing() {
    return this.started;
  }
  push(samples: Float32Array) {
    if (!samples.length) return;
    this.pending.push(samples);
    this.pendingLength += samples.length;
    if (this.pendingLength >= this.batch) this.flush();
  }
  private flush() {
    if (!this.pendingLength) return;
    const merged = new Float32Array(this.pendingLength);
    let offset = 0;
    for (const part of this.pending) {
      merged.set(part, offset);
      offset += part.length;
    }
    this.pending = [];
    this.pendingLength = 0;
    const buffer = this.context.createBuffer(1, merged.length, this.sampleRate);
    buffer.getChannelData(0).set(merged);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const at = scheduleAt(this.next, this.context.currentTime, !this.started);
    source.start(at);
    this.next = at + merged.length / this.sampleRate;
    this.started = true;
    this.last = source;
  }
  /** 数据收完了：排掉剩下的，等最后一段放完。 */
  finish(): Promise<void> {
    this.flush();
    const last = this.last;
    if (!last || this.context.currentTime >= this.next) return Promise.resolve();
    return new Promise((resolve) => {
      last.onended = () => resolve();
    });
  }
}
