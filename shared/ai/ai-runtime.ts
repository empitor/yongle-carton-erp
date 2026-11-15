export const AI_REQUEST_TIMEOUT_MS = 600_000;
// 浏览器和本机代理给模型超时清理、JSON校验及识别结果保存保留余量。
const AI_HTTP_MARGIN_MS = 30_000;
export const AI_HTTP_TIMEOUT_MS = AI_REQUEST_TIMEOUT_MS + AI_HTTP_MARGIN_MS;
export type AiProgress = {
  /** thinking：开了思考的对话正在收思考内容 */
  stage: 'connecting' | 'processing' | 'thinking' | 'receiving' | 'validating';
  receivedChars: number;
  /** 已收到的思考字数（开了思考才有） */
  reasoningChars?: number;
  elapsedMs: number;
};
