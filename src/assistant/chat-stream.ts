import type { AssistantSpeaker, InterimSaid, ThreadView, TurnFacts } from '../../shared/assistant/index';
import type { ReasoningPart } from './assistant-types';
import { chatEvent, type ChatEffect, type ChatProgress } from './chat-events';

/**
 * 一次回复里的事件：把每条事件分给对应的处理、出错时给人看的说法（读事件流在 src/ui/event-stream.ts）。
 * 不依赖 React 和页面，测试里直接调。
 */

/** 回复读到一半断了（网断、连接被关）、没收到最终结果：服务器可能已经办了，让人先看历史再决定要不要重发 */
export const replyInterrupted = '回复连接中断，请重新载入历史核实执行结果，避免重复提交。';

/** 回复流里各种事件交给谁处理 */
export type ChatEventHandlers = {
  /** “看一眼页面”的命令：内容由执行它的 assistant-page.ts 认 */
  pageCommand: (d: unknown) => void;
  effect: (d: ChatEffect) => void;
  /** 谁在说（认不出是 undefined） */
  speaker: (who: AssistantSpeaker | undefined) => void;
  draft: (text: string) => void;
  /** 模型调命令前先说的那段话（排在“正在处理”上面，正在生成的那段清掉） */
  said: (d: InterimSaid) => void;
  /** 思考内容的增量 */
  reasoning: (round: number, text: string) => void;
  /** 每条进度事件原样给一份（思考了多少字从这里来） */
  modelProgress: (d: ChatProgress) => void;
  /** step：这一行说的是正在跑的命令（思考中也要看得到） */
  progress: (text: string, step: boolean) => void;
  /** 最后的整份会话：readEventStream 读完交回，不经 routeChatEvent */
  result: (thread: ThreadView) => void;
  /** 服务器说这一轮失败了（说明随后由 readEventStream 抛出） */
  error: (message: string | undefined) => void;
};

/** 排队、生成、跑命令时状态行写什么；不改这一行的事件返回 undefined */
export function chatProgressText(event: string, d: unknown): string | undefined {
  if (event === 'queue') return queueText(chatEvent.queue(d));
  if (event === 'progress') return progressText(chatEvent.progress(d));
  // 命令的叫法由服务器给（“联网搜索：……”“读网页：……”）
  if (event === 'tool') {
    const tool = chatEvent.tool(d);
    return tool.state === 'running' ? '正在' + String(tool.label) + '…' : '正在整理结果…';
  }
  return undefined;
}
function queueText(q: ReturnType<typeof chatEvent.queue>) {
  if (q.state === 'running') return '正在生成…';
  if (q.state === 'backoff') return 'API限流，退避等待中…';
  return '等待AI空闲连接 · 排队 ' + String(q.position);
}
function progressText(p: ChatProgress) {
  if (p.stage === 'retrying') return 'AI 连接中断，正在重发（第 ' + String(p.attempt) + ' 次）…';
  if (p.stage === 'thinking') return '正在思考…';
  return '正在处理 · ' + (p.receivedChars || 0) + ' 字符';
}

/** 把一条已解析的事件分给对应的处理（result 不在这里：readEventStream 读完交回整份会话） */
export function routeChatEvent(event: string, d: unknown, on: ChatEventHandlers) {
  if (event === 'page_command') on.pageCommand(d);
  if (event === 'effect') on.effect(chatEvent.effect(d));
  if (event === 'speaker') on.speaker(chatEvent.speaker(d));
  if (event === 'draft') on.draft(chatEvent.draft(d));
  if (event === 'said') on.said(chatEvent.said(d));
  if (event === 'reasoning') {
    const r = chatEvent.reasoning(d);
    on.reasoning(r.round || 1, r.text ?? '');
  }
  if (event === 'progress') on.modelProgress(chatEvent.progress(d));
  const progress = chatProgressText(event, d);
  if (progress !== undefined) on.progress(progress, event === 'tool');
  if (event === 'error') on.error(chatEvent.error(d));
}

/** 下面几个看聊天记录的函数要用的几项（服务器给的会话、页面上刚接上的那句都有） */
type SeenThread = {
  messages: readonly { role?: string; text?: string; facts?: Pick<TurnFacts, 'executed'> }[];
  orderWorkflow?: { activeId?: string; tasks: readonly { id: string; workspaceId: string }[] };
};

/**
 * 收到最终结果后页面要跟着做的事：这一轮服务器执行过什么（识别、改识别结果、备份……）就通知各页面刷新；
 * 订单导入里正在办的那份也通知它的工作区。人点确认执行的卡片在点的那一刻已经通知过（useAssistantReview.ts）。
 */
export function replyFollowUps(d: SeenThread) {
  const did = !!d.messages.at(-1)?.facts?.executed.length;
  const activeTask = d.orderWorkflow?.tasks.find((t) => t.id === d.orderWorkflow?.activeId);
  return {
    businessChanged: did,
    workspace: activeTask && did ? { workspaceId: activeTask.workspaceId } : null,
  };
}

/** 一次发送失败时给人看的话：账号切换、主动停止、等太久各有说法，别的照原错误 */
export function chatFailureText(e: Error, accountSwitched: boolean) {
  return accountSwitched
    ? '账号已切换，旧请求已停止。'
    : e.name === 'AbortError'
      ? '已停止回复；可重新载入历史查看最终状态。'
      : e.name === 'TimeoutError'
        ? '等了太久没收到回复，请重新载入历史核实执行结果，避免重复提交。'
        : e.message;
}

/** 没收全的那半截回复，重新载入的聊天记录里已经有了（按前 40 个字找），就不用再单独显示 */
const PARTIAL_PROBE_CHARS = 40;
export function partialAlreadySaved(thread: SeenThread | null, partial: string) {
  return !!(
    partial &&
    thread?.messages.some(
      (m) => m.role === 'assistant' && String(m.text).includes(partial.slice(0, PARTIAL_PROBE_CHARS)),
    )
  );
}

/** 思考内容的增量接上去：同一轮接在最后一段后面，换了一轮就另起一段 */
export function appendReasoning(
  parts: ReasoningPart[],
  round: number,
  text: string,
): ReasoningPart[] {
  if (!text) return parts;
  const last = parts.at(-1);
  if (last && last.round === round)
    return [...parts.slice(0, -1), { round, text: last.text + text }];
  return [...parts, { round, text }];
}

/** 折叠里显示的思考内容：每轮一段，段与段之间空一行 */
export const reasoningText = (parts: ReasoningPart[]) => parts.map((p) => p.text).join('\n\n');

/** “正在思考 · N 字”的 N：各轮思考内容的字数合计 */
export const reasoningChars = (parts: ReasoningPart[]) =>
  parts.reduce((n, p) => n + p.text.length, 0);

/** 思考了多少字：进度事件里的 reasoningChars 是这一轮模型调用的字数，新一轮（stage: model）开始时把上一轮的并进 done */
export type ThinkingCount = { done: number; current: number };
export function countThinking(c: ThinkingCount, d: Pick<ChatProgress, 'stage' | 'reasoningChars'>): ThinkingCount {
  if (d.stage === 'model') return { done: c.done + c.current, current: 0 };
  if (typeof d.reasoningChars === 'number') return { done: c.done, current: d.reasoningChars };
  return c;
}
