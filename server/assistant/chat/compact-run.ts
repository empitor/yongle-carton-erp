// 发请求前看这一轮的对话要不要压缩（算法在 compact.ts），压了就原地换掉 run.messages 前面那一段、当场存进会话历史。
// 摘要请求和正常请求走同一个接口：同一份系统消息、同一份 tools、同一个思考档位，只是不许调工具、正文不流给页面。
// 写摘要出错只记一笔，这一轮照常继续；用户点了停止就停。
import type { ToolChatMessage } from '../../ai/index.js';
import { compactMessages } from './compact.js';
import { hydrateImages } from './model-attachments.js';
import type { ChatRun, ChatServices } from './run-state.js';
import { saveTurn } from './session-history.js';
import { estimateTokens } from './session-limits.js';

/** force：接口明确报了上下文超长，不管到没到线都压一次。对话变短了返回 true。 */
export async function compactRun(svc: ChatServices, run: ChatRun, force = false) {
  const { id, actor, emit, check, controller, messages, budget, turn } = run;
  const result = await compactMessages(
    messages,
    turn.headLength,
    svc.agent.session,
    {
      measure: (m) => estimateTokens(JSON.stringify(m)),
      overhead: estimateTokens(JSON.stringify(turn.tools)),
      summarize: async (request: ToolChatMessage[]) => {
        emit('progress', { stage: 'compacting' });
        budget.count('modelCalls');
        const reply = await svc.settings.completeChatTools(hydrateImages(svc, actor, request), turn.tools, controller.signal, {
          thinking: turn.thinking,
          toolChoice: 'none',
          userKey: actor.id,
          onUsage: (v) => budget.providerUsage(v),
          onDiagnostic: (d) => svc.conversations.log(actor, id, 'provider.diagnostic', d.stage, d),
          onQueue: (q) => emit('queue', q),
        });
        return reply.content;
      },
    },
    force,
  );
  // 用户点了停止：这一轮停下，压到一半的不采用
  check();
  const changed = result.pruned > 0 || result.summaries > 0;
  if (changed) {
    const messagesBefore = messages.length;
    messages.splice(0, messages.length, ...result.messages);
    // 历史并进这一轮的记录：历史里的上传文件一起带过来（这一轮记下的优先，比如刚标成失效的）
    Object.assign(turn.uploaded, { ...turn.historyFiles, ...turn.uploaded });
    turn.restart = result.checkpoint === undefined ? (turn.restart ?? {}) : { checkpoint: result.checkpoint };
    saveTurn(svc.store, id, turn, messages);
    svc.conversations.log(actor, id, 'assistant.compaction', result.summaries ? 'done' : 'pruned', {
      before: result.before,
      after: result.after,
      pruned: result.pruned,
      summaries: result.summaries,
      messagesBefore,
      messagesAfter: messages.length,
      forced: force,
    });
  }
  if (result.failure)
    svc.conversations.log(actor, id, 'assistant.compaction', 'failed', {
      before: result.before,
      after: result.after,
      forced: force,
      error: result.failure instanceof Error ? result.failure.message : String(result.failure),
    });
  return changed;
}
