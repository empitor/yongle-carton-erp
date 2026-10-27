import { AiConnectionError } from './connection-error.js';
/** Only protocol identifiers and counts are retained; never model text or error.message. */
export type ResponseFailureDetail = {
  event: string;
  reason: string;
  requestId?: string;
  outputTokens?: number;
  reasoningTokens?: number;
  receivedChars?: number;
};
const identifier = (v: unknown) =>
  typeof v === 'string' && /^(?:resp|req)[-_][a-zA-Z0-9_.-]{1,110}$/.test(v) ? v : undefined;
export function responseFailure(event: string, raw: any, receivedChars = 0) {
  const r = raw?.response || raw || {},
    reason = r.incomplete_details?.reason || r.error?.code || raw?.code,
    known = [
      'max_output_tokens',
      'content_filter',
      'rate_limit_exceeded',
      'insufficient_quota',
      'invalid_api_key',
      'server_error',
      'model_not_found',
    ].includes(reason)
      ? reason
      : 'unknown';
  const messages: Record<string, string> = {
    max_output_tokens:
      '模型达到本次输出上限，完整订单JSON被截断，未保存不完整草稿。请减少单份内容后重试；系统不会自动重复收费请求。',
    content_filter: '模型安全策略拒绝了本次文件内容，未生成订单草稿。',
    rate_limit_exceeded: 'AI服务限制请求频率，请稍后单独重试。',
    insufficient_quota: 'AI服务额度不足，请检查服务商余额。',
    invalid_api_key: 'AI服务认证失败，请检查已保存的密钥。',
    server_error: 'AI服务在生成过程中发生内部错误，请稍后单独重试。',
    model_not_found: '当前模型不可用，请检查模型选择。',
    unknown:
      event === 'response.incomplete'
        ? 'AI输出未完整结束，服务未提供可识别的截断原因；未保存草稿。'
        : 'AI流式响应失败或被取消，未保存不完整草稿。',
  };
  // An SSE failure may already have consumed billable tokens. Unlike an HTTP429 rejection,
  // it must not enter the queue's automatic retry path.
  const error = new AiConnectionError('response', messages[known], 422);
  const number = (n: unknown) =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  error.diagnostic = {
    event,
    reason: known,
    requestId: identifier(r.id),
    outputTokens: number(r.usage?.output_tokens),
    reasoningTokens: number(r.usage?.output_tokens_details?.reasoning_tokens),
    receivedChars,
  };
  return error;
}
