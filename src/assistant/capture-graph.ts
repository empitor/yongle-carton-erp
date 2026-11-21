import { SPEECH_SAMPLE_RATE } from '../../shared/assistant/index';
import { browserAudioContext } from './audio-context';
import type { CaptureEnvironment, CaptureGraph } from './capture';

/*
 * 浏览器里录音的音频环境：麦克风 → MediaStreamAudioSourceNode → AudioWorkletNode（音频线程跑 capture-worklet.js，
 * 每一小块样本经 port 交回页面）→ 接到扬声器（处理器不输出声音，只为让音频线程一直处理这个节点）。
 * 音频环境和节点从参数传进来（openCaptureGraph），替身环境下能单独测建到一半出错时收拾干净。
 */

/** 音频线程里录音处理器的名字：capture-worklet.js 的 registerProcessor 用的是同一个（那个文件不能引用模块） */
const CAPTURE_PROCESSOR = 'erp-capture';

/** 录音节点：样本从 port 过来 */
type PortLike = { onmessage: ((event: MessageEvent<unknown>) => void) | null; close(): void };
export type CaptureNodeLike<D> = { port: PortLike; connect(destination: D): unknown; disconnect(): void };
/** 麦克风那一头：接到录音节点 */
type SourceLike<N> = { connect(node: N): unknown; disconnect(): void };
/** 建录音要用的音频环境（真的是 AudioContext） */
export type CaptureContextLike<S, N, D> = {
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: D;
  readonly audioWorklet: { addModule(url: URL): Promise<void> };
  createMediaStreamSource(stream: S): SourceLike<N>;
  resume(): Promise<void>;
  close(): Promise<void>;
};

/** 断开一个节点：还没连上（开始录音中途取消）时 disconnect 会抛，收拾时只要断开，没连上就不用管 */
function disconnect(node: { disconnect(): void } | null) {
  try {
    node?.disconnect();
  } catch {
    // 见上
  }
}

/**
 * 把麦克风接到录音节点。context 是新建的音频环境，createNode 在处理器模块加载好以后建节点。
 * close 之后再回来的 start（比如加载处理器模块时取消了）什么都不接。
 */
export function openCaptureGraph<S, D, N extends CaptureNodeLike<D>, C extends CaptureContextLike<S, N, D>>(
  stream: S,
  context: C,
  createNode: (context: C) => N,
): CaptureGraph {
  let source: SourceLike<N> | null = null,
    node: N | null = null,
    closed = false;
  return {
    sampleRate: context.sampleRate,
    async start(onSamples) {
      await context.audioWorklet.addModule(new URL('./capture-worklet.js?no-inline', import.meta.url));
      if (closed) return;
      const input = context.createMediaStreamSource(stream);
      source = input;
      const recorder = createNode(context);
      node = recorder;
      recorder.port.onmessage = (event) => {
        if (event.data instanceof Float32Array) onSamples(event.data);
      };
      input.connect(recorder);
      recorder.connect(context.destination);
      if (context.state === 'suspended') await context.resume();
    },
    close() {
      closed = true;
      if (node) {
        node.port.onmessage = null;
        node.port.close();
      }
      disconnect(node);
      disconnect(source);
      node = null;
      source = null;
      // 关不成（已经关了）不影响：这次录音已经结束
      if (context.state !== 'closed') void context.close().catch(() => undefined);
    },
  };
}

/** 新建音频环境：先按 16kHz 要，浏览器不支持就用它默认的采样率录，交上去之前再换算（audio.ts 的 resampleAudio） */
function newAudioContext(): AudioContext {
  const Context = browserAudioContext();
  // 页面只在有音频环境时才显示能录音（useAssistantSpeech 的 supported），到这里没有是浏览器变了
  if (!Context) throw new Error('当前浏览器不支持录音。');
  try {
    return new Context({ sampleRate: SPEECH_SAMPLE_RATE });
  } catch (e) {
    if (!(e instanceof Error) || e.name !== 'NotSupportedError') throw e;
    return new Context();
  }
}

/** 浏览器里的录音环境：要麦克风（单声道、降噪），按上面接成录音节点 */
export const browserCapture: CaptureEnvironment<MediaStream> = {
  getUserMedia: () =>
    navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    }),
  openGraph: (stream) =>
    openCaptureGraph<MediaStream, AudioDestinationNode, AudioWorkletNode, AudioContext>(
      stream,
      newAudioContext(),
      (context) =>
        new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          // 立体声麦克风混成单声道交出来（和原来 ScriptProcessorNode(4096, 1, 1) 一样）
          channelCount: 1,
          channelCountMode: 'explicit',
        }),
    ),
};
