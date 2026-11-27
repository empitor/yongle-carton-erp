// 生成正式导入预览（先按已建档的客户、产品复用档案）和调用识别；两件事都改任务状态并保存。
import { sales } from '../sales/index.js';
import { ZodError } from 'zod';
import { AppError, failureMessage } from '../core/index.js';
import { formatZodIssues } from '../import/index.js';
import { resolveImportCustomer } from '../import/index.js';
import { productFieldsFromDraft } from '../import/index.js';
import { productFitsCustomer, sameProductInBatch } from '../../shared/core/index.js';
import type { ImportMapping, ImportWorkspaceView } from '../../shared/import/index.js';
import type { ImportPreview, OrderImportState, Task, TaskState, WorkflowContext, WorkflowState } from './order-import-state.js';

type PlanRef = ImportPreview['plan']['customer'] | ImportPreview['plan']['products'][number];

/** 会话里各份导入已经正式建出来的产品（按回执） */
function createdProducts(wf: OrderImportState, ctx: WorkflowContext) {
  return wf.state(ctx.threadId, ctx.actor).tasks.flatMap((t) => {
    const receipt = wf.execution.receipt(t.workspaceId, ctx.check());
    return (receipt?.created || []).filter((r) => r.entity === 'products').map((r) => r.id);
  });
}
/**
 * 客户还没选定已有档案的：按名称找唯一的那位（同一批一起导入的几份，前面已经建好的客户后面直接复用）。
 * 每份执行前重新读取正式回执及真实档案，首份新建后后续立即复用。改了返回 true。
 */
