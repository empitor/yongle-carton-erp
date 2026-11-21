// 一轮对话的开头：核对输入、同一请求重发时直接给结果、核对 AI 配置、选附件、预读页面上选中的记录、
// 记下用户这句话（卡片确认或拒绝后的“接着办”记一条不显示的）、改会话标题、组装发给模型的对话，
// 最后登记“正在回复”、写运行记录、建用量记账。这些步骤出错时还没开始回复，不做收尾。
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, exists, inSavepoint, one, parseStoredJson, rows } from '../../core/index.js';
import type { Actor } from '../../core/index.js';
import type { AssistantAttachment } from '../../../shared/core/index.js';
import { financeOnlyAccount } from '../../../shared/core/index.js';
import { AgentExecutionBudget } from '../budget.js';
import type { WorkflowContext } from '../order-import-state.js';
import { parseChatInput, type ChatInput } from './input.js';
import { ATTACHMENT_ONLY_TEXT, buildModelMessages } from './model-context.js';
import { chooseThinking } from './thinking.js';
import { capToolResult } from './tool-result-cap.js';
import type { ChatRun, ChatServices } from './run-state.js';
import type { ThreadView } from '../../../shared/assistant/index.js';

export type OpenRunArgs = {
  id: string;
  raw: unknown;
  actor: Actor;
  binding: string;
  emit: (event: string, data: unknown) => void;
  liveActor: () => Actor | null;
  options: { proxy?: boolean };
};

export const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** 运行记录 document 里核对重发用的：这次输入的指纹（开头写进去，收尾 finish-run.ts 照样带上） */
const storedRun = z.object({ inputHash: z.string() });
/** 会话标题取用户这句话的前多少字 */
const TITLE_CHARS = 40;

/** 不显示的那条“接着办”用户消息存的字（固定的，不带卡片内容）；stale 是人点了确认、但数据变了被服务器作废的 */
const CARD_TURN_TEXT = { confirmed: '（在确认卡片上点了确认）', rejected: '（在确认卡片上点了拒绝）', stale: '（在确认卡片上点了确认，但数据已经变了，卡片作废）' } as const;

/** 卡片现在的样子：方案的标题、被服务器作废的原因（previews.ts 写在 document 里）、执行结果、有效期 */
const cardRow = rows.assistant_previews
  .pick({ result: true, expires_at: true })
  .extend({ label: z.string().nullable(), stale: z.unknown().optional() });

/**
 * 人刚在卡片上点了确认或拒绝：读出这张卡片现在的样子，写成交给模型的那句话。
 * 只认这个会话、这个账号的卡片；说“确认了”的必须真有执行结果，说“拒绝了”的必须真的作废了、没执行。
 */
function cardTurn(svc: ChatServices, threadId: string, actor: Actor, card: NonNullable<ChatInput['card']>) {
  const row = one(
    svc.store.db,
    cardRow,
    "SELECT json_extract(document,'$.plan.label') AS label,json_extract(document,'$.stale') AS stale,result,expires_at FROM assistant_previews WHERE id=? AND thread_id=? AND user_id=?",
    card.id,
    threadId,
    actor.id,
  );
  if (!row) throw new AppError('这张确认卡片不在了。', 404);
  // 一张卡片的结果只交给模型一次
  if (exists(svc.store.db, "SELECT 1 FROM assistant_messages WHERE thread_id=? AND role='user' AND json_extract(document,'$.card.id')=?", threadId, card.id))
    throw new AppError('这张卡片的结果已经交给助手了。', 409);
  const label = row.label ?? '';
  if (card.decision === 'confirmed') {
    if (row.result == null) throw new AppError('这张卡片还没有执行。', 409);
    const executed = parseStoredJson(z.unknown(), row.result, `assistant_previews.result（卡片 ${card.id}）`);
    const result = capToolResult(executed, '', svc.agent.session.toolResultTokens);
    return {
      label,
      executed: true,
      text: CARD_TURN_TEXT.confirmed,
      note: `服务器：用户在确认卡片上点了确认，已经执行：${label}。执行结果：${JSON.stringify(result)}。请按这个结果接着办剩下的步骤，办完告诉用户结果。`,
    };
  }
  if (row.result != null) throw new AppError('这张卡片已经执行过了。', 409);
  if (row.expires_at !== 0) throw new AppError('这张卡片还没有点“不执行”。', 409);
  // 人点了确认、但出卡片以后数据变了，服务器拦下作废的（previews.ts）：不是人拒绝的，让助手按最新数据重新出一张
  const { stale } = row;
  if (typeof stale === 'string' && stale)
    return { label, executed: false, text: CARD_TURN_TEXT.stale, note: `服务器：用户点了确认，但没有执行：${label}。${stale}先重新读相关记录，再出一张新卡片。` };
  return {
    label,
    executed: false,
    text: CARD_TURN_TEXT.rejected,
    note: `服务器：用户在确认卡片上点了拒绝，没有执行：${label}。不要原样再出这张卡片；问用户想怎么改，或者这件事就不做了。`,
  };
}

