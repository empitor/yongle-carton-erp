import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  SPEECH_SAMPLE_RATE,
  SPEECH_MAX_SECONDS,
  SPEECH_MIN_SECONDS,
  SPEECH_REQUEST_TIMEOUT_MS,
} from '../../shared/ai/index';
import { errorMessage } from '../../shared/core/index';
import { browserAudioContext } from './audio-context';
import { MicrophoneCapture } from './capture';
import { browserCapture } from './capture-graph';
import { speechToken, transcribe } from './assistant-api';
import { mergeAudioChunks, resampleAudio, encodePcm16LE } from './audio';

/*
 * 语音输入的一次录音和识别（useAssistantSpeech 用）：开始录音、到时自动停、停下交给 DeepSeek 识别、取消。
 * 状态都放在 hook 建的引用里（SpeechSession），这里的函数只读写它们，不依赖 React 渲染。
 */

export type SpeechPhase = 'idle' | 'starting' | 'recording' | 'transcribing';
/** 录音属于谁：换账号、换会话、按钮被禁用都算换了人，进行中的录音和识别作废 */
export type SpeechOwner = { userId: string | undefined; contextKey: string; disabled: boolean | undefined };

export type SpeechSession = {
  phaseRef: RefObject<SpeechPhase>;
  captureRef: RefObject<MicrophoneCapture<MediaStream> | null>;
  requestRef: RefObject<AbortController | null>;
  timerRef: RefObject<number | null>;
  /** 每开始或取消一次加一：旧的录音、识别回来时对不上就不算数 */
  generation: RefObject<number>;
  mounted: RefObject<boolean>;
  ownerRef: RefObject<SpeechOwner>;
  textRef: RefObject<(text: string) => void>;
  errorRef: RefObject<(message: string) => void>;
  stopRef: RefObject<() => Promise<void>>;
  unavailableRef: RefObject<string>;
  setPhase: Dispatch<SetStateAction<SpeechPhase>>;
  setSeconds: Dispatch<SetStateAction<number>>;
};

/** 录音时每隔多久更新一次秒数 */
const TICK_MS = 500;
const MS_PER_SECOND = 1000;

/**
 * 浏览器能不能录音：有麦克风接口、音频环境和 AudioWorklet（录音节点跑在音频线程里，capture-graph.ts）。
 * 只有带前缀 webkitAudioContext 的老 Safari（14.1 以前）没有 AudioWorklet，按不支持录音处理。
 */
export function speechSupported() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    !!browserAudioContext() &&
    typeof AudioWorkletNode !== 'undefined'
  );
}

function clearTimer(s: SpeechSession) {
  if (s.timerRef.current !== null) {
    window.clearInterval(s.timerRef.current);
    s.timerRef.current = null;
  }
}

/** 取消：录音、识别请求、计时都停，回到空闲 */
export function cancelSpeech(s: SpeechSession) {
  s.generation.current++;
  s.captureRef.current?.cancel();
  s.captureRef.current = null;
  s.requestRef.current?.abort();
  s.requestRef.current = null;
  clearTimer(s);
  s.phaseRef.current = 'idle';
  if (s.mounted.current) {
    s.setPhase('idle');
    s.setSeconds(0);
  }
}

/** 这次录音还算不算数：页面还在、没有重新开始或取消、还是同一个人 */
const isCurrent = (s: SpeechSession, token: number, owner: SpeechOwner) =>
  s.mounted.current &&
  token === s.generation.current &&
  !s.ownerRef.current.disabled &&
  s.ownerRef.current.userId === owner.userId &&
  s.ownerRef.current.contextKey === owner.contextKey;

/** 开始录音失败时给人看的话（浏览器报的错名字） */
function startFailure(error: unknown) {
  const name = error instanceof Error ? error.name : undefined;
  if (name === 'NotAllowedError') return '未获得麦克风权限，请在浏览器地址栏允许后重试。';
  if (name === 'NotFoundError') return '没有找到可用的麦克风。';
  return '无法开始录音，请检查麦克风或关闭占用设备的程序后重试。';
}

