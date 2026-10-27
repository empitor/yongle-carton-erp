import type { ImportProposal } from './import-contract.js';
import { parseImportProposal } from './import-contract.js';
import type { getBusinessMetadata } from '../business/metadata.js';
import { InputError } from '../db.js';
import { z } from 'zod';

// 保留旧跨模块建议接口；当前订单分析使用 completeCompatible + 独立草稿契约。
export { probeModel } from './adapters.js';
export { completeCompatible, type ChatMessage } from './compatible-chat.js';
export type ProviderKind = 'openai' | 'gemini' | 'anthropic' | 'compatible' | 'ollama';
export interface ProviderConfiguration {
  kind: ProviderKind;
  model: string;
  endpoint: string;
  secretRef: string | null; // 指向服务端安全存储，绝不能放真实密钥或返回给模型。
}
export interface ProviderCapabilities {
  structuredOutput: 'json-schema' | 'json-only' | 'text-only';
  toolCalling: boolean;
  deployment: 'remote' | 'local'; // 本地部署需后端验证端点，不能仅信任这个声明。
}
export type WorkbookCell = {
  column: string;
  kind: 'text' | 'number' | 'boolean' | 'date' | 'blank' | 'formula';
  value: string | number | boolean | null;
  // 公式只保留来源信息与缓存值，不计算、不取外链。
};
export interface AnalysisRequest {
  catalog: ReturnType<typeof getBusinessMetadata>;
  sample: {
    dateSystem: '1900' | '1904';
    sheets: { name: string; rows: { row: number; cells: WorkbookCell[] }[] }[];
  };
  // 实施时由服务器生成与持久化；不得直接上传原文件给供应商。
  requestId: string;
}
export type ProviderReply =
  | { status: 'completed'; output: unknown; requestId: string }
  | { status: 'refused' | 'truncated' | 'failed'; requestId: string };
export interface AiProvider {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  // 未来仅从完成权限/隐私审查的分析服务调用，不把数据库、SQL或源码工具交给适配器。
  analyze(request: AnalysisRequest, options: { signal: AbortSignal }): Promise<ProviderReply>;
}
const providerReplySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('completed'),
    requestId: z.string().min(1).max(100),
    output: z.unknown(),
  }),
  z.strictObject({
    status: z.enum(['refused', 'truncated', 'failed']),
    requestId: z.string().min(1).max(100),
  }),
]);
export function validateProviderReply(raw: unknown, expectedRequestId: string): ImportProposal {
  const reply = providerReplySchema.parse(raw);
  if (reply.requestId !== expectedRequestId) throw new InputError('模型响应与当前分析任务不匹配');
  if (reply.status !== 'completed')
    throw new InputError('模型未完整返回建议，请人工处理或重新分析');
  return parseImportProposal(reply.output);
}
