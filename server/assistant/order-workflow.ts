import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import type { ImportManager } from '../import/manager.js';
import type { ImportExecutionService } from '../business/import-execution.js';
import type { AssistantAttachments } from './attachments.js';
import { requirePermission } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import { matchDraft } from '../import/matching.js';
import { patchOperationSchema } from '../../shared/order-draft.js';
import type { AssistantAttachment } from '../../shared/assistant-attachments.js';
import { isLocalAdministrator } from '../developer-capability.js';
import type { ProviderTokenUsage } from '../ai/usage.js';

export const orderWorkflowTools = [
  {
    name: 'order_import.list',
    description:
      '查询当前账号在AI订单导入页面可访问的现有工作区，包含手工上传文件。按UUID、文件名、模式、草稿及导入状态定位，不调用识别。',
    arguments: {},
    risk: 'workflow',
  },
  {
    name: 'order_import.attach',
    description:
      '将现有销售订单工作区关联到当前任务，保留原ID、哈希、修订、草稿和识别记录；不复制、不识别、不收费。返回最新完整草稿和真实匹配候选。',
    arguments: { workspaceId: 'list返回的工作区UUID' },
    risk: 'workflow',
  },
  {
    name: 'order_import.execute_many',
    description:
      '用户明确要求导入多份已识别订单时，逐份生成最新正式预览并通过原导入服务执行。workspaceIds须来自list/attach，最多6份；逐份回执，部分失败不回滚已成功文件，重试不重复导入。仅预览要求不得调用。',
    arguments: { workspaceIds: ['真实工作区UUID'] },
    risk: 'workflow',
  },
  {
    name: 'order_import.start',
    description:
      '将当前会话附件复制到原订单识别工作区并识别客户销售订单。仅用户明确要求识别/导入订单时使用；相同附件复用原任务，不自动重新收费。',
    arguments: { attachmentIds: ['当前会话附件UUID，可省略；多份时逐份独立任务'] },
    risk: 'workflow',
  },
  {
    name: 'order_import.get',
    description:
      '读取已关联工作区的完整订单识别草稿、金额、匹配候选、预览和错误，始终取服务器最新状态。',
    arguments: { taskId: '任务UUID，可省略；默认当前任务' },
    risk: 'workflow',
  },
  {
    name: 'order_import.select',
    description: '选择本会话已有文件任务，不重识别。多个任务时先询问目标文件。',
    arguments: { taskId: '本会话任务UUID' },
    risk: 'workflow',
  },
  {
    name: 'order_import.edit',
    description:
      '用户明确修改当前草稿时调用原草稿服务。operations为set-header或set-line，lineId须来自get；field/value/reason必须明确，未知事实不得猜测。',
    arguments: {
      expectedRevision: 'get返回的整数修订',
      operations: [
        {
          op: 'set-line',
          lineId: 'UUID',
          field: 'quantity等原草稿字段',
          value: '用户明确的新值或null',
          reason: '修改原因',
        },
      ],
    },
    risk: 'workflow',
  },
  {
    name: 'order_import.match',
    description:
      '明确选择草稿客户或某行产品档案，优先已有型号。customerId或line(从1起)/productId/productCode；不能凭相似型号猜测，歧义必须提问。',
    arguments: {
      customerId: '客户ID可省略',
      line: '产品行号',
      productId: '产品ID或省略',
      productCode: '用户指定的型号/物料编码，可省略',
      createNew: '用户明确要求新建时true',
    },
    risk: 'workflow',
  },
  {
    name: 'order_import.preview',
    description: '生成现有正式导入服务的完整预览；展示匹配、新档案、数量金额和税费，不写业务表。',
    arguments: {},
    risk: 'workflow',
  },
  {
    name: 'order_import.execute',
    description:
      '用户明确要求正式导入时调用。服务器生成并校验最新完整预览，使用与人工页面相同的正式导入服务；不要求聊天专属跨轮确认，不重复创建订单。',
    arguments: {},
    risk: 'workflow',
  },
  {
    name: 'order_import.retry',
    description:
      '仅用户明确要求重新识别/重试时重发当前失败任务；保留附件和旧草稿，未知计费不自动重试。',
    arguments: {},
    risk: 'workflow',
  },
  {
    name: 'order_import.undo',
    description: '用户明确撤销最近一次草稿修改，不撤回正式订单。',
    arguments: {},
    risk: 'workflow',
  },
] as const;
type Task = {
  recognitionRequest?: string;
  focusLine?: number;
  id: string;
  attachmentId?: string;
  fileName: string;
  fileHash: string;
  workspaceId: string;
  state: string;
  error?: string;
  preview?: any;
  previewRequest?: string;
  previewRevision?: number;
  result?: any;
  updatedAt: string;
};
type WorkflowState = { activeId?: string; tasks: Task[] };
export type WorkflowContext = {
  sourceWorkspaceId?: string;
  threadId: string;
  actor: Actor;
  requestId: string;
  text: string;
  files: AssistantAttachment[];
  profile?: { id: string; endpoint: string; model: string; apiStyle: string };
  check: () => Actor;
  consumeMutation?: () => void;
  consumeModel?: () => void;
  onUsage?: (usage: ProviderTokenUsage) => void;
  signal: AbortSignal;
  emit: (event: string, data: any) => void;
};

