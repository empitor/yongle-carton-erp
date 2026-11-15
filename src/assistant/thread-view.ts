import { readSpeaker, type AssistantSpeaker, type MessageView, type ThreadView } from '../../shared/assistant/index';

/**
 * 从服务器给的会话数据推出聊天窗口要显示的东西：先显示刚发的话、某份方案在哪、
 * 核对区该换成哪一版、新回复要不要让说话的人跳一下。不依赖 React 和页面，测试里直接调。
 */

/**
 * 聊天里的一条消息：服务器给的（MessageView），或者刚发出、服务器还没回来的那句（只有编号、谁说的、字，见 withUserMessage）。
 * 所以除了这三项都可能没有。
 */
export type ChatMessage = Pick<MessageView, 'id' | 'role' | 'text'> & Partial<Omit<MessageView, 'id' | 'role' | 'text'>>;
/** 聊天窗口里的会话：服务器给的会话（ThreadView），末尾可能接着刚发出的那句 */
export type ChatThread = Omit<ThreadView, 'messages'> & { messages: ChatMessage[] };

/** 发送时先把人刚说的话接到聊天记录末尾显示（服务器回来后整份换掉） */
export function withUserMessage<T extends { messages: readonly object[] }>(thread: T, id: string, text: string): T {
  const sent: ChatMessage = { id, role: 'user', text };
  return { ...thread, messages: [...thread.messages, sent] };
}

/** 有卡片的消息：只看各条消息带的卡片 */
type WithPlans<P> = { messages?: readonly { plans?: readonly P[] }[] } | null;

/** 在聊天记录里找某份方案 */
export function findPlan<P extends { id?: string }>(thread: WithPlans<P>, previewId: string): P | undefined {
  return thread?.messages?.flatMap((m) => m.plans || []).find((p) => p.id === previewId);
}

/**
 * 核对区重新同步后显示哪一版：聊天里存的这份方案还在等确认就换成它；执行了、作废了、过期了或不在了返回 null（关掉核对区）。
 */
export function syncedReview<P extends { id?: string; state?: string }>(thread: WithPlans<P>, previewId: string): P | null {
  const latest = findPlan(thread, previewId);
  return latest?.state === 'waiting' ? latest : null;
}

/**
 * 新回复谁说的、气泡里写哪一句：接力的回复按最后一段的人；只取第一行，超过 28 个字截断。
 * 认不出说话人返回 null（不跳、不冒气泡）。
 */
const CUE_CHARS = 28;
export function replyCue(last: Pick<ChatMessage, 'speaker' | 'relay' | 'text'>): { speaker: AssistantSpeaker; line: string } | null {
  const part = last.relay?.at(-1);
  const who = readSpeaker(part?.speaker) ?? readSpeaker(last.speaker);
  if (!who) return null;
  const line = (part?.text ?? last.text).split('\n')[0];
  return { speaker: who, line: line.length > CUE_CHARS ? line.slice(0, CUE_CHARS) + '…' : line };
}

/** 最后一条是不是同一会话里新来的助手回复（刚打开的旧会话、自己发的话、没变的都不算） */
export function isNewReply(seen: { thread?: string; id?: string }, thread: { id: string }, last: { id: string; role: string }) {
  return seen.thread === thread.id && seen.id !== last.id && last.role === 'assistant';
}
