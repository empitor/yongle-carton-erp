/**
 * 工作区库（workspaces.sqlite）里存成 JSON 的两列的结构：一份识别工作区（workspaces.document）、
 * 一条识别失败记录（recognition_failures.document）。repository.ts 写入前按它认一遍，读出来用 parseStoredJson 按它校验。
 */
import { z } from 'zod';
import {
  importWorkspaceViewSchema,
  orderDraftSchema,
  type DraftChange,
  type ImportFailureRecord,
  type ImportWorkspaceView,
  type OrderDraft,
} from '../../shared/import/index.js';

/** 库里存的一份工作区：页面看到的那些，加上改动历史（撤销用）和操作记录；上传时就写的几栏一定有 */
export type Workspace = ImportWorkspaceView & {
  task: NonNullable<ImportWorkspaceView['task']>;
  arrivalDocId: number | null;
  arrivalSourceId: string | null;
  promptVersion: string;
  archived?: boolean;
  history: { draft: OrderDraft; changes: DraftChange[] }[];
  audits: { at: string; kind: string; revision: number; changes: DraftChange[] }[];
};

const view = importWorkspaceViewSchema.shape;
/**
 * 一份识别工作区：在页面视图的结构（shared/import/workspace-view.ts）上扩展，加上改动历史（撤销用）和操作记录。
 * 和现在的写入代码写出来的样子一一对应：上传时就写的栏目（任务、到货关联、识别规则版本）库里一定有，
 * 视图里这几栏可省略，这里改成必有；会写 null 的写成可空；对不上的读到就报 StoredDataError，不默认、不丢。
 */
const workspaceObject = importWorkspaceViewSchema.extend({
  arrivalDocId: z.number().nullable(),
  arrivalSourceId: z.string().nullable(),
  task: view.task.unwrap(),
  promptVersion: z.string(),
  history: z.array(z.object({ draft: orderDraftSchema, changes: view.changes })),
  audits: z.array(z.object({ at: z.string(), kind: z.string(), revision: z.number(), changes: view.changes })),
});
export const storedWorkspace: z.ZodType<Workspace> = workspaceObject;
/**
 * 只读几栏时用的结构（重启补错误档案、列表摘要）：和整份同一套栏目，挑出要的几栏，
 * 一份工作区别处坏了不影响读这几栏。
 */
export const restartSubject = workspaceObject.pick({
  id: true,
  revision: true,
  fileName: true,
  fileHash: true,
  size: true,
  parsed: true,
  task: true,
});
export const workspaceSummary = workspaceObject.pick({
  fileName: true,
  fileHash: true,
  createdAt: true,
  task: true,
  mode: true,
  arrivalDocId: true,
  arrivalSourceId: true,
});

/**
 * 写进库之前按结构认一遍：对不上是程序自己拼错了（不是提交的内容、也不是模型交回的不对），
 * 记日志、按服务端错误报（回 500），不写进去。what 写明是哪张表哪一列哪一条。
 */
export function checkedForWrite<S extends z.ZodType>(schema: S, value: unknown, what: string) {
  const result = schema.safeParse(value);
  if (result.success) return;
  const rules = result.error.issues.map((i) => (i.path.length ? i.path.join('.') : '（整体）') + '：' + i.message);
  console.error('[识别导入] 要写进库的数据和结构对不上，没有写：' + what + '；' + rules.join('；'));
  throw new Error('要写进库的数据和结构对不上：' + what);
}
/** 写进库的 JSON 文字：先按结构认一遍（对不上见 checkedForWrite），认过的原样写 */
export function workspaceText(w: Workspace) {
  checkedForWrite(storedWorkspace, w, `workspaces.document（工作区 ${w.id}）`);
  return JSON.stringify(w);
}

/** 一条识别失败记录（不含密钥和原文） */
export const storedFailure: z.ZodType<ImportFailureRecord> = z.object({
  id: z.string(),
  recordedAt: z.string(),
  failedAt: z.string().nullable(),
  workspaceId: z.string().nullable(),
  fileName: z.string(),
  fileHash: z.string().nullable(),
  format: z.string().nullable(),
  size: z.number(),
  revision: z.number().nullable(),
  operation: z.enum(['analyze', 'chat', 'upload', 'restart']),
  stage: z.string(),
  stream: z.boolean().nullable(),
  durationMs: z.number().nullable(),
  operator: z.object({ id: z.string(), name: z.string() }).nullable(),
  provider: z.object({ endpoint: z.string().nullable(), model: z.string(), protocol: z.string().nullable() }),
  code: z.string(),
  httpStatus: z.number().nullable(),
  upstreamStatus: z.number().nullable(),
  message: z.string(),
  schemaIssues: z.array(z.object({ path: z.string(), code: z.string() })),
  response: z
    .object({
      event: z.string(),
      reason: z.string(),
      requestId: z.string().optional(),
      outputTokens: z.number().optional(),
      reasoningTokens: z.number().optional(),
      receivedChars: z.number().optional(),
    })
    .optional(),
  historical: z.boolean(),
});
