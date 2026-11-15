/** 模型响应没正常结束时的脱敏诊断：事件、原因、请求号和用量，不含正文。 */
export type ResponseFailureDetail = {
  event: string;
  reason: string;
  requestId?: string;
  outputTokens?: number;
  reasoningTokens?: number;
  receivedChars?: number;
};
