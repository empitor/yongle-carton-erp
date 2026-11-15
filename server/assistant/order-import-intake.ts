// 订单导入的入口工具：列出工作区、从收件箱转入、关联已有工作区、从聊天附件开始识别。
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, StoredDataError, failureMessage, isLocalAdministrator } from '../core/index.js';
import { InboxService } from '../inbox/index.js';
import type { AssistantAttachment } from '../../shared/core/index.js';
import { recognize } from './order-import-prepare.js';
import { MAX_ORDER_ATTACHMENTS, fromInboxArgs } from './tools/order-import.js';
import {
  taskStates,
  type OrderImportState,
  type Task,
  type TaskState,
  type WorkflowContext,
  type WorkflowState,
} from './order-import-state.js';

/** 一个会话里最多几份订单任务 */
const MAX_TASKS = 50;
/** 会话里的订单任务满了：两处（关联已有工作区、为附件建任务）说同一句 */
const tooManyTasks = () => new AppError(`本会话最多 ${MAX_TASKS} 个订单任务，请新建会话。`, 413);
/** start 回执里各份的状态怎么说（每种存下来的任务状态都必须有中文说法，不露英文） */
const startStates: Record<TaskState, string> = {
  uploaded: '尚未识别',
  recognizing: '上次识别已中断，没有自动重来；要重试请明确说',
  failed: '上次识别失败，没有自动重来；要重试请明确说',
  needs_review: '有待核对资料',
  awaiting_confirmation: '识别完成，完整方案待核对',
  imported: '已导入，未重复创建',
};

