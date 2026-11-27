// 当前订单任务上的工具：选中、读取、重试识别、改识别结果、匹配档案、撤销、刷新预览。正式导入在 order-import-card.ts（出确认卡片）。
import { sales } from '../sales/index.js';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../core/index.js';
import { isLocalAdministrator } from '../core/index.js';
import { resolveImportCustomer } from '../import/index.js';
import { productCustomerIssue, productsForCustomer } from '../../shared/core/index.js';
import { MAX_DRAFT_OPERATIONS, patchOperationSchema, type DraftOperation, type ImportMapping, type ImportWorkspaceView, type OrderDraft } from '../../shared/import/index.js';
import { prepare, recognize } from './order-import-prepare.js';
import type { OrderImportState, Task, TaskState, WorkflowContext } from './order-import-state.js';

/** 料号最多几个字 */
const PRODUCT_CODE_MAX = 100;
/** 还没对应过档案的识别结果：客户待定、产品都没选 */
const emptyMapping = (): ImportMapping => ({ customer: { mode: 'pending' }, products: {}, roundingPolicy: 'exact-cents' });
/** 识别结果里这一处现在的值（改表头看表头那一栏，改明细看那一行的那一栏） */
const fieldValue = (draft: OrderDraft | null | undefined, op: DraftOperation) =>
  op.op === 'set-header' ? draft?.header[op.field]?.value : draft?.lines.find((l) => l.id === op.lineId)?.fields[op.field]?.value;
const lineEdit = (op: DraftOperation): op is Extract<DraftOperation, { op: 'set-line' }> => op.op === 'set-line';

/** 改识别结果：助手读过以后别人改过的，只有它要改的那几处没被别人动过（或已经是它要改成的值）才接着改 */
function editDraft(wf: OrderImportState, args: Record<string, unknown>, ctx: WorkflowContext, task: Task, w: ImportWorkspaceView) {
  const input = z
    .object({
      expectedRevision: z.number().int(),
      operations: z.array(patchOperationSchema).min(1).max(MAX_DRAFT_OPERATIONS),
    })
    .parse(args);
  if (!w.draft) throw new AppError('请先识别订单。');
  const lines = w.draft.lines;
  const rows = [...new Set(input.operations.filter(lineEdit).map((op) => lines.findIndex((l) => l.id === op.lineId) + 1))];
  if (input.expectedRevision !== w.revision) {
    const baseline = task.observed;
    if (
      !baseline ||
      baseline.revision !== input.expectedRevision ||
      input.operations.some(
        (op) =>
          !isDeepStrictEqual(fieldValue(baseline.draft, op), fieldValue(w.draft, op)) &&
          !isDeepStrictEqual(fieldValue(w.draft, op), op.value),
      )
    )
      throw new AppError(
        '识别结果里的这个字段已被其他操作修改，需要核对冲突值；不会覆盖新的业务决定。',
        409,
        'business-conflict',
      );
    input.expectedRevision = w.revision;
  }
  const edited = wf.imports.edit(w.id, input, 'ai', ctx.actor);
  if (rows.length === 1) task.focusLine = rows[0];
  return edited;
}

