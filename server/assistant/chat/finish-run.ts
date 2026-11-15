// 一轮对话的收尾。正常结束：模型最后的正文原样存成回复，旁边记上这一轮服务器实际做了什么（facts）、出的确认卡片、
// 可以跳转的链接；写运行记录，返回会话视图。出错结束（模型接口报错、被停止、超时）：模型说不了话，
// 服务器只写一句出了什么事，这一轮已经做了的照样记在 facts 里。最后不管怎样都清定时器、存这一轮的原样记录、清“正在回复”。
import { AppError, constraintFailure, inSavepoint, many, one, rows, type Store } from '../../core/index.js';
import { AiConnectionError } from '../../ai/index.js';
import { speakerForTools } from '../../../shared/assistant/index.js';
import { errorMessage } from '../../../shared/core/index.js';
import { hash } from './open-run.js';
import { asJson } from '../json-view.js';
import { noteShown, saveTurn } from './session-history.js';
import { trailOf } from './turn-trail.js';
import type { AssistantConversations } from '../conversation.js';
import type { AssistantPreviews } from '../previews.js';
import type { ChatRun, ChatServices, ModelReply } from './run-state.js';

const uniqueLinks = (links: ChatRun['links']) => [...new Map(links.map((l) => [l.url, l])).values()];

/** reachedLimit：这一轮到了步数上限，最后这段话是模型在不许再调工具的情况下自己说明的。 */
export function finishRun(svc: ChatServices, run: ChatRun, reply: ModelReply, reachedLimit: boolean) {
  const { id, actor, input, plans, links, exports, facts, budget, promptUsage } = run;
  // 模型没写是谁在说：按这一轮用到的工具归到小甬或小勒；都没有就沿用上一位（conversation.ts）
  const speaker = reply.speaker ?? run.speaker ?? speakerForTools(facts.tools);
  svc.conversations.message(id, 'assistant', reply.message, {
    ...(speaker ? { speaker } : {}),
    ...(reply.relay?.length ? { relay: reply.relay } : {}),
    ...trailOf(run),
    facts,
    plans,
    links: uniqueLinks(links),
    ...(exports.length ? { exports: exports.map(asJson) } : {}),
    promptUsage,
    requestId: input.requestId,
    ...(reachedLimit ? { limit: true } : {}),
  });
  svc.store.db
    .prepare("UPDATE assistant_runs SET state='completed',document=? WHERE id=?")
    .run(JSON.stringify({ inputHash: hash(input), budget: budget.view() }), input.requestId);
  return svc.view(id, actor);
}

export function failRun(svc: ChatServices, run: ChatRun, e: unknown): never {
  const { id, actor, input, controller, plans, links, facts, budget, deadline } = run;
  let message: string;
  if (controller.signal.aborted) message = deadline.expired ? '这一轮超时了，已经停下。' : '已停止回复。';
  else if (e instanceof AiConnectionError)
    message = e.code === 'response' ? 'AI 服务没有返回可用的回复。' + (e.message ? '\n' + e.message : '') : e.message;
  else if (e instanceof AppError) message = e.message;
  else message = constraintFailure(e, '助手回复') ?? '这一轮出错了，没有办完。';
  svc.conversations.log(actor, id, 'assistant.reply', 'failed', {
    error: e instanceof Error ? e.constructor.name : typeof e,
    code: e instanceof AiConnectionError ? e.code : undefined,
    noteKind: e instanceof AiConnectionError ? e.responseNote?.kind : undefined,
    messageChars: message.length,
  });
  svc.conversations.message(id, 'assistant', message, {
    ...(run.speaker ? { speaker: run.speaker } : {}),
    ...trailOf(run),
    facts,
    plans,
    links: uniqueLinks(links),
    error: true,
    requestId: input.requestId,
  });
  svc.store.db
    .prepare("UPDATE assistant_runs SET state='failed',document=? WHERE id=?")
    .run(JSON.stringify({ message, inputHash: hash(input), budget: budget.view() }), input.requestId);
  throw new AppError(message, e instanceof AppError ? e.status : 422);
}

export const RESTARTED_TEXT = '程序中途重启了，这一轮没有办完。前面做到哪一步都记着，接着说就行。';
/**
 * 进程中断留下的没收尾的轮（启动时调一次）：运行记录标成失败；会话里补一句，人和模型下次都看得到这一轮断在半路；
 * 那一轮出了、还没来得及显示的确认卡片作废。每一步的原样记录当时已经存了（session-history.ts），这里不用补。
 */
export function recoverRuns(store: Store, conversations: AssistantConversations, previews: AssistantPreviews) {
  const runs = many(store.db, rows.assistant_runs.pick({ id: true, thread_id: true }), "SELECT id,thread_id FROM assistant_runs WHERE state='running'");
  for (const run of runs)
    try {
      // 一个会话一个回滚点：做到一半出错的不留半截
      inSavepoint(store.db, () => recoverRun(store, conversations, previews, run));
    } catch (e) {
      // 一个会话读不出来（比如库里的消息坏了）不拦着别的会话收尾、不拦着助手启动；这一轮留着，记一行日志等人查
      console.error('[助手] 启动时收尾中断的一轮没做成，会话 ' + run.thread_id + '：' + errorMessage(e));
    }
}

/** 收尾一轮：会话里补一句、记下给模型看的说明、作废没显示的卡片、运行记录标成失败 */
function recoverRun(
  store: Store,
  conversations: AssistantConversations,
  previews: AssistantPreviews,
  run: { id: string; thread_id: string },
) {
  const threadId = run.thread_id;
  const last = one(
    store.db,
    rows.assistant_messages.pick({ seq: true, role: true }),
    'SELECT seq,role FROM assistant_messages WHERE thread_id=? ORDER BY seq DESC LIMIT 1',
    threadId,
  );
  // 最后一条不是用户的话：这一轮里清空过会话，没有可接的地方
  if (last?.role === 'user') {
    conversations.message(threadId, 'assistant', RESTARTED_TEXT, { error: true, requestId: run.id });
    noteShown(store, last.seq, RESTARTED_TEXT);
  }
  previews.cancelUnshown(threadId);
  store.db
    .prepare("UPDATE assistant_runs SET state='failed',document=json_set(document,'$.message',?) WHERE id=?")
    .run(RESTARTED_TEXT, run.id);
}

export function closeRun(svc: ChatServices, run: ChatRun) {
  const { id, deadline } = run;
  clearTimeout(deadline.timer);
  // 这一轮的原样记录存进会话历史，下一轮照原样回放（session-history.ts）
  try {
    saveTurn(svc.store, id, run.turn, run.messages);
  } catch (e) {
    svc.conversations.log(run.actor, id, 'assistant.history', 'save-failed', {
      error: errorMessage(e),
    });
  }
  svc.conversations.busy.delete(id);
}
