import type { AiFailureCode } from '../../shared/ai-settings.js';
/**
 * 模型响应在处理阶段被判定不可用时的已接收文本。
 * text 只包含已通过“不含密钥”检查、可安全展示给用户的部分文本；
 * 它绝不进入业务写入路径，只用于避免已生成的回答被整条丢弃。
 */
export type AiResponseNote = {
  kind: 'invalid-json' | 'truncated' | 'incomplete' | 'refusal' | 'empty' | 'protocol';
  text?: string;
};
export class AiConnectionError extends Error {
  diagnostic?: import('./response-failure.js').ResponseFailureDetail;
  upstreamStatus?: number;
  constructor(
    public readonly code: AiFailureCode,
    message: string,
    public readonly status = 400,
    public responseNote?: AiResponseNote,
  ) {
    super(message);
  }
}