/** 持久任务只引用原工作区，不另建订单、库存或识别引擎。 */
export class AssistantOrderWorkflow {
  private running = new Set<string>();
  constructor(
    readonly store: Store,
    readonly imports: ImportManager,
    readonly execution: ImportExecutionService,
    readonly attachments: AssistantAttachments,
  ) {}
  private state(threadId: string, actor: Actor): WorkflowState {
    const row = this.store.db
      .prepare('SELECT document FROM assistant_threads WHERE id=? AND user_id=?')
      .get(z.string().uuid().parse(threadId), actor.id);
    if (!row) throw new ImportError('会话不存在或不属于当前账号。', 404);
    return JSON.parse(String(row.document)).orderWorkflow || { tasks: [] };
  }
  private save(ctx: WorkflowContext, state: WorkflowState) {
    ctx.check();
    const changed = this.store.db
      .prepare(
        "UPDATE assistant_threads SET document=json_set(document,'$.orderWorkflow',json(?)),updated_at=? WHERE id=? AND user_id=?",
      )
      .run(JSON.stringify(state), new Date().toISOString(), ctx.threadId, ctx.actor.id);
    if (!changed.changes) throw new ImportError('会话已删除，任务未继续。', 409);
  }
  view(threadId: string, actor: Actor) {
    const state = this.state(threadId, actor);
    return {
      ...state,
      tasks: state.tasks.map((t) => {
        try {
          const w = this.imports.get(t.workspaceId);
          if (w.imported && !w.imported.historical)
            return {
              ...t,
              preview: undefined,
              previewRequest: undefined,
              state: 'imported',
              result: { orderId: w.imported.orderId, orderNumber: w.imported.orderNumber },
              error: undefined,
            };
        } catch {
          return { ...t, state: 'missing', error: '原工作区已移除，正式业务及聊天附件不受影响。' };
        }
        return t.state === 'recognizing' &&
          !this.running.has(t.id) &&
          !this.imports.isBusy(t.workspaceId)
          ? {
              ...t,
              state: 'interrupted',
              error: '上次识别已中断，原件和旧草稿保留；可明确要求重试。',
            }
          : t;
      }),
    };
  }
  private selected(ctx: WorkflowContext, taskId?: string) {
    requirePermission(ctx.check(), 'business:edit');
    const state = this.state(ctx.threadId, ctx.actor),
      task = state.tasks.find((t) => t.id === (taskId || state.activeId));
    if (!task) throw new ImportError('当前会话尚未关联该订单任务，请先上传并要求识别订单。', 404);
    return { state, task };
  }
  private notify(ctx: WorkflowContext, task: Task, navigate = false) {
    ctx.emit('effect', {
      type: navigate ? 'navigate' : 'workspace',
      url: '#ai-import?workspace=' + task.workspaceId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      state: task.state,
    });
  }
  private async prepare(ctx: WorkflowContext, state: WorkflowState, task: Task) {
    task.preview = undefined;
    task.previewRequest = undefined;
    try {
      let w = this.imports.get(task.workspaceId);
      task.preview = await this.execution.preview(
        w.id,
        { expectedRevision: w.revision },
        ctx.check(),
      );
      const choice = (ref: any) =>
        ref.mode === 'existing'
          ? { mode: 'existing', id: ref.id, version: ref.version }
          : { mode: 'new' };
      const mapping = {
        customer: choice(task.preview.plan.customer),
        products: Object.fromEntries(
          w.draft!.lines.map((line, i) => [line.id, choice(task.preview.plan.products[i])]),
        ),
        roundingPolicy: w.mapping?.roundingPolicy || 'exact-cents',
      };
      if (JSON.stringify(mapping) !== JSON.stringify(w.mapping)) {
        w = this.imports.mapping(w.id, { expectedRevision: w.revision, mapping }, ctx.actor);
        task.preview = await this.execution.preview(
          w.id,
          { expectedRevision: w.revision },
          ctx.check(),
        );
      }
      task.previewRequest = ctx.requestId;
      task.state = 'awaiting_confirmation';
      task.error = undefined;
    } catch (e) {
      task.state = 'needs_review';
      task.error = e instanceof Error ? e.message : '预览失败';
    }
    task.previewRevision = this.imports.get(task.workspaceId).revision;
    task.updatedAt = new Date().toISOString();
    this.save(ctx, state);
  }
  private async recognize(ctx: WorkflowContext, state: WorkflowState, task: Task, force = false) {
    const w = this.imports.get(task.workspaceId);
    if (w.mode === 'arrival')
      throw new ImportError(
        '该任务已切换为到货单，请在工作区核对模式，不能作为客户订单识别。',
        409,
      );
    if (w.imported && !w.imported.historical) {
      task.state = 'imported';
      this.save(ctx, state);
      return;
    }
    if (w.draft && !force) {
      await this.prepare(ctx, state, task);
      return;
    }
    if (!force && ['failed', 'interrupted'].includes(task.state)) return;
    if (task.recognitionRequest === ctx.requestId)
      throw new ImportError('本轮已经尝试识别，未知计费结果不会自动重发；请稍后明确重试。', 409);
    const active = this.imports.status().active;
    if (!active) throw new ImportError('请先启用AI配置。', 400);
    if (
      ctx.profile &&
      ['id', 'endpoint', 'model', 'apiStyle'].some(
        (k) => (active as any)[k] !== (ctx.profile as any)[k],
      )
    )
      throw new ImportError('AI预设已变化，请载入当前配置后重新要求识别。', 409);
    ctx.consumeModel?.();
    this.imports.consent(w.id, {
      expectedRevision: w.revision,
      accepted: true,
      presetId: active.id,
      endpoint: active.endpoint,
      model: active.model,
      apiStyle: active.apiStyle || 'chat-completions',
    });
    task.state = 'recognizing';
    task.recognitionRequest = ctx.requestId;
    task.error = undefined;
    this.running.add(task.id);
    this.save(ctx, state);
    this.notify(ctx, task, true);
    const abort = () => this.imports.abortRequest(task.workspaceId);
    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      ctx.check();
      const current = this.imports.get(w.id);
      await this.imports.analyze(
        w.id,
        { expectedRevision: current.revision, stream: true, force },
        (p) => {
          ctx.check();
          ctx.emit('progress', p);
        },
        ctx.actor,
        ctx.onUsage,
      );
      ctx.check();
      await this.prepare(ctx, state, task);
    } catch (e) {
      task.state = 'failed';
      task.error = e instanceof Error ? e.message : '识别失败';
      this.save(ctx, state);
      throw e;
    } finally {
      this.running.delete(task.id);
      ctx.signal.removeEventListener('abort', abort);
      this.notify(ctx, task);
    }
  }
  private result(ctx: WorkflowContext, task: Task) {
    const w = this.imports.get(task.workspaceId),
      matches = matchDraft(this.store, w),
      imported = w.imported && !w.imported.historical ? w.imported : null,
      order = imported ? this.store.order(imported.orderId, true) : undefined;
    return {
      task: imported
        ? {
            ...task,
            state: 'imported',
            preview: undefined,
            previewRequest: undefined,
            result: { orderId: imported.orderId, orderNumber: imported.orderNumber },
          }
        : task,
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
        customerCandidates: matches.customerCandidates.slice(0, 20),
        productCandidates: Object.fromEntries(
          Object.entries(matches.productCandidates).map(([id, c]) => [id, c.slice(0, 20)]),
        ),
      },
      url: '#ai-import?workspace=' + w.id,
      message:
        task.state === 'imported'
          ? '该订单已正式导入，未重复创建。'
          : task.error ||
            '已读取最新草稿及核验数据；用户明确要求导入时可直接提交，预览不会写入正式订单。',
    };
  }
  async call(name: string, raw: unknown, ctx: WorkflowContext): Promise<any> {
    requirePermission(ctx.check(), 'business:edit');
    const args = z.record(z.string(), z.unknown()).parse(raw);
    if (name === 'order_import.list') {
      return {
        workspaces: this.imports.status().workspaces,
        archives: isLocalAdministrator(ctx.check()) ? this.imports.archives() : [],
        message: '已读取原AI导入页面工作区；现有草稿直接attach，无需重新识别。',
      };
    }
    if (name === 'order_import.attach') {
      const workspaceId = z.string().uuid().parse(args.workspaceId);
      const w = this.imports.archives().some((w: any) => w.id === workspaceId)
        ? await this.imports.openArchivedWorkspace(workspaceId, ctx.check())
        : this.imports.get(workspaceId);
      if (w.mode === 'arrival')
        throw new ImportError('该工作区是供应商到货单，不能作为销售订单导入。', 409);
      const state = this.state(ctx.threadId, ctx.actor);
      let task = state.tasks.find((t) => t.workspaceId === w.id);
      if (!task) {
        if (state.tasks.length >= 50) throw new ImportError('本会话最多50个订单任务。', 413);
        task = {
          id: randomUUID(),
          workspaceId: w.id,
          fileName: w.fileName,
          fileHash: w.fileHash,
          state: w.draft ? 'needs_review' : 'uploaded',
          updatedAt: new Date().toISOString(),
        };
        state.tasks.push(task);
      }
      state.activeId = task.id;
      this.save(ctx, state);
      return {
        ...this.result(ctx, task),
        message: '已关联原工作区，未上传、复制或调用识别。请读取草稿核验后按用户要求预览或导入。',
      };
    }
    if (name === 'order_import.execute_many') {
      requirePermission(ctx.check(), 'import:execute');
      const ids = z.array(z.string().uuid()).min(1).max(6).parse(args.workspaceIds);
      const results = [];
      for (const workspaceId of [...new Set(ids)]) {
        ctx.check();
        let fileName: string | undefined;
        try {
          const attached = await this.call('order_import.attach', { workspaceId }, ctx);
          fileName = attached.task.fileName;
          const result = await this.call('order_import.execute', { taskId: attached.task.id }, ctx);
          results.push({
            workspaceId,
            fileName: attached.task.fileName,
            success: !!result.order?.id,
            ...result,
          });
        } catch (e) {
          results.push({
            workspaceId,
            fileName,
            success: false,
            message: e instanceof Error ? e.message : '导入失败',
          });
          if (e instanceof ImportError && e.code === 'agent-budget') break;
        }
      }
      return {
        results,
        message: results.map((r) => (r.fileName || r.workspaceId) + '：' + r.message).join('；'),
        budgetExhausted:
          results.length < new Set(ids).size ||
          results.some((r) => !r.success && /预算/.test(r.message)),
        completed: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
      };
    }
    if (name === 'order_import.start') {
      if (args.recognitionType === 'arrival')
        throw new ImportError(
          '已选择供应商到货单，请在AI智能导入工作区使用到货单识别；不会作为销售订单处理。',
          409,
        );
      const state = this.state(ctx.threadId, ctx.actor),
        ids = z.array(z.string().uuid()).max(6).optional().parse(args.attachmentIds),
        files = ids?.length ? ctx.files.filter((f) => ids.includes(f.id)) : ctx.files;
      if (!files.length || (ids?.length && ids.length !== files.length))
        throw new ImportError('请选择当前会话可访问的订单附件。');
      const targets: Task[] = [];
      for (const file of files) {
        if (ctx.sourceWorkspaceId) {
          const selected = this.imports.get(ctx.sourceWorkspaceId);
          if (selected.fileHash === file.sha256 && selected.mode === 'arrival')
            throw new ImportError(
              '该文件在当前工作区已选择到货单识别，请沿用到货单流程；不会复制为销售订单。',
              409,
            );
        }
        if (!/\.(?:png|jpe?g|pdf|docx?|xlsx?)$/i.test(file.name))
          throw new ImportError(
            '订单识别仅支持现有图片、PDF、Word、Excel格式；附件原件保留。',
            415,
          );
        let task = state.tasks.find((t) => t.fileHash === file.sha256);
        if (!task) {
          if (state.tasks.length >= 50)
            throw new ImportError('本会话最多50个订单任务，请新建会话。', 413);
          const original = this.attachments.file(file.id, ctx.check());
          const upload = await this.imports.upload(original.bytes, original.meta.name, true);
          task = {
            id: randomUUID(),
            attachmentId: file.id,
            fileName: file.name,
            fileHash: file.sha256,
            workspaceId: upload.workspace.id,
            state: 'uploaded',
            updatedAt: new Date().toISOString(),
          };
          state.tasks.push(task);
          state.activeId = task.id;
          this.save(ctx, state);
        }
        targets.push(task);
      }
      state.activeId = targets[0].id;
      this.save(ctx, state);
      for (const task of targets) {
        try {
          await this.recognize(ctx, state, task);
        } catch (e) {
          if (e instanceof ImportError && e.code === 'agent-budget') throw e;
          if (ctx.signal.aborted) throw e;
        }
      }
      this.notify(ctx, targets[0], true);
      return {
        ...this.result(ctx, targets[0]),
        tasks: state.tasks,
        message:
          targets
            .map(
              (t) =>
                t.fileName +
                '：' +
                (t.error ||
                  {
                    awaiting_confirmation: '识别完成，完整方案待核对',
                    imported: '已导入，未重复创建',
                    failed: '识别失败',
                    needs_review: '有待核对资料',
                  }[t.state] ||
                  t.state),
            )
            .join('；') +
          '。当前文件：' +
          targets[0].fileName +
          '，客户采购订单按我司销售订单处理。核对下方方案后可回复“确认导入”。',
      };
    }
    const { state, task } = this.selected(
      ctx,
      typeof args.taskId === 'string' ? args.taskId : undefined,
    );
    state.activeId = task.id;
    if (name === 'order_import.select') {
      state.activeId = task.id;
      this.save(ctx, state);
      this.notify(ctx, task, true);
      return this.result(ctx, task);
    }
    if (name === 'order_import.get') return this.result(ctx, task);
    if (name === 'order_import.retry') {
      if (!['failed', 'interrupted', 'recognizing'].includes(task.state))
        throw new ImportError('当前任务没有失败，不会自动重复收费识别。', 409);
      await this.recognize(ctx, state, task, true);
      return this.result(ctx, task);
    }
    let w = this.imports.get(task.workspaceId);
    if (w.mode === 'arrival')
      throw new ImportError('该文件当前是到货单模式，不能修改或导入为客户订单。', 409);
    if (name === 'order_import.execute') {
      requirePermission(ctx.check(), 'import:execute');
      const own = w.imported && !w.imported.historical ? w.imported : null;
      if (own) {
        task.state = 'imported';
        this.save(ctx, state);
        return {
          ...this.result(ctx, task),
          order: this.store.order(own.orderId, true),
          url: '#orders?order=' + own.orderId,
          message: '订单 ' + own.orderNumber + ' 已导入，本次没有重复创建。',
        };
      }

      if (task.previewRevision !== undefined && task.previewRevision !== w.revision) {
        await this.prepare(ctx, state, task);
        return {
          ...this.result(ctx, task),
          message: '草稿已被其他页面修改，原版本发生变化。已读取新方案；请核对最新资料后继续。',
        };
      }
      // 与人工页面共用最新完整预览、字段/关联/权限检查，无聊天专属跨轮门槛。
      await this.prepare(ctx, state, task);
      if (!task.preview || task.error)
        throw new ImportError(task.error || '正式导入预览未通过。', 409);
      w = this.imports.get(task.workspaceId);
      ctx.emit('import_preview', { workspaceId: w.id, preview: task.preview });
      ctx.consumeMutation?.();
      const receipt = await this.execution.execute(
          w.id,
          { previewId: task.preview.id, acknowledged: true },
          ctx.check(),
          ctx.check,
        ),
        order = this.store.order(receipt.orderId, true)!;
      task.state = 'imported';
      task.result = { orderId: order.id, orderNumber: order.number };
      task.error = undefined;
      this.save(ctx, state);
      ctx.emit('effect', { type: 'business', url: '#orders?order=' + order.id, workspaceId: w.id });
      return {
        ...this.result(ctx, task),
        order,
        url: '#orders?order=' + order.id,
        message: `已正式导入销售订单 ${order.number}；客户 ${order.customerName}；${order.lines.length} 项产品，金额 ${order.totalAmountExact || (order.totalCents / 100).toFixed(2)} CNY。`,
      };
    }
    if (w.imported && !w.imported.historical && !isLocalAdministrator(ctx.check()))
      throw new ImportError('任务已正式导入，草稿不能覆盖；请明确要求修改对应正式订单。', 409);
    if (name === 'order_import.edit') {
      const input = z
        .object({
          expectedRevision: z.number().int(),
          operations: z.array(patchOperationSchema).min(1).max(100),
        })
        .parse(args);
      const rows = [
        ...new Set(
          input.operations
            .filter((op) => op.op === 'set-line')
            .map((op) => w.draft!.lines.findIndex((l) => l.id === (op as any).lineId) + 1),
        ),
      ];
      w = this.imports.edit(w.id, input, 'ai', ctx.actor);
      if (rows.length === 1) task.focusLine = rows[0];
    } else if (name === 'order_import.match') {
      const input = z
        .object({
          customerId: z.number().int().positive().optional(),
          line: z.number().int().min(1).optional(),
          productId: z.number().int().positive().optional(),
          productCode: z.string().trim().min(1).max(100).optional(),
          createNew: z.boolean().default(false),
        })
        .parse(args);

      const mapping = structuredClone(
        w.mapping || { customer: { mode: 'pending' }, products: {}, roundingPolicy: 'exact-cents' },
      ) as any;
      if (input.customerId) {
        const c = this.store.customer(input.customerId);
        if (!c) throw new ImportError('客户不存在或不可用。');
        mapping.customer = { mode: 'existing', id: c.id, version: c.version };
      } else if (input.line) {
        const line = w.draft?.lines[input.line - 1];
        if (!line) throw new ImportError('草稿行号不存在。');
        task.focusLine = input.line;
        if (input.createNew) {
          mapping.products[line.id] = { mode: 'new' };
        } else {
          const matches = this.store
            .products()
            .filter((p) =>
              input.productCode
                ? p.customerProductCode === input.productCode
                : p.id === input.productId,
            );
          if (matches.length !== 1)
            throw new ImportError('产品未唯一匹配，请明确选择档案编号，不能合并相似型号。');
          const p = matches[0];
          mapping.products[line.id] = { mode: 'existing', id: p.id, version: p.version };
        }
      } else if (input.createNew) mapping.customer = { mode: 'new' };
      else throw new ImportError('请说明客户或具体产品行及其型号。');
      w = this.imports.mapping(w.id, { expectedRevision: w.revision, mapping }, ctx.actor);
    } else if (name === 'order_import.undo') {
      w = this.imports.undo(w.id, { expectedRevision: w.revision }, ctx.actor);
    } else if (name !== 'order_import.preview') throw new ImportError('未注册订单任务工具。', 404);
    if (w.imported && !w.imported.historical) {
      task.state = 'imported';
      task.preview = undefined;
      task.previewRequest = undefined;
      task.error = undefined;
      this.save(ctx, state);
      this.notify(ctx, task, true);
      return {
        ...this.result(ctx, task),
        message:
          '工作区草稿已保存并重新计算；原正式订单及导入回执保留，没有再次执行导入。修改正式订单请调用业务记录编辑工具。',
      };
    }
    await this.prepare(ctx, state, task);
    this.notify(ctx, task, true);
    return {
      ...this.result(ctx, task),
      message:
        (name === 'order_import.edit'
          ? '草稿已修改，后端已重新计算数量和金额。'
          : name === 'order_import.match'
            ? '档案匹配已保存。'
            : '导入方案已刷新。') +
        (task.error ? '仍需核对：' + task.error : '可按用户当前明确指令正式导入。'),
    };
  }
}
