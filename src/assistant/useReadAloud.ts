import { useCallback, useEffect, useRef, useState } from 'react';
import { DEEPSEEK_TTS_SAMPLE_RATE } from '../../shared/ai/index';
import type { ReadAloudRequest } from '../../shared/assistant/index';
import { readAuthState } from '../ui/index';
import { openReadAloud } from './assistant-api';
import { PcmDecoder, PcmPlayer } from './read-aloud-audio';
import { browserAudioContext } from './audio-context';
import { errorMessage } from '../../shared/core/index';

/**
 * “读出来”：按消息编号请服务端朗读助手的回复，边收音频边播放。
 * 同一时间只读一条：点另一条先停掉这条，再点同一条就是停止。
 * 没有本机兜底：没填密钥、网络不通、余额不足时说清原因（服务端回的中文说明）。
 */
export type ReadAloudPhase = 'idle' | 'loading' | 'playing';
export type ReadAloud = {
  /** 正在读（或准备读）的那条消息 */
  messageId: string | null;
  phase: ReadAloudPhase;
  /** 最近一次出错是哪条消息、什么原因 */
  error: { messageId: string; message: string } | null;
  /** 用不了的原因（没填密钥等），能用时为空 */
  unavailable: string;
  toggle: (threadId: string, messageId: string) => void;
  stop: () => void;
};
type Options = {
  /** 助手状态里的 ai（服务器有没有能用的 DeepSeek 密钥） */
  ai?: { ready: boolean; message?: string } | null;
  onError?: (message: string) => void;
};
type Playback = { token: number; controller: AbortController; context: AudioContext };

export function readAloudUnavailable(ai: Options['ai']): string {
  if (!ai || ai.ready) return '';
  return '朗读用不了：' + (ai.message || '还没填写 DeepSeek 密钥。请管理员到 设置 → API 配置 填写。');
}

/**
 * 取朗读音频边收边播。live：这次朗读还算不算数（停了、换了一条就不算，后面收到的不再播）；
 * onPlaying：真正出声了（状态从“准备”换成“正在读”）。
 */
async function playStream(
  playback: Playback,
  body: ReadAloudRequest,
  live: () => boolean,
  onPlaying: () => void,
) {
  const auth = await readAuthState();
  if (!live()) return;
  const audio = await openReadAloud(auth.csrf, body, playback.controller.signal);
  const reader = audio.stream.getReader(),
    decoder = new PcmDecoder(),
    player = new PcmPlayer(playback.context, audio.sampleRate || DEEPSEEK_TTS_SAMPLE_RATE);
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (!live()) return;
      throw new Error('朗读中途断了，请再点一次。', { cause: e });
    }
    if (!live()) return void reader.cancel().catch(() => {});
    if (chunk.done) break;
    player.push(decoder.push(chunk.value));
    if (player.playing) onPlaying();
  }
  await player.finish();
}

export function useReadAloud({ ai, onError }: Options = {}): ReadAloud {
  const [state, setState] = useState<{ messageId: string | null; phase: ReadAloudPhase }>({ messageId: null, phase: 'idle' });
  const [error, setError] = useState<ReadAloud['error']>(null);
  const current = useRef<Playback | null>(null),
    tokens = useRef(0),
    errorRef = useRef(onError),
    unavailable = readAloudUnavailable(ai);
  errorRef.current = onError;

  const stop = useCallback(() => {
    tokens.current++;
    const playing = current.current;
    current.current = null;
    if (playing) {
      playing.controller.abort();
      void playing.context.close().catch(() => {});
    }
    setState({ messageId: null, phase: 'idle' });
  }, []);
  useEffect(() => {
    window.addEventListener('pagehide', stop);
    return () => {
      window.removeEventListener('pagehide', stop);
      stop();
    };
  }, [stop]);

  // 只用到不变的 setError 和引用，一直是同一个函数
  const fail = useCallback((messageId: string, message: string) => {
    setError({ messageId, message });
    errorRef.current?.(message);
  }, []);

  const toggle = useCallback(
    (threadId: string, messageId: string) => {
      const same = current.current && state.messageId === messageId;
      stop();
      if (same) return;
      setError(null);
      if (unavailable) return fail(messageId, unavailable);
      const Context = browserAudioContext();
      if (!Context) return fail(messageId, '当前浏览器不支持朗读。');
      // 浏览器要求在点击的同一步里建 AudioContext，否则不让出声
      const context = new Context({ sampleRate: DEEPSEEK_TTS_SAMPLE_RATE });
      void context.resume?.().catch(() => {});
      const playback: Playback = { token: tokens.current, controller: new AbortController(), context };
      current.current = playback;
      setState({ messageId, phase: 'loading' });
      const live = () => current.current === playback && tokens.current === playback.token;
      const onPlaying = () =>
        setState((s) => (s.phase === 'loading' ? { ...s, phase: 'playing' } : s));
      playStream(playback, { threadId, messageId }, live, onPlaying)
        .catch((e: unknown) => {
          if (current.current !== playback || (e instanceof Error && e.name === 'AbortError')) return;
          fail(messageId, errorMessage(e) || '朗读失败，请重试。');
        })
        .finally(() => {
          if (current.current === playback) stop();
        });
    },
    [stop, state.messageId, unavailable, fail],
  );

  return { ...state, error, unavailable, toggle, stop };
}
