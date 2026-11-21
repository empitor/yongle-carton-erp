/**
 * 语音输入和朗读：浏览器和服务端共用的约定。
 * 浏览器录 16 kHz、16 位小端、单声道的裸 PCM 上传；服务端包成 WAV 交给 DeepSeek 识别，不落盘。
 * 朗读由服务端按消息编号取文字、请 DeepSeek 合成，音频（24 kHz 裸 PCM）边收边转给浏览器。
 * 密钥只在服务端，浏览器不直接连 DeepSeek。
 */
export const SPEECH_SAMPLE_RATE = 16000;
/** 我们自己的上限：一次最长 60 秒（DeepSeek 允许 120 秒） */
export const SPEECH_MAX_SECONDS = 60;
export const SPEECH_MIN_SECONDS = 0.3;
export const SPEECH_MAX_SAMPLES = SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS;
export const SPEECH_MIN_SAMPLES = Math.ceil(SPEECH_SAMPLE_RATE * SPEECH_MIN_SECONDS);
/** WAV 文件头（RIFF、fmt、data 三段）固定 44 字节 */
export const SPEECH_WAV_HEADER_BYTES = 44;
/** 浏览器等识别结果的上限 */
export const SPEECH_REQUEST_TIMEOUT_MS = 90000;
export type SpeechResult = { text: string; durationMs: number };
/** 朗读：浏览器提交的是哪条消息，服务端自己取文字（不接受浏览器传来的任意文字） */
export type ReadAloudRequest = { threadId: string; messageId: string };
