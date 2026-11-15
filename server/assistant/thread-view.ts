// 会话给页面看的样子（打开会话、一轮回复结束、同一请求重发时返回）：标题、识别任务、消息、附件、是否正在回复、AI 配置状态。
// 消息里存的原样记录（turn）只给模型回放用，不给页面；卡片确认、拒绝后的“接着办”那条用户消息不显示；卡片标上现在的状态。
// 样子写在 shared/assistant/assistant-views.ts（ThreadView、MessageView），接口表按它查。
import { many, parseStoredJson, rows } from '../core/index.js';
import type { Actor, Store } from '../core/index.js';
import type { AiSettingsManager } from '../ai/index.js';
import { storedMessageSchema, type MessageView, type ThreadView } from '../../shared/assistant/index.js';
import type { AssistantConversations } from './conversation.js';
import type { AssistantPreviews } from './previews.js';
import type { AssistantAttachments } from './attachments.js';
import type { AssistantOrderWorkflow } from './order-workflow.js';

type ThreadViewParts = {
  store: Store;
  conversations: AssistantConversations;
  previews: AssistantPreviews;
  attachments: AssistantAttachments;
  settings: AiSettingsManager;
  orderWorkflow?: AssistantOrderWorkflow;
};

const shownMessage = rows.assistant_messages
  .pick({ seq: true, id: true, role: true, text: true, document: true })
  .extend({ at: rows.assistant_messages.shape.created_at });

function messages(parts: ThreadViewParts, id: string, actor: Actor): MessageView[] {
  const cards = parts.previews.states(id);
  const stored = many(
    parts.store.db,
    shownMessage,
    'SELECT seq,id,role,text,document,created_at AS at FROM assistant_messages WHERE thread_id=? ORDER BY rowid',
    id,
  );
  return stored.flatMap(({ document, seq, ...r }) => {
    const { turn: _turn, hidden, plans, ...shown } = parseStoredJson(storedMessageSchema, document, `assistant_messages.document（第 ${seq} 行）`);
    if (hidden) return [];
    // 每张卡片现在的状态由服务器标上（chat/card-changes.ts 的 cardStates）
    const marked = plans ? { plans: plans.map((p) => ({ ...p, state: cards[p.id] })) } : {};
    return [{ ...r, ...shown, ...marked, attachments: parts.attachments.forMessage(r.id, actor) }];
  });
}

export function threadView(parts: ThreadViewParts, id: string, actor: Actor): ThreadView {
  const thread = parts.conversations.thread(id, actor);
  return {
    id,
    title: thread.title,
    orderWorkflow: parts.orderWorkflow?.view(id, actor),
    messages: messages(parts, id, actor),
    pendingAttachments: parts.attachments.pending(id, actor),
    previousAttachments: parts.attachments.previous(id, actor),
    busy: parts.conversations.busy.has(id),
    ai: parts.settings.status(),
  };
}