const matchInput = z.object({
  customerId: z.number().int().positive().optional(),
  line: z.number().int().min(1).optional(),
  productId: z.number().int().positive().optional(),
  productCode: z.string().trim().min(1).max(PRODUCT_CODE_MAX).optional(),
  createNew: z.boolean().default(false),
});
/** 这一行产品用哪个档案：说了新建就新建；按编号按主键读并核对客户归属；按料号在当前客户与未定客户的产品里找 */
function matchLine(wf: OrderImportState, w: ImportWorkspaceView, task: Task, mapping: ImportMapping, input: z.output<typeof matchInput> & { line: number }) {
  const line = w.draft?.lines[input.line - 1];
  if (!line) throw new AppError('识别结果里没有这一行。');
  task.focusLine = input.line;
  if (input.createNew) {
    mapping.products[line.id] = { mode: 'new' };
    return;
  }
  const customerId = mapping.customer.mode === 'existing' ? mapping.customer.id : null;
  const matches = input.productCode
    ? productsForCustomer(sales(wf.store).products(), customerId).filter((p) => p.customerProductCode === input.productCode)
    : input.productId
      ? sales(wf.store).products(false, [input.productId])
      : [];
  if (matches.length !== 1)
    throw new AppError('产品未唯一匹配，请明确选择档案编号，不能合并相似型号。');
  const p = matches[0];
  const target = customerId ? sales(wf.store).customer(customerId)?.name : w.draft?.header.buyerName.value;
  const issue = productCustomerIssue(p, { id: customerId, name: target });
  if (issue) throw new AppError(issue, 409);
  mapping.products[line.id] = { mode: 'existing', id: p.id, version: p.version };
}
/** 没指定客户、也没说新建：按名称和历史订单找唯一的那位，模糊的说明差异 */
function resolvedCustomer(wf: OrderImportState, w: ImportWorkspaceView): ImportMapping['customer'] {
  const resolved = resolveImportCustomer(wf.store, w.draft?.header.buyerName.value || '');
  if (resolved.state !== 'resolved')
    throw new AppError(
      resolved.state === 'archived'
        ? '匹配客户已归档，请先恢复。'
        : '客户身份未唯一确定，请查看候选及差异后选择。',
      409,
    );
  const c = resolved.customer;
  return { mode: 'existing', id: c.id, version: c.version };
}
/** 给识别结果对应客户和产品档案 */
function matchArchives(wf: OrderImportState, args: Record<string, unknown>, ctx: WorkflowContext, task: Task, w: ImportWorkspaceView) {
  const input = matchInput.parse(args);
  const mapping = structuredClone(w.mapping ?? emptyMapping());
  if (input.customerId) {
    const c = sales(wf.store).customer(input.customerId);
    if (!c) throw new AppError('客户不存在或不可用。');
    mapping.customer = { mode: 'existing', id: c.id, version: c.version };
  } else if (input.line) {
    matchLine(wf, w, task, mapping, { ...input, line: input.line });
  } else if (input.createNew) {
    mapping.customer = { mode: 'new' };
  } else mapping.customer = resolvedCustomer(wf, w);
  return wf.imports.mapping(w.id, { expectedRevision: w.revision, mapping }, ctx.actor);
}
/** 改识别结果、匹配档案、撤销、刷新预览：改完返回最新的工作区 */
function applyChange(wf: OrderImportState, name: string, args: Record<string, unknown>, ctx: WorkflowContext, task: Task) {
  const w = wf.imports.get(task.workspaceId);
  if ((w.mode && w.mode !== 'order'))
    throw new AppError('该文件当前是到货单模式，不能修改或导入为客户订单。', 409);
  if (w.imported && !w.imported.historical && !isLocalAdministrator(ctx.check()))
    throw new AppError('这份已经正式导入，识别结果不能再改；要改请改对应的正式订单。', 409);
  if (name === 'order_import.edit') return editDraft(wf, args, ctx, task, w);
  if (name === 'order_import.match') return matchArchives(wf, args, ctx, task, w);
  if (name === 'order_import.undo') return wf.imports.undo(w.id, { expectedRevision: w.revision }, ctx.actor);
  if (name !== 'order_import.preview') throw new AppError('未注册订单任务工具。', 404);
  return w;
}

/** 除五个入口工具以外的 order_import.*：都先取当前（或指定的）任务，原来 call() 的后半段。 */
export async function onTask(wf: OrderImportState, name: string, args: Record<string, unknown>, ctx: WorkflowContext) {
  const { state, task } = wf.selected(ctx, typeof args.taskId === 'string' ? args.taskId : undefined);
  state.activeId = task.id;
  if (name === 'order_import.select') {
    state.activeId = task.id;
    wf.save(ctx, state);
    wf.notify(ctx, task, true);
    return wf.result(ctx, task);
  }
  if (name === 'order_import.get') return wf.result(ctx, task);
  if (name === 'order_import.retry') {
    const retryable: readonly TaskState[] = ['failed', 'recognizing'];
    if (!retryable.some((s) => s === task.state))
      throw new AppError('当前任务没有失败，不会自动重复收费识别。', 409);
    await recognize(wf, ctx, state, task, true);
    return wf.result(ctx, task);
  }
  const w = applyChange(wf, name, args, ctx, task);
  if (w.imported && !w.imported.historical) {
    task.state = 'imported';
    task.preview = undefined;
    task.previewRequest = undefined;
    task.error = undefined;
    wf.save(ctx, state);
    wf.notify(ctx, task, true);
    return {
      ...wf.result(ctx, task),
      message:
        '工作区识别结果已保存并重新计算；原正式订单及导入回执保留，没有再次执行导入。修改正式订单请调用业务记录编辑工具。',
    };
  }
  await prepare(wf, ctx, state, task);
  wf.notify(ctx, task, true);
  return {
    ...wf.result(ctx, task),
    message:
      (name === 'order_import.edit'
        ? '识别结果已修改，后端已重新计算数量和金额。'
        : name === 'order_import.match'
          ? '档案匹配已保存。'
          : '导入方案已刷新。') +
      (task.error ? '仍需核对：' + task.error : ''),
  };
}
