// 执行模型一条回复里的工具调用，结果原样（截到上限）作为 tool 消息回给模型：
// - 只读的直接执行；
// - 写入的（业务类全部；流程类按 workflow-cards.ts 那张固定的表）只出确认卡片，回给模型“等用户确认”，人点了才执行（previews.ts）；
// - 出错的把原因回给模型，由它用自己的话说明或换办法。服务器不替它说话，也不替它重试。
// 权限、工具启停、参数结构由注册表在分派时核对（tool-registry.ts 的 dispatch）。
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AppError, failureMessage } from '../../core/index.js';
import type { ToolPlan } from '../plan-rules.js';
import type { ToolHandlers, ToolKind } from '../tool-registry.js';
import type { CheckedCall } from '../tools/define.js';
import { commandLabel } from '../command-directory.js';
import { unwrapCommand, usageHint } from './command-tools.js';
import { allowedUrl, noteSearchResult } from './external-content.js';
import type { ChatRun, ChatServices, ModelReply, ToolCall } from './run-state.js';
import { saveTurn } from './session-history.js';
import { capToolResult, pageHint } from './tool-result-cap.js';
import { workflowWrite, type WorkflowCard } from './workflow-cards.js';
import { selfBoundedResults } from '../tools/web.js';
import { noteSources, stepLabel } from './turn-trail.js';
import { WORKFLOW_DIRECT } from './workflow-direct.js';
import { moduleSchema } from '../tools/modules.js';
import { observeForPage } from '../tools/page-record.js';
import { objectArgs } from '../tools/context.js';
import { field, firstText, listField } from './result-fields.js';
import { planCard } from '../json-view.js';

/** 确认卡片出了以后多久不点就过期：15 分钟（和导入预览的有效期一样长） */
export const CARD_TTL_MS = 900_000;
/** 识别任务没成的两种状态（order-import-state.ts 的 Task.state） */
const FAILED_TASK_STATES: readonly unknown[] = ['failed', 'interrupted'];
const TOOL_TIMEOUT_NOTE = '这一步太久没有做完，已经中止。它可能已经做了一部分：先查一下现在的情况再决定，不要直接重做。';
/** 一句话里执行的命令到了步数上限以后，同一条回复里剩下的调用回给模型的话 */
const STEP_LIMIT_SKIPPED = '这一轮已经到了步数上限，这个命令没有执行。';
const WAITING_NOTE = '已出确认卡片，还没有执行；用户在卡片上点确认后才执行，结果到时会交给你。';

/** 出一张确认卡片；返回给模型看的结果。测试开了自动确认时立刻走和人点确认同一个执行函数（删除、清空除外）。 */
async function proposeCard(svc: ChatServices, run: ChatRun, plan: ToolPlan, stamp: unknown) {
  const { id, binding, emit, check, plans, links, facts, options } = run;
  const current = check(),
    previewId = randomUUID(),
    expiresAt = Date.now() + CARD_TTL_MS;
  svc.previews.save({ id: previewId, threadId: id, actor: current, binding, expiresAt, plan, stamp });
  const view = svc.previews.planView(previewId, expiresAt, plan, current);
  svc.conversations.log(current, id, plan.tool, 'proposed', { previewId, label: plan.label });
  if (svc.agent.autoConfirm && !view.destructive) {
    const result: unknown = await svc.previews.commit(previewId, { acknowledged: true }, check(), binding, { proxy: !!options.proxy, automatic: true });
    facts.executed.push({ label: plan.label });
    const planArgs: unknown = plan.args;
    const module = field(planArgs, 'module');
    const linked = moduleSchema.safeParse(module);
    if (linked.success && field(result, 'id'))
      links.push({ url: svc.tools.link(linked.data, result), label: firstText([field(result, 'number'), field(result, 'name')], plan.label) });
    emit('effect', { type: 'business', module });
    // 导出类的卡片：文件交给页面下载（真人确认时由核对区下载，useAssistantReview.ts）
    const file = field(result, 'file');
    if (file) emit('effect', { type: 'download', file });
    return { state: 'executed', previewId, label: plan.label, result };
  }
  plans.push(planCard(view));
  facts.cards.push({ id: previewId, label: plan.label });
  return {
    state: 'awaiting_confirmation',
    previewId,
    label: plan.label,
    ...(plan.summary ? { summary: plan.summary } : {}),
    ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
    note: WAITING_NOTE,
  };
}

/** 流程类卡片（workflow-cards.ts 给的内容）变成存下来的方案 */
const cardPlan = (tool: string, args: unknown, card: WorkflowCard): ToolPlan => ({
  tool,
  args: card.args ?? objectArgs.parse(args),
  label: card.label,
  highRisk: false,
  before: null,
  after: null,
  warnings: card.warnings ?? [],
  workflow: true,
  summary: card.summary,
});

