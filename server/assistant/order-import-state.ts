// 会话里的订单导入任务：任务记录的存取、对外视图、选中当前任务、通知页面、读回最新识别结果。
import { z } from 'zod';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import type { ImportManager } from '../import/index.js';
import type { ImportExecutionService } from '../import/index.js';
import type { AssistantAttachments } from './attachments.js';
import { one, parseStoredJson, requirePermission } from '../core/index.js';
import { AppError } from '../core/index.js';
import { matchDraft } from '../import/index.js';
import { trackedOrder } from '../orders/index.js';
import { orderDraftSchema, type OrderDraft } from '../../shared/import/index.js';
import { pageHref, type AssistantAttachment } from '../../shared/core/index.js';
import type { ProviderTokenUsage } from '../ai/index.js';

/** 识别结果给助手看时，客户、产品候选各最多列几个 */
const CANDIDATES_SHOWN = 20;

/** 正式导入的预览（导入方案和预览摘要，ImportExecutionService.preview） */
export type ImportPreview = Awaited<ReturnType<ImportExecutionService['preview']>>;
/** 卡片和核对要读的那几项：预览摘要，方案里的来源版本、客户、产品、明细、合计、提醒和同名确认 */
const previewShape = z.looseObject({
  previewDigest: z.string(),
  plan: z.looseObject({
    source: z.looseObject({ revision: z.number() }),
    customer: z.looseObject({ mode: z.enum(['existing', 'new']), name: z.string() }),
    products: z.array(z.looseObject({ mode: z.enum(['existing', 'new']), name: z.string() })),
    order: z.looseObject({ lines: z.array(z.looseObject({})) }),
    total: z.string().nullable(),
    warnings: z.array(z.string()),
    confirmations: z.array(z.looseObject({ line: z.number(), lineId: z.string(), existing: z.array(z.string()) })),
  }),
});
/** 存下来的预览：核对那几项，交出去的是存的那个对象本身（各项和生成它的导入方案同一个样子） */
const storedPreview = z.custom<ImportPreview>((value) => previewShape.safeParse(value).success, '不是订单导入预览');
/** 存下来的识别结果（改识别结果时核对冲突用）：按识别结果的结构核对，交出去的是存的那个对象本身 */
const storedDraft = z.custom<OrderDraft>((value) => orderDraftSchema.safeParse(value).success, '不是订单识别结果');

/**
 * 会话里的一份订单导入任务。存在会话的 document 里（assistant_threads.document 的 orderWorkflow，这个文件写），
 * 读的时候按同一份结构核对。
 */
const storedTask = z.object({
  /** 助手上次读到的识别结果（改识别结果时按它核对是不是被别人改过） */
  observed: z.object({ revision: z.number(), draft: storedDraft.nullable() }).optional(),
  recognitionRequest: z.string().optional(),
  focusLine: z.number().optional(),
  id: z.string(),
  attachmentId: z.string().optional(),
  /** 经用户确认从收件箱转进这次对话的 */
  fromInbox: z.literal(true).optional(),
  fileName: z.string(),
  fileHash: z.string(),
  workspaceId: z.string(),
  state: z.string(),
  error: z.string().optional(),
  preview: storedPreview.optional(),
  previewRequest: z.string().optional(),
  previewRevision: z.number().optional(),
  result: z.object({ orderId: z.number(), orderNumber: z.string() }).optional(),
  updatedAt: z.string(),
});
const storedWorkflow = z.object({ activeId: z.string().optional(), tasks: z.array(storedTask) });
export type Task = z.output<typeof storedTask>;
/** 任务存下来的状态只会是这几种（view() 另外算出给人看的 interrupted、missing，不存） */
export const taskStates = ['uploaded', 'recognizing', 'failed', 'needs_review', 'awaiting_confirmation', 'imported'] as const;
export type TaskState = (typeof taskStates)[number];
export type WorkflowState = z.output<typeof storedWorkflow>;
const workflowRow = z.object({ workflow: z.string().nullable() });

export type WorkflowContext = {
  batchWorkspaceIds?: string[];
  sourceWorkspaceId?: string;
  threadId: string;
  actor: Actor;
  requestId: string;
  files: AssistantAttachment[];
  check: () => Actor;
  consumeModel?: () => void;
  onUsage?: (usage: ProviderTokenUsage) => void;
  signal: AbortSignal;
  emit: (event: string, data: unknown) => void;
};

/**
 * 订单导入工作流的状态部分；AssistantOrderWorkflow（order-workflow.ts）继承它并实现 call()。
 * order-import-*.ts 的函数只依赖它，成员因此不是 private。
 */