/** 同一请求重发：核对是同一个人、同一个会话、同一份输入，返回会话视图；没有这个请求返回 undefined */
function replayed(svc: ChatServices, id: string, actor: Actor, input: ChatInput) {
  const existing = one(svc.store.db, rows.assistant_runs, 'SELECT * FROM assistant_runs WHERE id=?', input.requestId);
  if (!existing) return undefined;
  const stored = parseStoredJson(storedRun, existing.document, `assistant_runs.document（请求 ${existing.id}）`);
  if (existing.user_id !== actor.id || existing.thread_id !== id || stored.inputHash !== hash(input))
    throw new AppError('请求凭据已用于其他会话。', 409);
  if (existing.state === 'running') throw new AppError('该消息仍在生成，不会重复调用API。', 409);
  return { replayed: svc.view(id, actor) };
}

/** 停止和超时共用的中断开关；到点时 deadline.expired 改成 true */
function startDeadline(timeoutMs: number) {
  const controller = new AbortController();
  const deadline: ChatRun['deadline'] = { expired: false };
  deadline.timer =
    timeoutMs > 0
      ? setTimeout(() => {
          deadline.expired = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  deadline.timer?.unref();
  return { controller, deadline };
}

/** 记下用户这句话（卡片确认或拒绝后的“接着办”记一条不显示的）并关联附件，新会话用这句话起标题；返回消息编号 */
function saveUserTurn(
  svc: ChatServices,
  run: { id: string; actor: Actor; input: ChatInput; files: AssistantAttachment[]; titled: boolean },
  card: ReturnType<typeof cardTurn> | undefined,
  keepFiles: boolean,
) {
  const { id, actor, input, files } = run;
  let userMessageId = '';
  inSavepoint(svc.store.db, () => {
    userMessageId = card
      ? svc.conversations.message(id, 'user', card.text, { hidden: true, card: input.card })
      : svc.conversations.message(id, 'user', input.text || ATTACHMENT_ONLY_TEXT, { context: input.context });
    svc.attachments.bind(userMessageId, keepFiles ? files : [], id, actor);
  });
  if (!run.titled && !input.card)
    svc.store.db
      .prepare('UPDATE assistant_threads SET title=? WHERE id=?')
      .run((input.text || '附件：' + files.map((f) => f.name).join('、')).slice(0, TITLE_CHARS), id);
  return userMessageId;
}

/** 核对没有被停止、登录身份和权限没变，返回当前身份 */
const liveCheck = (controller: AbortController, liveActor: () => Actor | null, actor: Actor) => () => {
  if (controller.signal.aborted) throw new AppError('已停止回复。', 409);
  const current = liveActor();
  if (!current || current.id !== actor.id || hash(current.permissions) !== hash(actor.permissions))
    throw new AppError('登录身份或权限已变化，停止工具调用。', 403);
  return current;
};

/** 登记“正在回复”、写运行记录、建用量记账（用量每次变了写回运行记录） */
function startRunRecord(svc: ChatServices, id: string, actor: Actor, input: ChatInput, controller: AbortController) {
  svc.conversations.busy.set(id, controller);
  const document: z.input<typeof storedRun> = { inputHash: hash(input) };
  svc.store.db
    .prepare('INSERT INTO assistant_runs(id,thread_id,user_id,state,document,created_at) VALUES(?,?,?,?,?,?)')
    .run(input.requestId, id, actor.id, 'running', JSON.stringify(document), new Date().toISOString());
  return new AgentExecutionBudget(svc.budgetLimits, input.requestId, (v) => {
    svc.store.db
      .prepare("UPDATE assistant_runs SET document=json_set(document,'$.budget',json(?)) WHERE id=? AND user_id=? AND thread_id=?")
      .run(JSON.stringify(v), input.requestId, actor.id, id);
  });
}

/** 从识别导入页进来时，那份工作区的编号 */
const sourceWorkspaceId = (input: ChatInput) =>
  input.context?.page.startsWith('#ai-import?')
    ? new URLSearchParams(input.context.page.split('?')[1]).get('workspace') || undefined
    : undefined;

/** 出纳只看财务：页面上选中的业务记录不预读进提示词（页面报的记录种类都是业务记录）。 */
function selectedRecord(svc: ChatServices, input: ChatInput, actor: Actor): unknown {
  const context = input.context;
  return context?.id && context.module && !financeOnlyAccount(actor) ? svc.tools.pageRecord(context.module, context.id, actor) : null;
}

/** 同一请求已经回复过时返回 { replayed: 会话视图 }，否则返回建好的这一轮状态。 */
export function openRun(svc: ChatServices, args: OpenRunArgs): { replayed: ThreadView } | ChatRun {
  const { id, raw, actor, binding, emit, liveActor, options } = args;
  const thread = svc.conversations.thread(id, actor),
    input = parseChatInput(raw);
  const again = replayed(svc, id, actor, input);
  if (again) return again;
  if (svc.conversations.busy.has(id)) throw new AppError('本会话正在生成，请等待或停止。', 409);
  if (!svc.settings.status().ready) throw new AppError(svc.settings.status().message, 400, 'key_required');
  const files = svc.attachments.select(id, input.attachmentIds, input.usePreviousAttachments, actor),
    workflow = svc.orderWorkflow.view(id, actor);
  const card = input.card ? cardTurn(svc, id, actor, input.card) : undefined;
  if (!card && !input.text && !files.length) throw new AppError('请输入消息或选择附件。');
  const selected = selectedRecord(svc, input, actor);
  const { controller, deadline } = startDeadline(svc.budgetLimits.timeoutMs);
  const keepFiles = !(workflow.tasks.length && !input.attachmentIds.length);
  const userMessageId = saveUserTurn(svc, { id, actor, input, files, titled: thread.title !== '新会话' }, card, keepFiles);
  const check = liveCheck(controller, liveActor, actor);
  const thinking = chooseThinking(svc.registry, actor, input.thinking);
  const { messages, promptUsage, turn } = buildModelMessages(svc, {
    id,
    actor,
    input,
    files,
    workflow,
    selectedRecord: selected,
    thinking,
    userMessageId,
    cardNote: card?.note,
  });
  const budget = startRunRecord(svc, id, actor, input, controller);
  const workflowContext: WorkflowContext = {
    consumeModel: () => budget.count('modelCalls'),
    onUsage: (usage) => budget.providerUsage(usage),
    sourceWorkspaceId: sourceWorkspaceId(input),
    threadId: id,
    actor,
    requestId: input.requestId,
    files,
    check,
    signal: controller.signal,
    emit,
  };
  return {
    id,
    actor,
    binding,
    emit,
    options,
    input,
    files,
    controller,
    deadline,
    check,
    workflow: workflowContext,
    messages,
    turn: { ...turn, thinking, userMessageId, uploaded: {}, started: new Map() },
    promptUsage,
    budget,
    // 人刚确认的那张卡片算这一轮“已执行”的（执行在点确认的那一刻，这一轮是把结果交给模型接着办）
    facts: { tools: [], reads: 0, cards: [], executed: card?.executed ? [{ label: card.label }] : [], failed: [] },
    plans: [],
    links: [],
    exports: [],
    interim: [],
    sources: new Map(),
    overflowRecovered: false,
  };
}