function read(svc: ChatServices, run: ChatRun, name: string, call: CheckedCall, signal: AbortSignal): unknown {
  const { id, input, binding, check, emit } = run;
  const { args } = call;
  if (name === 'prompts.get') return svc.promptEdit.get(args, check());
  if (name === 'chat.list') return svc.conversations.listThreads(id, check());
  // 看页面：模型说的记录（助手模块名）换回页面上的全站记录种类再交给页面，看到的快照换成助手模块名再交给模型
  if (name === 'page.observe')
    return svc.pageBridge
      .observe(observeForPage(args), {
        actor: run.actor,
        binding,
        clientId: input.pageClientId,
        threadId: id,
        requestId: input.requestId,
        check,
        signal,
        emit,
      })
      .then((seen) => (seen.snapshot ? { ...seen, snapshot: svc.tools.pageSnapshot(seen.snapshot) } : seen));
  if (svc.extras.handles(name)) return svc.extras.read(name, args, check());
  return svc.tools.readChecked(name, call, check(), {
    signal,
    // 联网只开用户给的、或这个会话里搜索返回过的网址
    allowedUrl: (url) => allowedUrl(svc.store, id, url),
    question: input.text || undefined,
  });
}

/** 直接执行的流程类命令做完以后：记进这一轮做了什么，导出的文件、识别任务的链接交给页面 */
function noteDirectResult(run: ChatRun, name: string, does: string | undefined, result: unknown) {
  const { facts, links, exports } = run;
  const task = field(result, 'task');
  // 识别没成（文件读不了、模型报错）：识别工具照常返回任务的状态，这里记成没做成，不算“已执行”
  if (FAILED_TASK_STATES.includes(field(task, 'state'))) facts.failed.push({ label: does ?? name, message: String(field(result, 'message') ?? '') });
  // 记住、改过的长期记忆带上编号：页面在这一项后面放“忘掉”
  else if (does) {
    const memoryId = field(field(result, 'memory'), 'id');
    facts.executed.push({ label: does, ...(typeof memoryId === 'number' ? { memoryId } : {}) });
  } else facts.reads++;
  const exportId = field(result, 'exportId');
  if (exportId) exports.push(result);
  const url = field(result, 'url');
  if (typeof url === 'string' && url && !exportId)
    links.push({ url, label: firstText([field(field(result, 'order'), 'number'), field(task, 'fileName')], '查看识别任务') });
}

/** 只读命令做完以后：打开页面、记下搜索到的网址和来源、结果里带的记录链接 */
function noteReadResult(svc: ChatServices, run: ChatRun, name: string, result: unknown) {
  run.facts.reads++;
  if (name === 'ui.open') run.emit('effect', { type: 'navigate', url: field(result, 'url') });
  if (name === 'web.search') noteSearchResult(svc.store, run.id, result);
  noteSources(run, name, result);
  for (const r of listField(result, 'results') ?? [result]) {
    const url = field(r, 'url'),
      record = field(r, 'record');
    if (typeof url === 'string' && url && record)
      run.links.push({ url, label: firstText([field(record, 'number'), field(record, 'name')], '查看业务记录') });
  }
}

/** signal：这一个命令的中止信号（用户点停止，或这个命令超时） */
function handlers(svc: ChatServices, run: ChatRun, signal: AbortSignal): ToolHandlers {
  const { binding, check, options } = run;
  const workflow = { ...run.workflow, signal };
  const planned = (name: string, call: CheckedCall) => {
    const plan = svc.tools.prepareChecked(name, call, check(), binding, { proxy: !!options.proxy });
    return proposeCard(svc, run, plan, svc.tools.stamp(plan, check()));
  };
  return {
    business: planned,
    workflow: async (name, call) => {
      const { args } = call;
      const write = workflowWrite(name, args, svc, workflow);
      if (write && 'planned' in write) return planned(name, call);
      if (write) return proposeCard(svc, run, cardPlan(name, args, await write.card(svc, workflow, args)), null);
      const direct = Object.hasOwn(WORKFLOW_DIRECT, name) ? WORKFLOW_DIRECT[name] : undefined;
      // 新加的流程类工具两张表都没登记：不执行（测试也会拦）
      if (!direct) throw new AppError('这个工具还没有登记是不是写入，不能执行。', 403, 'unknown-tool');
      const result = await direct.run(svc, workflow, args, name);
      noteDirectResult(run, name, typeof direct.does === 'function' ? direct.does(result) : direct.does, result);
      return result;
    },
    read: async (name, call) => {
      const result = await read(svc, run, name, call, signal);
      noteReadResult(svc, run, name, result);
      return result;
    },
  };
}

/** 出错时回给模型的原因：参数不对的逐项说哪个字段、为什么 */
function failureText(e: unknown, name: string) {
  if (e instanceof ZodError)
    return '参数不对：' + e.issues.map((i) => (i.path.length ? i.path.join('.') + ' ' : '') + i.message).join('；');
  return failureMessage(e, '助手工具 ' + name, '执行出错');
}

/** 这次调用是不是只出确认卡片：业务类全部是；流程类按 workflow-cards.ts 的登记（同一个判断，执行时也用它） */
function carded(svc: ChatServices, run: ChatRun, name: string, args: unknown, kind: ToolKind | undefined) {
  if (kind === 'business') return true;
  if (kind !== 'workflow') return false;
  try {
    return !!workflowWrite(name, args, svc, run.workflow);
  } catch {
    // 判断不了（比如这个会话还没有要改的识别任务）：照普通命令写，执行时会把原因交给模型
    return false;
  }
}

