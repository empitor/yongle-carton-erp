import type { ResponseFailureDetail } from '../ai/index.js';

/** AI 导入失败记录：服务端写进导入工作区，界面的“识别失败记录”按它显示。不含密钥和原文。 */
export type ImportFailureRecord = {
  id: string;
  recordedAt: string;
  failedAt: string | null;
  workspaceId: string | null;
  fileName: string;
  fileHash: string | null;
  format: string | null;
  size: number;
  revision: number | null;
  operation: 'analyze' | 'chat' | 'upload' | 'restart';
  stage: string;
  stream: boolean | null;
  durationMs: number | null;
  operator: { id: string; name: string } | null;
  provider: { endpoint: string | null; model: string; protocol: string | null };
  code: string;
  httpStatus: number | null;
  upstreamStatus: number | null;
  message: string;
  schemaIssues: { path: string; code: string }[];
  /** 上游响应的脱敏诊断（AI 连接出错时才有） */
  response?: ResponseFailureDetail;
  historical: boolean;
};
