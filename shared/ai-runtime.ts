export const AI_REQUEST_TIMEOUT_MS = 600_000;
// 浏览器和本机代理给模型超时清理、JSON校验及草稿保存保留余量。
export const AI_HTTP_TIMEOUT_MS = AI_REQUEST_TIMEOUT_MS + 30_000;
export type AiProgress = {
  stage: 'connecting' | 'processing' | 'receiving' | 'validating';
  receivedChars: number;
  elapsedMs: number;
};
