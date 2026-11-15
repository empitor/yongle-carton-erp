import type { AiStatus } from '../ai/index.js';
import type { ImportedOrderRef, ImportWorkspaceView } from './order-draft.js';
import type { RecognitionMode } from './workspace-inputs.js';

/*
 * 识别文件列表（GET /api/ai/imports，服务端 server/import/workspace-store.ts 的 status()、repository.ts 的 list()）。
 * AI 导入页、今日页、数据管理、助手都从这里看有哪些识别文件。
 */

/** 列表上的一份在用的识别文件：只取摘要那几栏，识别结果只给有没有 */
export type WorkspaceSummary = {
  id: string;
  /** 版本号：数据管理按它归档、删除 */
  revision: number;
  fileName: string;
  fileHash: string;
  createdAt: string;
  task: NonNullable<ImportWorkspaceView['task']>;
  hasDraft: boolean;
  mode: RecognitionMode;
  arrivalDocId: number | null;
  arrivalSourceId: string | null;
};
/** 列表上的一份：摘要加导入过的订单；开了到货识别时还带到货状态和到货单号 */
export type WorkspaceListItem = WorkspaceSummary & {
  imported?: ImportedOrderRef;
  historyImport?: ImportedOrderRef;
  arrivalStatus?: string;
  arrivalNumber?: string | null;
};
/** 归档的一份：归档时没记文件名的是 null */
export type ArchivedWorkspace = { id: string; revision: number; fileName: string | null };
/** 内容和结构对不上、读不出来的一份：编号、版本号（够永久删除它）、给人看的说明 */
export type UnreadableWorkspace = { id: string; revision: number; problem: string };
/** AI 识别的排队情况 */
export type RecognitionQueue = { active: number; waiting: number; limit: number; configured: number };

export type ImportList = {
  /** 识别工作区的页面凭证：写入时放在请求头 X-ERP-AI-Token */
  csrfToken: string;
  ai: AiStatus;
  workspaces: WorkspaceListItem[];
  archives: ArchivedWorkspace[];
  unreadable: UnreadableWorkspace[];
  promptVersion: string;
  limits: { maxFileMB: number };
  queue: RecognitionQueue;
};
