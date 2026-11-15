import { AppError } from '../core/index.js';
import {
  SPEECH_MAX_SAMPLES,
  SPEECH_MIN_SAMPLES,
  SPEECH_SAMPLE_RATE,
  SPEECH_WAV_HEADER_BYTES,
} from '../../shared/ai/index.js';

/**
 * 录音数据：浏览器传来的裸 PCM（16 位小端、单声道）先核对长度，再包成 WAV。
 * DeepSeek 语音识别只收 16 位 PCM WAV 或 Ogg Opus。纯计算，不连网、不落盘。
 */

/** 16 位采样：每个采样点 2 字节 */
const BYTES_PER_SAMPLE = 2;
const BITS_PER_SAMPLE = 16;

/** 核对录音：非空、整数个采样点、0.3 秒到 60 秒之间。返回采样点数。 */
export function checkPcm(pcm: Buffer): number {
  if (!Buffer.isBuffer(pcm) || !pcm.length) throw new AppError('没有收到录音，请重新录一次。', 400, 'speech');
  if (pcm.length % BYTES_PER_SAMPLE !== 0) throw new AppError('录音数据格式不对，请重新录一次。', 400, 'speech');
  const samples = pcm.length / BYTES_PER_SAMPLE;
  if (samples > SPEECH_MAX_SAMPLES) throw new AppError('单次语音不能超过 60 秒，请缩短后重试。', 413, 'speech');
  if (samples < SPEECH_MIN_SAMPLES) throw new AppError('录音太短，请至少说 0.3 秒。', 400, 'speech');
  return samples;
}

/** WAV 头里各字段的字节位置 */
const at = {
  riff: 0,
  riffSize: 4,
  wave: 8,
  fmt: 12,
  fmtSize: 16,
  format: 20,
  channels: 22,
  sampleRate: 24,
  byteRate: 28,
  blockAlign: 32,
  bitsPerSample: 34,
  data: 36,
  dataSize: 40,
} as const;
/** fmt 段长度；PCM 编码、单声道都记作 1 */
const FMT_CHUNK_BYTES = 16;
const PCM_FORMAT = 1;
const MONO = 1;

/** 给裸 PCM 加 44 字节的 WAV 头：PCM 编码、单声道、16 位。 */
export function pcmToWav(pcm: Buffer, sampleRate = SPEECH_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(SPEECH_WAV_HEADER_BYTES);
  header.write('RIFF', at.riff, 'ascii');
  // RIFF 段长度不算开头的“RIFF”和这个长度字段本身
  header.writeUInt32LE(SPEECH_WAV_HEADER_BYTES - at.wave + pcm.length, at.riffSize);
  header.write('WAVE', at.wave, 'ascii');
  header.write('fmt ', at.fmt, 'ascii');
  header.writeUInt32LE(FMT_CHUNK_BYTES, at.fmtSize);
  header.writeUInt16LE(PCM_FORMAT, at.format);
  header.writeUInt16LE(MONO, at.channels);
  header.writeUInt32LE(sampleRate, at.sampleRate);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, at.byteRate); // 每秒字节数
  header.writeUInt16LE(BYTES_PER_SAMPLE, at.blockAlign); // 每个采样点的字节数
  header.writeUInt16LE(BITS_PER_SAMPLE, at.bitsPerSample);
  header.write('data', at.data, 'ascii');
  header.writeUInt32LE(pcm.length, at.dataSize);
  return Buffer.concat([header, pcm]);
}
