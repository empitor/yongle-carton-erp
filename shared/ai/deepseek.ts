/**
 * 只接 DeepSeek 官方接口：地址、模型、音色和各接口的上限都写死在这里，界面上不能改。
 * 接口细节以 https://api-docs.deepseek.com/zh-cn/ 为准。
 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = 'deepseek-flash';
export const DEEPSEEK_NAME = 'DeepSeek 官方接口';
export const DEEPSEEK_KEY_PAGE = 'https://platform.deepseek.com/api_keys';
/**
 * 思考档位：关，或官方 reasoning_effort 里有实际区别的三档（minimal 归 low，medium、xhigh 归 high，ultra 归 max）。
 * 官方不写时默认开、high。
 */
export const DEEPSEEK_THINKING_LEVELS = ['off', 'low', 'high', 'max'] as const;
export type DeepSeekThinking = (typeof DEEPSEEK_THINKING_LEVELS)[number];
/** 文字转语音的音色：stella 女声（默认），tide 男声 */
export const DEEPSEEK_VOICES = ['stella', 'tide'] as const;
export type DeepSeekVoice = (typeof DEEPSEEK_VOICES)[number];
export const DEEPSEEK_DEFAULT_VOICE: DeepSeekVoice = 'stella';
/** 文字转语音 pcm 格式：24 kHz、16 位有符号小端、单声道 */
export const DEEPSEEK_TTS_SAMPLE_RATE = 24_000;
const KIB = 1024;
const MIB = KIB * KIB;
/** 各接口收的文件上限，单位 MB */
const fileMegabytes = { asr: 8, image: 64, document: 100, table: 32 } as const;
export const DEEPSEEK_LIMITS = {
  asrBytes: fileMegabytes.asr * MIB,
  asrSeconds: 120,
  /** 计费字符，汉字算 2 个 */
  ttsBillingChars: 10_000,
  searchQueryChars: 128,
  searchCount: 50,
  fetchUrlChars: 8192,
  imageBytes: fileMegabytes.image * MIB,
  documentBytes: fileMegabytes.document * MIB,
  tableBytes: fileMegabytes.table * MIB,
  filesPerRequest: 20,
} as const;
/**
 * 上传用途：表格、图片、纯文本用 user_data；PDF、Word 用 text_recognition（只解析文字）；
 * 要看文档里图样的（唛头）用 rich_layout_recognition。
 */
export const uploadPurposes = ['user_data', 'text_recognition', 'rich_layout_recognition'] as const;
export type UploadPurpose = (typeof uploadPurposes)[number];
