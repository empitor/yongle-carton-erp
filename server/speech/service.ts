import { ImportError } from '../import/errors.js';
import { SPEECH_MAX_SAMPLES, SPEECH_SAMPLE_RATE, type SpeechResult } from '../../shared/speech.js';
import { getSpeechEngine } from './engine.js';
export {
  SPEECH_SAMPLE_RATE,
  SPEECH_MAX_SECONDS,
  SPEECH_MAX_SAMPLES,
  SPEECH_MAX_BYTES,
} from '../../shared/speech.js';
export type { SpeechResult } from '../../shared/speech.js';
export { setSpeechEngineForTests } from './engine.js';
export type { SpeechEngine } from './engine.js';
let busy = false;
export function pcmToSamples(buffer: Buffer): Float32Array {
  if (!Buffer.isBuffer(buffer) || !buffer.length)
    throw new ImportError('请提交本地录音的音频数据。', 400, 'speech');
  if (buffer.length % 2 !== 0) throw new ImportError('音频数据格式不正确。', 400, 'speech');
  const count = buffer.length / 2;
  if (count > SPEECH_MAX_SAMPLES)
    throw new ImportError('单次语音不能超过 60 秒，请缩短后重试。', 413, 'speech');
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = buffer.readInt16LE(i * 2) / 32768;
  return samples;
}
export async function transcribePcm(buffer: Buffer): Promise<SpeechResult> {
  if (busy) throw new ImportError('本地语音识别正在处理上一条，请稍后再试。', 429, 'speech');
  const samples = pcmToSamples(buffer);
  busy = true;
  try {
    const engine = await getSpeechEngine(),
      text = String(await engine.transcribe(samples)).trim();
    return { text, durationMs: Math.round((samples.length / SPEECH_SAMPLE_RATE) * 1000) };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('本地语音识别失败，请检查本机引擎并重试。', 503, 'speech');
  } finally {
    busy = false;
  }
}