function reuseCustomer(wf: OrderImportState, ctx: WorkflowContext, state: WorkflowState, w: ImportWorkspaceView, mapping: ImportMapping) {
  if (mapping.customer.mode === 'existing') return false;
  const batch = ctx.batchWorkspaceIds ?? [];
  const confirmedIds = batch.length
    ? state.tasks
        .filter((t) => batch.includes(t.workspaceId))
        .flatMap((t) => {
          const receipt = wf.execution.receipt(t.workspaceId, ctx.check());
          const order = receipt?.orderId ? sales(wf.store).order(receipt.orderId, true) : undefined;
          return order ? [order.customerId] : [];
        })
    : [];
  const resolution = resolveImportCustomer(wf.store, w.draft?.header.buyerName.value || '', confirmedIds);
  if (resolution.state === 'archived') throw new AppError('匹配客户已归档，请先恢复原档案；不会重复新建。', 409);
  if (resolution.state !== 'resolved') return false;
  const c = resolution.customer;
  mapping.customer = { mode: 'existing', id: c.id, version: c.version };
  return true;
}
/** 要新建的产品：同任务已正式建档、完整身份完全相同且归属不冲突的只有一个，就用它（相似、不完整的仍询问）。改了返回 true */
function reuseProducts(wf: OrderImportState, w: ImportWorkspaceView, mapping: ImportMapping, created: number[]) {
  const customerId = mapping.customer.mode === 'existing' ? mapping.customer.id : null;
  let changed = false;
  for (const line of w.draft?.lines || [])
    if (mapping.products[line.id]?.mode === 'new') {
      const definition = productFieldsFromDraft(line.fields);
      const exact = sales(wf.store)
        .products()
        .filter((p) => created.includes(p.id) && productFitsCustomer(p, customerId) && sameProductInBatch(p, definition));
      if (exact.length === 1) {
        mapping.products[line.id] = { mode: 'existing', id: exact[0].id, version: exact[0].version };
        changed = true;
      }
    }
  return changed;
}
const choice = (ref: PlanRef) => (ref.mode === 'existing' ? { mode: 'existing', id: ref.id, version: ref.version } : { mode: 'new' });
/** 按预览定下来的客户、产品回写到识别结果的对应关系；和原来不一样就写回去再出一次预览 */
async function settlePreview(wf: OrderImportState, ctx: WorkflowContext, w: ImportWorkspaceView, preview: ImportPreview) {
  if (!w.draft) throw new AppError('请先识别订单。');
  const refreshedMapping = {
    customer: choice(preview.plan.customer),
    products: Object.fromEntries(w.draft.lines.map((line, i) => [line.id, choice(preview.plan.products[i])])),
    roundingPolicy: w.mapping?.roundingPolicy || 'exact-cents',
  };
  if (JSON.stringify(refreshedMapping) === JSON.stringify(w.mapping)) return preview;
  const next = wf.imports.mapping(w.id, { expectedRevision: w.revision, mapping: refreshedMapping }, ctx.actor);
  return wf.execution.preview(next.id, { expectedRevision: next.revision }, ctx.check());
}
export async function prepare(wf: OrderImportState, ctx: WorkflowContext, state: WorkflowState, task: Task) {
  task.preview = undefined;
  task.previewRequest = undefined;
  try {
    let w = wf.imports.get(task.workspaceId);
    // 仅复用同任务已正式建档、完整身份完全相同的产品；相似/不完整身份仍询问。
    const created = createdProducts(wf, ctx);
    const mapping = structuredClone(w.mapping);
    // 先看客户再看产品，两样都要看（不因为客户改了就跳过产品）
    const customerChanged = !!mapping && reuseCustomer(wf, ctx, state, w, mapping);
    const changed = (!!mapping && reuseProducts(wf, w, mapping, created)) || customerChanged;
    if (changed) w = wf.imports.mapping(w.id, { expectedRevision: w.revision, mapping }, ctx.check());
    task.preview = await wf.execution.preview(w.id, { expectedRevision: w.revision }, ctx.check());
    task.preview = await settlePreview(wf, ctx, w, task.preview);
    task.previewRequest = ctx.requestId;
    task.state = 'awaiting_confirmation';
    task.error = undefined;
  } catch (e) {
    task.state = 'needs_review';
    task.error = failureMessage(e, '助手订单导入预览 ' + task.workspaceId, '预览失败');
  }
  task.previewRevision = wf.imports.get(task.workspaceId).revision;
  task.updatedAt = new Date().toISOString();
  wf.save(ctx, state);
}
export async function recognize(
  wf: OrderImportState,
  ctx: WorkflowContext,
  state: WorkflowState,
  task: Task,
  force = false,
) {
  const w = wf.imports.get(task.workspaceId);
  if ((w.mode && w.mode !== 'order'))
    throw new AppError(
      '该任务已切换为到货单，请在工作区核对模式，不能作为客户订单识别。',
      409,
    );
  if (w.imported && !w.imported.historical) {
    task.state = 'imported';
    wf.save(ctx, state);
    return;
  }
  if (w.draft && !force) {
    await prepare(wf, ctx, state, task);
    return;
  }
  const noAutoRetry: readonly TaskState[] = ['failed'];
  if (!force && (noAutoRetry.some((s) => s === task.state) || (task.state === 'recognizing' && !wf.running.has(task.id)))) return;
  if (task.recognitionRequest === ctx.requestId)
    throw new AppError('本轮已经尝试识别，未知计费结果不会自动重发；请稍后明确重试。', 409);
  const ai = wf.imports.status().ai;
  if (!ai.ready) throw new AppError(ai.message, 400, 'key_required');
  ctx.consumeModel?.();
  task.state = 'recognizing';
  task.recognitionRequest = ctx.requestId;
  task.error = undefined;
  wf.running.add(task.id);
  wf.save(ctx, state);
  wf.notify(ctx, task, true);
  const abort = () => wf.imports.abortRequest(task.workspaceId);
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    ctx.check();
    const current = wf.imports.get(w.id);
    await wf.imports.analyze(
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
    await prepare(wf, ctx, state, task);
  } catch (e) {
    task.state = 'failed';
    task.error =
      e instanceof ZodError
        ? formatZodIssues(e, '识别结果字段不完整')
        : failureMessage(e, '助手订单识别 ' + task.workspaceId, '识别失败');
    wf.save(ctx, state);
    throw e;
  } finally {
    wf.running.delete(task.id);
    ctx.signal.removeEventListener('abort', abort);
    wf.notify(ctx, task);
  }
}
