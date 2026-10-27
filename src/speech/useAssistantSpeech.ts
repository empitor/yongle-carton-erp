import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SPEECH_SAMPLE_RATE,
  SPEECH_MAX_SECONDS,
  SPEECH_MIN_SECONDS,
  SPEECH_REQUEST_TIMEOUT_MS,
  type SpeechResult,
} from '../../shared/speech';
import { MicrophoneCapture } from './capture';
import { mergeAudioChunks, resampleAudio, encodePcm16LE } from './audio';
type Options = {
  userId?: string;
  contextKey?: string;
  disabled?: boolean;
  onText: (text: string) => void;
  onError: (message: string) => void;
};
type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';
export function useAssistantSpeech({
  userId,
  contextKey = '',
  disabled,
  onText,
  onError,
}: Options) {
  const [phase, setPhase] = useState<Phase>('idle'),
    [seconds, setSeconds] = useState(0);
  const phaseRef = useRef<Phase>('idle'),
    captureRef = useRef<MicrophoneCapture | null>(null),
    requestRef = useRef<AbortController | null>(null),
    timerRef = useRef<number | null>(null),
    generation = useRef(0),
    mounted = useRef(false),
    ownerRef = useRef({ userId, contextKey, disabled }),
    textRef = useRef(onText),
    errorRef = useRef(onError),
    stopRef = useRef<() => Promise<void>>(async () => {});
  ownerRef.current = { userId, contextKey, disabled };
  textRef.current = onText;
  errorRef.current = onError;
  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  const cancel = useCallback(() => {
    generation.current++;
    captureRef.current?.cancel();
    captureRef.current = null;
    requestRef.current?.abort();
    requestRef.current = null;
    clearTimer();
    phaseRef.current = 'idle';
    if (mounted.current) {
      setPhase('idle');
      setSeconds(0);
    }
  }, [clearTimer]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [cancel]);
  useEffect(() => {
    cancel();
  }, [userId, contextKey, disabled, cancel]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) cancel();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', cancel);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', cancel);
    };
  }, [cancel]);
  const current = (token: number, owner: typeof ownerRef.current) =>
    mounted.current &&
    token === generation.current &&
    !ownerRef.current.disabled &&
    ownerRef.current.userId === owner.userId &&
    ownerRef.current.contextKey === owner.contextKey;
  const start = useCallback(async () => {
    const owner = ownerRef.current;
    if (owner.disabled || !owner.userId || phaseRef.current !== 'idle') return;
    const token = ++generation.current;
    phaseRef.current = 'starting';
    setPhase('starting');
    setSeconds(0);
    const capture = new MicrophoneCapture(
      () => {
        if (current(token, owner)) void stopRef.current();
      },
      () => {
        if (current(token, owner)) {
          cancel();
          errorRef.current('麦克风已断开，请重新连接后录音。');
        }
      },
    );
    captureRef.current = capture;
    try {
      const ready = await capture.start();
      if (!current(token, owner)) {
        capture.cancel();
        return;
      }
      if (!ready) return;
      phaseRef.current = 'recording';
      setPhase('recording');
      const startedAt = Date.now();
      timerRef.current = window.setInterval(() => {
        if (!current(token, owner)) return;
        const value = Math.floor((Date.now() - startedAt) / 1000);
        setSeconds(Math.min(value, SPEECH_MAX_SECONDS));
        if (value >= SPEECH_MAX_SECONDS) void stopRef.current();
      }, 500);
    } catch (error) {
      capture.cancel();
      if (!current(token, owner)) return;
      captureRef.current = null;
      phaseRef.current = 'idle';
      setPhase('idle');
      const name = (error as DOMException).name;
      errorRef.current(
        name === 'NotAllowedError'
          ? '未获得麦克风权限，请在浏览器地址栏允许后重试。'
          : name === 'NotFoundError'
            ? '没有找到可用的麦克风。'
            : '无法开始录音，请检查麦克风或关闭占用设备的程序后重试。',
      );
    }
  }, [cancel]);
  const stop = useCallback(async () => {
    if (phaseRef.current !== 'recording' || !captureRef.current) return;
    const token = generation.current,
      owner = ownerRef.current,
      capture = captureRef.current;
    captureRef.current = null;
    phaseRef.current = 'transcribing';
    setPhase('transcribing');
    clearTimer();
    const { chunks, sampleRate } = capture.finish(),
      controller = new AbortController();
    requestRef.current = controller;
    const timeout = window.setTimeout(
      () => controller.abort(new DOMException('timeout', 'TimeoutError')),
      SPEECH_REQUEST_TIMEOUT_MS,
    );
    try {
      const samples = resampleAudio(
        mergeAudioChunks(chunks),
        sampleRate,
        SPEECH_SAMPLE_RATE,
      ).subarray(0, SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS);
      if (samples.length < SPEECH_SAMPLE_RATE * SPEECH_MIN_SECONDS)
        throw Error(samples.length ? '录音太短，请至少录制0.3秒。' : '没有录到声音，请重试。');
      const authResponse = await fetch('/api/auth/state', {
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
      });
      const auth = await authResponse.json();
      if (!current(token, owner)) return;
      if (!authResponse.ok || !auth?.csrf || auth.actor?.id !== owner.userId)
        throw Error('登录状态已变化，请重新登录后录音。');
      const response = await fetch('/api/assistant/transcribe', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-ERP-Auth-Token': String(auth.csrf),
        },
        body: encodePcm16LE(samples),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!current(token, owner)) return;
      if (!response.ok) throw Error(data?.message || '本地语音识别失败，请重试。');
      if (typeof data.text !== 'string') throw Error('本地语音识别响应格式不正确，请重试。');
      const text = (data as SpeechResult).text.trim();
      if (!text) throw Error('没有识别到文字，请靠近麦克风再说一次。');
      textRef.current(text);
    } catch (error) {
      if (!current(token, owner)) return;
      errorRef.current(
        controller.signal.reason?.name === 'TimeoutError'
          ? '本地语音识别等待超时，请重试。'
          : (error as Error).message || '本地语音识别失败，请重试。',
      );
    } finally {
      window.clearTimeout(timeout);
      if (requestRef.current === controller) requestRef.current = null;
      if (current(token, owner)) {
        phaseRef.current = 'idle';
        setPhase('idle');
        setSeconds(0);
      }
    }
  }, [clearTimer]);
  stopRef.current = stop;
  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== 'undefined' &&
    !!(
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    );
  return {
    supported,
    starting: phase === 'starting',
    recording: phase === 'recording',
    transcribing: phase === 'transcribing',
    active: phase !== 'idle',
    seconds,
    start,
    stop,
    cancel,
  };
}
