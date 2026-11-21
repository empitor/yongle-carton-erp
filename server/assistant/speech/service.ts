import type { ServerResponse } from 'node:http';
import { AppError, pipeBytes, watchDisconnect } from '../../core/index.js';
import { AiConnectionError } from '../../ai/index.js';
import { SPEECH_SAMPLE_RATE, type SpeechResult } from '../../../shared/assistant/index.js';
import { checkPcm, pcmToWav } from './wav.js';

/**
 * 语音的两件事都交给 DeepSeek：
 * - 识别：浏览器录的 PCM 包成 WAV 发过去，拿回文字。音频只在内存里，不落盘。
 * - 朗读：一段文字发过去合成，音频边收边写给浏览器；浏览器断开就取消上游。
 * 只要传进来的对象有对应的方法就行（正式是 AiSettingsManager），测试直接传假的。
 */
export type SpeechToText = {
  speechToText(wav: Buffer, signal?: AbortSignal): Promise<{ text: string; durationMs: number }>;
};
export type TextToSpeech = {
  textToSpeech(
    text: string,
    opts: { signal: AbortSignal; format?: 'pcm' | 'wav' },
  ): Promise<{ sampleRate: number; body: ReadableStream<Uint8Array> }>;
};

/** DeepSeek 的报错本来就是给人看的中文，换成 AppError 交给统一的出错处理；别的错误不透传原文。 */
function speechError(error: unknown, what: string): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof AiConnectionError) return new AppError(error.message, error.status, error.code);
  return new AppError(what + '失败，请稍后重试。', 502, 'speech');
}

/** 正在识别的账号：每个账号同时只识别一段 */
const transcribing = new Set<string>();

export async function transcribePcm(
  ai: SpeechToText,
  pcm: Buffer,
  owner: string,
  signal?: AbortSignal,
): Promise<SpeechResult> {
  const samples = checkPcm(pcm);
  if (transcribing.has(owner)) throw new AppError('上一段语音还在识别，请稍等再说。', 429, 'speech');
  transcribing.add(owner);
  try {
    const { text } = await ai.speechToText(pcmToWav(pcm), signal);
    const spoken = text.trim();
    if (!spoken) throw new AppError('没有识别到文字，请靠近麦克风再说一次。', 422, 'response');
    return { text: spoken, durationMs: Math.round((samples / SPEECH_SAMPLE_RATE) * 1000) };
  } catch (error) {
    throw speechError(error, '语音识别');
  } finally {
    transcribing.delete(owner);
  }
}

/** 正在朗读的账号：同一账号再点一条，先停掉上一条（同时只读一条） */
const speaking = new Map<string, AbortController>();

/**
 * 朗读一段文字，把 DeepSeek 流回来的音频（24 kHz、16 位小端、单声道的裸 PCM）原样写给浏览器（边收边写的做法在
 * server/core/stream.ts 的 pipeBytes）。拿到第一块音频之前出错（没密钥、余额不足、网络不通）照常抛出，由出错处理回中文说明；
 * 已经开始写音频以后再断，只能断开连接，浏览器按“朗读中途断了”提示。
 */
export async function readAloud(ai: TextToSpeech, text: string, owner: string, res: ServerResponse): Promise<void> {
  speaking.get(owner)?.abort();
  const controller = new AbortController();
  speaking.set(owner, controller);
  const release = watchDisconnect(res, () => controller.abort());
  try {
    let audio: Awaited<ReturnType<TextToSpeech['textToSpeech']>>;
    try {
      audio = await ai.textToSpeech(text, { signal: controller.signal, format: 'pcm' });
    } catch (error) {
      if (controller.signal.aborted) return void res.destroy();
      throw speechError(error, '朗读');
    }
    await pipeBytes(res, audio.body, controller.signal, {
      'Content-Type': 'audio/pcm; rate=' + audio.sampleRate,
      'Cache-Control': 'no-store',
      'X-Audio-Sample-Rate': String(audio.sampleRate),
    }).catch((error: unknown) => {
      throw speechError(error, '朗读');
    });
  } finally {
    release();
    if (speaking.get(owner) === controller) speaking.delete(owner);
  }
}