/** callId：这个调用的 tool_call_id。返回实际执行的命令名（走目录时是 run_command 里那条）和结果 */
async function runCall(svc: ChatServices, run: ChatRun, asked: ToolCall, callId: string): Promise<{ command: string; value: unknown }> {
  const { id, emit, check, controller, budget, facts, turn } = run;
  const current = check();
  budget.count('toolCalls');
  // 模型调的是通用工具时：找命令、查用法当场给结果；执行命令拆出里面那条，接着走同一条分派。直接调的常用命令原样往下走
  const unwrapped = unwrapCommand(turn.commands, asked);
  if ('done' in unwrapped) return { command: asked.name, value: unwrapped.done };
  if ('missing' in unwrapped) {
    facts.failed.push({ label: '执行命令', message: unwrapped.missing });
    return { command: asked.name, value: { ok: false, message: unwrapped.missing } };
  }
  const call = unwrapped.call;
  // 一句话里执行的命令和问模型的次数共用一个上限：到了以后，同一条回复里剩下的不执行
  if (facts.tools.length >= svc.budgetLimits.maxSteps)
    return { command: call.name, value: { ok: false, state: 'not_run', message: STEP_LIMIT_SKIPPED } };
  facts.tools.push(call.name);
  const definition = svc.registry.definition(call.name);
  // 状态行上写正在做什么：“正在联网搜索：……”；只出确认卡片的写“正在准备确认卡片：……”，不让人以为已经在改
  const named = commandLabel(definition?.description, call.name);
  const label = stepLabel(call, carded(svc, run, call.name, call.args, definition?.kind) ? '准备确认卡片：' + named : named);
  emit('tool', { name: call.name, state: 'running', label });
  // 开始执行之前记下“这个调用发出去了”并存一次（模型的这条回复、前面几个调用的结果也在这时落盘）：
  // 中途断了，回放时它是“查询中断”或“结果不明”，后面没轮到的是“没有执行”
  turn.started.set(callId, definition?.kind === 'read' ? 'read' : 'write');
  saveTurn(svc.store, id, turn, run.messages);
  // 一个命令最多执行这么久：到点中止它（会等的命令收到中止信号），把超时当成结果告诉模型，这一轮接着办
  const limit = svc.agent.session.toolTimeoutMs;
  const overtime = new AbortController();
  const signal = AbortSignal.any([controller.signal, overtime.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      overtime.abort();
      reject(new AppError(TOOL_TIMEOUT_NOTE, 504, 'tool-timeout'));
    }, limit);
  });
  try {
    const dispatched = await Promise.race([
      svc.registry.dispatch(call.name, call.args, current, handlers(svc, run, signal), { check, signal }),
      expired,
    ]);
    // 带执行函数的工具（查长期记忆）由注册表直接执行，都是只读的（tests/assistant-boundaries.test.ts 守着）
    if (definition?.execute) facts.reads++;
    emit('tool', { name: call.name, state: 'completed', label });
    return { command: call.name, value: dispatched.value };
  } catch (e) {
    // 用户点了停止、整轮超时：这一轮到此为止，不当成工具失败交给模型
    if (controller.signal.aborted) throw e;
    // 经 run_command 执行的命令参数不对：报错里带上这条命令的正确用法，模型照着改，不用再查一次（直接调的工具参数结构本来就在请求里）
    const message = failureText(e, call.name) + (e instanceof ZodError && call !== asked ? usageHint(turn.commands, call.name) : '');
    facts.failed.push({ label: named, message });
    svc.conversations.log(current, id, call.name, 'failed', { message, code: e instanceof AppError ? e.code : undefined });
    emit('tool', { name: call.name, state: 'failed', label });
    return { command: call.name, value: { ok: false, message } };
  } finally {
    clearTimeout(timer);
  }
}

/** 执行这条回复里的全部调用（按先后，一个一个来），每个结果接一条 tool 消息；最后接上“有调用没执行”的说明。 */
export async function runToolCalls(svc: ChatServices, run: ChatRun, reply: ModelReply) {
  const parameters = new Map(run.turn.commands.map((c) => [c.name, c.parameters]));
  for (const { call, id } of reply.calls) {
    // 翻页说明、截不截都按实际执行的那条命令（走目录时是 run_command 里那条）
    const { command, value: result } = await runCall(svc, run, call, id);
    // 自己控制了长度的命令（联网）不再截：截掉一半却还写着“还剩多少字、接着读传 offset”，前后对不上
    const capped = selfBoundedResults.includes(command)
      ? result
      : capToolResult(result, pageHint(parameters.get(command)), svc.agent.session.toolResultTokens);
    run.messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(capped) ?? 'null' });
  }
  if (reply.note) run.messages.push({ role: 'system', content: reply.note });
  saveTurn(svc.store, run.id, run.turn, run.messages);
}
