import {
  DEEPSEEK_DEFAULT_VOICE,
  DEEPSEEK_LIMITS,
  DEEPSEEK_TTS_SAMPLE_RATE,
  type DeepSeekVoice,
} from '../../shared/ai/index.js';
import { z } from 'zod';
import { MIB } from '../../shared/core/index.js';
import { AiConnectionError, badResponse } from './errors.js';
import { closeAfter, openDeepSeek, readShaped, type AiTransport } from './transport.js';
import { fileBlob } from './file-types.js';

/** DeepSeek 语音：语音转文字（/v1/tools/asr，整段 WAV 进、文字出）和文字转语音（/v1/tools/tts，边合成边流回）。 */
export type SpeechAudio = { contentType: string; sampleRate: number; body: ReadableStream<Uint8Array> };

/** 语音识别的回答最多读 1 MB，识别出的文字最多留两万字 */
const ASR_REPLY_BYTES = MIB;
const ASR_MAX_TEXT_CHARS = 20_000;
/** 识别结果：text 必须是文字；时长不是数字的按 0 算 */
const recognizedSchema = z.object({ text: z.string(), duration_ms: z.number().catch(0) });

export async function speechToText(
  transport: AiTransport,
  key: string,
  wav: Buffer,
  signal?: AbortSignal,
): Promise<{ text: string; durationMs: number }> {
  if (wav.length > DEEPSEEK_LIMITS.asrBytes) throw new AiConnectionError('too_large', '录音太长，语音识别最多 8 MB。', 413);
  const form = new FormData();
  form.append('file', fileBlob('recording.wav', wav), 'recording.wav');
  const { response, deadline } = await openDeepSeek(transport, {
    op: 'asr', path: '/v1/tools/asr', key, form, timeoutMs: 60_000, signal,
  });
  return closeAfter(deadline, async () => {
    const body = await readShaped(response, recognizedSchema, ASR_REPLY_BYTES, deadline);
    return { text: body.text.slice(0, ASR_MAX_TEXT_CHARS), durationMs: body.duration_ms };
  });
}

/** 拿到响应头就返回，音频边合成边流回；正文读完或取消后才释放超时计时。 */
export async function textToSpeech(
  transport: AiTransport,
  key: string,
  text: string,
  opts: { signal: AbortSignal; voice?: DeepSeekVoice; format?: 'pcm' | 'wav' },
): Promise<SpeechAudio> {
  if (!text.trim()) throw new AiConnectionError('validation', '没有要朗读的文字。', 400);
  const format = opts.format || 'pcm';
  const { response, deadline } = await openDeepSeek(transport, {
    op: 'tts', path: '/v1/tools/tts', key, accept: '*/*', timeoutMs: 180_000, signal: opts.signal,
    json: { text, voice_id: opts.voice || DEEPSEEK_DEFAULT_VOICE, format, filter_markdown: true },
  });
  if (!response.body) {
    deadline.close();
    badResponse();
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          deadline.close();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        const safe = deadline.error(error);
        deadline.close();
        controller.error(safe.code === 'network' ? new AiConnectionError('upstream', '朗读中途断了，请再点一次。', 502) : safe);
      }
    },
    async cancel() {
      deadline.close();
      await reader.cancel().catch(() => {});
    },
  });
  return { contentType: format === 'pcm' ? 'audio/pcm' : 'audio/wav', sampleRate: DEEPSEEK_TTS_SAMPLE_RATE, body };
}