/** 录音中每半秒更新秒数，到上限自动停下去识别 */
function startTimer(s: SpeechSession, token: number, owner: SpeechOwner) {
  const startedAt = Date.now();
  s.timerRef.current = window.setInterval(() => {
    if (!isCurrent(s, token, owner)) return;
    const value = Math.floor((Date.now() - startedAt) / MS_PER_SECOND);
    s.setSeconds(Math.min(value, SPEECH_MAX_SECONDS));
    if (value >= SPEECH_MAX_SECONDS) void s.stopRef.current();
  }, TICK_MS);
}

/** 开始录音（同一时间只录一段；没填密钥时说明原因） */
export async function startSpeech(s: SpeechSession) {
  const owner = s.ownerRef.current;
  if (owner.disabled || !owner.userId || s.phaseRef.current !== 'idle') return;
  if (s.unavailableRef.current) {
    s.errorRef.current(s.unavailableRef.current);
    return;
  }
  const token = ++s.generation.current;
  s.phaseRef.current = 'starting';
  s.setPhase('starting');
  s.setSeconds(0);
  const capture = new MicrophoneCapture(
    () => {
      if (isCurrent(s, token, owner)) void s.stopRef.current();
    },
    () => {
      if (isCurrent(s, token, owner)) {
        cancelSpeech(s);
        s.errorRef.current('麦克风已断开，请重新连接后录音。');
      }
    },
    browserCapture,
  );
  s.captureRef.current = capture;
  try {
    const ready = await capture.start();
    if (!isCurrent(s, token, owner)) {
      capture.cancel();
      return;
    }
    if (!ready) return;
    s.phaseRef.current = 'recording';
    s.setPhase('recording');
    startTimer(s, token, owner);
  } catch (error) {
    capture.cancel();
    if (!isCurrent(s, token, owner)) return;
    s.captureRef.current = null;
    s.phaseRef.current = 'idle';
    s.setPhase('idle');
    s.errorRef.current(startFailure(error));
  }
}

/** 录到的声音换成 16kHz 交给 DeepSeek 识别；中途换了人、取消了交回 undefined */
async function recognize(r: {
  chunks: Float32Array[];
  sampleRate: number;
  userId: string | undefined;
  signal: AbortSignal;
  current: () => boolean;
}) {
  const samples = resampleAudio(mergeAudioChunks(r.chunks), r.sampleRate, SPEECH_SAMPLE_RATE).subarray(
    0,
    SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS,
  );
  if (samples.length < SPEECH_SAMPLE_RATE * SPEECH_MIN_SECONDS)
    throw Error(samples.length ? '录音太短，请至少录制0.3秒。' : '没有录到声音，请重试。');
  const csrf = await speechToken(r.userId, r.signal);
  if (!r.current()) return undefined;
  const text = await transcribe(csrf, encodePcm16LE(samples), r.signal);
  if (!r.current()) return undefined;
  if (!text) throw Error('没有识别到文字，请靠近麦克风再说一次。');
  return text;
}

/** 识别失败时给人看的话：等太久是超时，别的用出错说明 */
function stopFailure(signal: AbortSignal, error: unknown) {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') return '语音识别等待超时，请重试。';
  return errorMessage(error) || '语音识别失败，请重试。';
}

/** 停止录音并识别，识别出的文字交给输入框 */
export async function stopSpeech(s: SpeechSession) {
  const capture = s.captureRef.current;
  if (s.phaseRef.current !== 'recording' || !capture) return;
  const token = s.generation.current,
    owner = s.ownerRef.current;
  s.captureRef.current = null;
  s.phaseRef.current = 'transcribing';
  s.setPhase('transcribing');
  clearTimer(s);
  const { chunks, sampleRate } = capture.finish(),
    controller = new AbortController();
  s.requestRef.current = controller;
  const timeout = window.setTimeout(
    () => controller.abort(new DOMException('timeout', 'TimeoutError')),
    SPEECH_REQUEST_TIMEOUT_MS,
  );
  const current = () => isCurrent(s, token, owner);
  try {
    const text = await recognize({ chunks, sampleRate, userId: owner.userId, signal: controller.signal, current });
    if (text !== undefined) s.textRef.current(text);
  } catch (error) {
    if (!current()) return;
    s.errorRef.current(stopFailure(controller.signal, error));
  } finally {
    window.clearTimeout(timeout);
    if (s.requestRef.current === controller) s.requestRef.current = null;
    if (current()) {
      s.phaseRef.current = 'idle';
      s.setPhase('idle');
      s.setSeconds(0);
    }
  }
}