export abstract class OrderImportState {
  running = new Set<string>();
  constructor(
    readonly store: Store,
    readonly imports: ImportManager,
    readonly execution: ImportExecutionService,
    readonly attachments: AssistantAttachments,
  ) {}
  state(threadId: string, actor: Actor): WorkflowState {
    const row = one(
      this.store.db,
      workflowRow,
      "SELECT json_extract(document,'$.orderWorkflow') AS workflow FROM assistant_threads WHERE id=? AND user_id=?",
      z.uuid().parse(threadId),
      actor.id,
    );
    if (!row) throw new AppError('会话不存在或不属于当前账号。', 404);
    return row.workflow ? parseStoredJson(storedWorkflow, row.workflow, 'assistant_threads.document 的 orderWorkflow（会话 ' + threadId + '）') : { tasks: [] };
  }
  save(ctx: WorkflowContext, state: WorkflowState) {
    ctx.check();
    const changed = this.store.db
      .prepare(
        "UPDATE assistant_threads SET document=json_set(document,'$.orderWorkflow',json(?)),updated_at=? WHERE id=? AND user_id=?",
      )
      .run(JSON.stringify(state), new Date().toISOString(), ctx.threadId, ctx.actor.id);
    if (!changed.changes) throw new AppError('会话已删除，任务未继续。', 409);
  }
  view(threadId: string, actor: Actor) {
    const state = this.state(threadId, actor);
    return {
      ...state,
      tasks: state.tasks.map((t) => {
        const { observed: _observed, ...publicTask } = t;
        try {
          const w = this.imports.get(t.workspaceId);
          if (w.imported && !w.imported.historical)
            return {
              ...publicTask,
              preview: undefined,
              previewRequest: undefined,
              state: 'imported',
              result: { orderId: w.imported.orderId, orderNumber: w.imported.orderNumber },
              error: undefined,
            };
        } catch {
          // 工作区读不出来（删掉了、移走了）：这份任务照实标成“原工作区已移除”，别的任务照常显示
          return {
            ...publicTask,
            state: 'missing',
            error: '原工作区已移除，正式业务及聊天附件不受影响。',
          };
        }
        return t.state === 'recognizing' &&
          !this.running.has(t.id) &&
          !this.imports.isBusy(t.workspaceId)
          ? {
              ...publicTask,
              state: 'interrupted',
              error: '上次识别已中断，原件和旧识别结果保留；可明确要求重试。',
            }
          : publicTask;
      }),
    };
  }
  selected(ctx: WorkflowContext, taskId?: string) {
    requirePermission(ctx.check(), 'business:edit');
    const state = this.state(ctx.threadId, ctx.actor),
      task = state.tasks.find((t) => t.id === (taskId || state.activeId));
    if (!task) throw new AppError('当前会话尚未关联该订单任务，请先上传并要求识别订单。', 404);
    return { state, task };
  }
  /** 这份识别任务是不是这次对话里用户自己交来的：在这次对话里上传后识别的（带附件编号），或经确认从收件箱转来的。关联进来的别人的工作区不算。 */
  ownTask(ctx: WorkflowContext, taskId?: string) {
    const { task } = this.selected(ctx, taskId);
    return !!task.attachmentId || !!task.fromInbox;
  }
  notify(ctx: WorkflowContext, task: Task, navigate = false) {
    ctx.emit('effect', {
      type: navigate ? 'navigate' : 'workspace',
      url: pageHref('ai-import', { workspace: task.workspaceId }),
      workspaceId: task.workspaceId,
      taskId: task.id,
      state: task.state,
    });
  }
  result(ctx: WorkflowContext, task: Task) {
    const w = this.imports.get(task.workspaceId),
      matches = matchDraft(this.store, w),
      imported = w.imported && !w.imported.historical ? w.imported : null,
      order = imported ? trackedOrder(this.store, imported.orderId, true) : undefined;
    task.observed = { revision: w.revision, draft: structuredClone(w.draft) };
    const state = this.state(ctx.threadId, ctx.actor);
    const saved = state.tasks.find((t) => t.id === task.id);
    if (saved) {
      saved.observed = task.observed;
      this.save(ctx, state);
    }
    return {
      task: imported
        ? {
            ...task,
            observed: undefined,
            state: 'imported',
            preview: undefined,
            previewRequest: undefined,
            result: { orderId: imported.orderId, orderNumber: imported.orderNumber },
          }
        : { ...task, observed: undefined },
      ...(imported ? { order, previewIsHistorical: true } : {}),
      executionReceipt: this.execution.receipt(w.id, ctx.check()),
      workspace: {
        mode: w.mode,
        id: w.id,
        revision: w.revision,
        fileName: w.fileName,
        draft: w.draft,
        evaluation: w.evaluation,
        mapping: w.mapping,
        changes: w.changes,
        imported: w.imported,
      },
      matches: {
        customerCandidates: matches.customerCandidates.slice(0, CANDIDATES_SHOWN),
        productCandidates: Object.fromEntries(
          Object.entries(matches.productCandidates).map(([id, c]) => [id, c.slice(0, CANDIDATES_SHOWN)]),
        ),
      },
      url: pageHref('ai-import', { workspace: w.id }),
      message:
        task.state === 'imported'
          ? '该订单已正式导入，未重复创建。'
          : task.error ||
            '已读取最新识别结果及核验数据。',
    };
  }
  abstract call(name: string, raw: unknown, ctx: WorkflowContext): Promise<unknown>;
}
