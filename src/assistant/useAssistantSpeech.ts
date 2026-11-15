import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { MicrophoneCapture } from './capture';
import {
  cancelSpeech,
  speechSupported,
  startSpeech,
  stopSpeech,
  type SpeechOwner,
  type SpeechPhase,
  type SpeechSession,
} from './speech-session';
type Options = {
  userId?: string;
  contextKey?: string;
  disabled?: boolean;
  /** 助手状态里的 ai（服务器有没有能用的 DeepSeek 密钥）；没传当作能用，由服务端回话说明 */
  ai?: { ready: boolean; message?: string } | null;
  onText: (text: string) => void;
  onError: (message: string) => void;
};
/** 录音交给 DeepSeek 识别，没有本机兜底：没填密钥时按钮置灰，悬停说明原因。 */
export function speechUnavailable(ai: Options['ai']): string {
  if (!ai || ai.ready) return '';
  return '语音输入用不了：' + (ai.message || '还没填写 DeepSeek 密钥。请管理员到 设置 → API 配置 填写。');
}

/** 一次录音要记的东西（都是引用，整个页面期间是同一份） */
function useSpeechSession(
  setPhase: Dispatch<SetStateAction<SpeechPhase>>,
  setSeconds: Dispatch<SetStateAction<number>>,
  first: { owner: SpeechOwner; onText: (text: string) => void; onError: (message: string) => void },
): SpeechSession {
  const phaseRef = useRef<SpeechPhase>('idle'),
    captureRef = useRef<MicrophoneCapture<MediaStream> | null>(null),
    requestRef = useRef<AbortController | null>(null),
    timerRef = useRef<number | null>(null),
    generation = useRef(0),
    mounted = useRef(false),
    ownerRef = useRef(first.owner),
    textRef = useRef(first.onText),
    errorRef = useRef(first.onError),
    stopRef = useRef<() => Promise<void>>(() => Promise.resolve()),
    unavailableRef = useRef('');
  return useMemo(
    () => ({
      phaseRef,
      captureRef,
      requestRef,
      timerRef,
      generation,
      mounted,
      ownerRef,
      textRef,
      errorRef,
      stopRef,
      unavailableRef,
      setPhase,
      setSeconds,
    }),
    [setPhase, setSeconds],
  );
}

/** 什么时候取消：页面关掉、换了人（账号、会话、禁用）、切到后台或离开页面 */
function useSpeechCancels(s: SpeechSession, cancel: () => void, owner: SpeechOwner) {
  useEffect(() => {
    s.mounted.current = true;
    return () => {
      s.mounted.current = false;
      cancel();
    };
  }, [s, cancel]);
  const { userId, contextKey, disabled } = owner;
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
}

/** 麦克风按钮的悬停说明 */
function speechHint(supported: boolean, unavailable: string, phase: SpeechPhase) {
  if (!supported) return '当前浏览器或访问方式不支持录音';
  if (unavailable) return unavailable;
  return phase === 'recording'
    ? '停止录音并识别'
    : '语音输入（录音交给 DeepSeek 识别；结果只填入输入框，不自动发送）';
}

export function useAssistantSpeech({
  userId,
  contextKey = '',
  disabled,
  ai,
  onText,
  onError,
}: Options) {
  const unavailable = speechUnavailable(ai);
  const [phase, setPhase] = useState<SpeechPhase>('idle'),
    [seconds, setSeconds] = useState(0);
  const owner = { userId, contextKey, disabled };
  const s = useSpeechSession(setPhase, setSeconds, { owner, onText, onError });
  s.ownerRef.current = owner;
  s.unavailableRef.current = unavailable;
  s.textRef.current = onText;
  s.errorRef.current = onError;
  // s 整个页面期间是同一份，这几个函数也一直是同一个
  const cancel = useCallback(() => cancelSpeech(s), [s]);
  useSpeechCancels(s, cancel, owner);
  const start = useCallback(() => startSpeech(s), [s]);
  const stop = useCallback(() => stopSpeech(s), [s]);
  s.stopRef.current = stop;
  const supported = speechSupported();
  return {
    supported,
    /** 不能用的原因（没填密钥等），能用时为空 */
    unavailable,
    /** 麦克风按钮的悬停说明 */
    hint: speechHint(supported, unavailable, phase),
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