/** order_import.list */
export async function list(wf: OrderImportState, _args: Record<string, unknown>, ctx: WorkflowContext) {
  const { active, archived } = wf.imports.workspaceLists();
  return {
    active,
    // 归档的只给服务器本机的最高管理员看
    archived: isLocalAdministrator(ctx.check()) ? archived : [],
    message: '已读取原AI导入页面工作区；现有识别结果直接attach，无需重新识别。',
  };
}
/** order_import.from_inbox */
export async function fromInbox(wf: OrderImportState, args: Record<string, unknown>, ctx: WorkflowContext) {
  const v = fromInboxArgs.parse(args);
  const converted = await new InboxService(wf.store).toImport(
    v.inboxId,
    { kind: v.recognitionType, expectedVersion: v.expectedVersion },
    ctx.check(),
    wf.imports,
  );
  if (v.recognitionType !== 'order')
    return {
      workspaceId: converted.workspaceId,
      message: '已转入AI导入并设为到货单，尚未识别。',
    };
  const attached = await attach(wf, { workspaceId: converted.workspaceId }, ctx);
  // 记下这份是从收件箱转进这次对话的：改它的识别结果不用再出卡片（order-import-state.ts 的 ownTask）
  const state = wf.state(ctx.threadId, ctx.actor);
  const task = state.tasks.find((t) => t.workspaceId === converted.workspaceId);
  if (!task) throw new AppError('这份订单没有关联进当前会话，请重新转入。', 409);
  task.fromInbox = true;
  wf.save(ctx, state);
  return attached;
}
/** order_import.attach */
export async function attach(wf: OrderImportState, args: Record<string, unknown>, ctx: WorkflowContext) {
  const workspaceId = z.uuid().parse(args.workspaceId);
  // 归档的工作区也在库里，直接打开
  const w = wf.imports.get(workspaceId);
  if ((w.mode && w.mode !== 'order'))
    throw new AppError('该工作区是供应商到货单，不能作为销售订单导入。', 409);
  const state = wf.state(ctx.threadId, ctx.actor);
  let task = state.tasks.find((t) => t.workspaceId === w.id);
  if (!task) {
    if (state.tasks.length >= MAX_TASKS) throw tooManyTasks();
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
  wf.save(ctx, state);
  return {
    ...wf.result(ctx, task),
    message: '已关联原工作区，未上传、复制或调用识别。请读取识别结果核验后按用户要求预览或导入。',
  };
}
/** 这份附件能不能当订单识别：当前工作区已选了到货单的同一份文件不行，格式不对的不行 */
function assertOrderFile(wf: OrderImportState, ctx: WorkflowContext, file: AssistantAttachment) {
  if (ctx.sourceWorkspaceId) {
    const selected = wf.imports.get(ctx.sourceWorkspaceId);
    if (selected.fileHash === file.sha256 && (selected.mode && selected.mode !== 'order'))
      throw new AppError(
        '该文件在当前工作区已选择到货单识别，请沿用到货单流程；不会复制为销售订单。',
        409,
      );
  }
  if (!/\.(?:png|jpe?g|pdf|docx?|xlsx?)$/i.test(file.name))
    throw new AppError(
      '订单识别仅支持现有图片、PDF、Word、Excel格式；附件原件保留。',
      415,
    );
}
/** 这份附件的识别任务：同一份文件（按哈希）复用原任务；没有就上传成新的工作区、建任务并设为当前任务 */
async function taskFor(wf: OrderImportState, ctx: WorkflowContext, state: ReturnType<OrderImportState['state']>, file: AssistantAttachment) {
  const found = state.tasks.find((t) => t.fileHash === file.sha256);
  if (found) return found;
  if (state.tasks.length >= MAX_TASKS) throw tooManyTasks();
  const original = wf.attachments.file(file.id, ctx.check());
  const upload = await wf.imports.upload(original.bytes, original.meta.name, true);
  const task: Task = {
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
  wf.save(ctx, state);
  return task;
}
const idList = z.array(z.uuid()).max(MAX_ORDER_ATTACHMENTS).optional();
/** 存下来的任务状态的中文说法；不是那几种的说明会话里存的东西坏了 */
function stateLabel(state: string) {
  const known = taskStates.find((s) => s === state);
  if (!known) throw new StoredDataError('assistant_threads.document 的 orderWorkflow 里有不认识的任务状态：' + state);
  return startStates[known];
}
/** 去掉句末的句号，拼进回执时不和分隔符连成“。。”“。；” */
const clause = (text: string) => text.replace(/。$/, '');
/** 单份文件在 start 回执里的状态说明：优先写本次报错；没调模型且已有识别结果的写明没有重新识别 */
function targetSummary(t: Task, recognized: ReadonlySet<string>, errors: ReadonlyMap<string, string>) {
  const err = errors.get(t.id);
  if (err) return clause(err);
  const label = stateLabel(t.state),
    status = t.error ? `${label}：${clause(t.error)}` : label;
  if (!recognized.has(t.id) && (t.state === 'awaiting_confirmation' || t.state === 'needs_review'))
    return `已有识别结果，没有重新识别（${status}）`;
  return status;
}
function startMessage(targets: Task[], recognized: ReadonlySet<string>, errors: ReadonlyMap<string, string>) {
  const head = targets.map((t) => `${t.fileName}：${targetSummary(t, recognized, errors)}`).join('；');
  const tail = !recognized.size
    ? `本批共 ${targets.length} 份订单文件，本次没有重新识别；核对方案后再确认导入。`
    : recognized.size === targets.length
      ? `本批共 ${targets.length} 份订单文件，已按同一次请求提交识别；核对方案后再确认导入。`
      : `本批共 ${targets.length} 份订单文件，其中 ${recognized.size} 份已按同一次请求提交识别；核对方案后再确认导入。`;
  return `${head}。${tail}`;
}
/** 按参数或当前会话状态选出这次要识别的文件任务：点名了附件或任务就只认点名的；都没点名时先用当前消息附件，没有就用当前任务 */
async function selectTargets(
  wf: OrderImportState,
  args: Record<string, unknown>,
  ctx: WorkflowContext,
  state: ReturnType<OrderImportState['state']>,
) {
  const attachmentIds = idList.parse(args.attachmentIds),
    taskIds = idList.parse(args.taskIds),
    named = Boolean(attachmentIds?.length || taskIds?.length);
  const namedTasks = (taskIds ?? []).map((id) => {
    const found = state.tasks.find((t) => t.id === id);
    if (!found) throw new AppError('所选订单文件任务不属于当前会话。');
    return found;
  });
  const files = attachmentIds?.length
    ? ctx.files.filter((f) => attachmentIds.includes(f.id))
    : named
      ? []
      : ctx.files;
  if (attachmentIds?.length && files.length !== attachmentIds.length)
    throw new AppError('请选择当前会话可访问的订单附件。');
  if (!named && !files.length) {
    const active = state.tasks.find((t) => t.id === state.activeId);
    if (!active)
      throw new AppError(
        '请选择当前会话可访问的订单附件，或先用 order_import.from_inbox、order_import.attach 把订单文件放进本会话。',
      );
    return [active];
  }
  const planned = new Set([
    ...files.map((f) => state.tasks.find((t) => t.fileHash === f.sha256)?.id ?? 'hash:' + f.sha256),
    ...namedTasks.map((t) => t.id),
  ]);
  if (planned.size > MAX_ORDER_ATTACHMENTS)
    throw new AppError(`一次最多识别 ${MAX_ORDER_ATTACHMENTS} 份订单文件。`);
  for (const file of files) assertOrderFile(wf, ctx, file);
  const collected: Task[] = [];
  for (const file of files) collected.push(await taskFor(wf, ctx, state, file));
  collected.push(...namedTasks);
  return [...new Map(collected.map((t) => [t.id, t])).values()];
}
/** order_import.start */
export async function start(wf: OrderImportState, args: Record<string, unknown>, ctx: WorkflowContext) {
  if (args.recognitionType === 'arrival')
    throw new AppError(
      '这是供应商到货单，请改用 arrival.recognize 识别；不会作为销售订单处理。',
      409,
    );
  const state = wf.state(ctx.threadId, ctx.actor),
    targets = await selectTargets(wf, args, ctx, state),
    outcome: Outcome = { recognized: new Set(), errors: new Map(), rejected: new Map() };
  await Promise.all(targets.map((task) => recognizeOne(wf, ctx, state, task, outcome)));
  const main = targets.find((t) => !outcome.rejected.has(t.id));
  if (!main) throw outcome.rejected.get(targets[0].id);
  state.activeId = main.id;
  wf.save(ctx, state);
  wf.notify(ctx, main, true);
  return {
    ...wf.result(ctx, main),
    tasks: state.tasks,
    recognizedCount: outcome.recognized.size,
    message: startMessage(targets, outcome.recognized, outcome.errors),
  };
}
/** 这次 start 各份的结果：真调了模型的、要在回执里写明的原因、还没调模型就被拒的（原错误） */
type Outcome = { recognized: Set<string>; errors: Map<string, string>; rejected: Map<string, unknown> };
/** 识别一份并记下结果。本次请求号记上了才算真识别；工作区正被别处识别（busy）是在调模型之前拒的，不算 */
async function recognizeOne(wf: OrderImportState, ctx: WorkflowContext, state: WorkflowState, task: Task, outcome: Outcome) {
  const before = task.recognitionRequest;
  const started = () => task.recognitionRequest === ctx.requestId && before !== ctx.requestId;
  try {
    await recognize(wf, ctx, state, task);
    if (started()) outcome.recognized.add(task.id);
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    const busy = e instanceof AppError && e.code === 'busy';
    if (started() && !busy) outcome.recognized.add(task.id);
    else outcome.rejected.set(task.id, e);
    // 开始前被拒的没写进 task.error，中途出错的写进了；回执统一按这里记的原因逐份说明
    outcome.errors.set(task.id, failureMessage(e, '助手订单识别 ' + task.workspaceId, '识别失败'));
  }
}
