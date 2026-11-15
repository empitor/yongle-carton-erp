// 问模型一次：对话太长先压缩（compact-run.ts）；发原生工具调用的请求；流式时把说话人、正文（整段替换的 draft）、
// 思考内容（reasoning 事件，界面折叠显示，不存库）发给页面；回来的助手消息原样追加进对话
// （含思考内容，以后每次请求都原样回传）。名字没声明过、参数不是 JSON 的调用从助手消息里拿掉，用 system 消息告诉模型。
// 接口报上下文超长时强制压缩一次再问；报附件文件失效时，失效的那几份从本地原件重传后再问（每份一次请求里只重传一次）。final：步数到上限后的最后一次，不许调工具，让模型自己说明做到哪。
// 断线、上游出错、长时间没有新内容、空回复由 AI 接入层自动原样重发（server/ai/chat-retry.ts）：重发前这里把页面上那段没收全的字清掉。
import { AppError } from '../../core/index.js';
import { AiConnectionError } from '../../ai/index.js';
import { compactRun } from './compact-run.js';
import { readModelReply, readSpeakerMarks } from './model-reply.js';
import { hydrateImages, requeueInvalid, uploadPending } from './model-attachments.js';
import type { ChatRun, ChatServices, ModelReply } from './run-state.js';

/** 步数到上限时给模型的话：由它用自己的话收尾，服务器不替它说。 */
export const STEP_LIMIT_NOTE =
  '服务器：这一轮已经到了步数上限，不能再调用工具。请用平常的话告诉用户：已经做了什么、还差什么、卡在哪里，需要用户做什么。不要提工具名和这条说明。';

async function request(svc: ChatServices, run: ChatRun, round: number, final: boolean) {
  const { id, actor, emit, controller, messages, budget, turn } = run;
  await uploadPending(svc, actor, messages, turn, controller.signal);
  await compactRun(svc, run);
  let text = '';
  let speakerSent = false;
  budget.count('modelCalls');
  return svc.settings.completeChatTools(hydrateImages(svc, actor, messages), turn.tools, controller.signal, {
    thinking: turn.thinking,
    ...(final ? { toolChoice: 'none' as const } : {}),
    userKey: actor.id,
    onUsage: (v) => budget.providerUsage(v),
    onDiagnostic: (d) => svc.conversations.log(actor, id, 'provider.diagnostic', d.stage, d),
    onProgress: (p) => emit('progress', p),
    onQueue: (q) => emit('queue', q),
    onReasoningDelta: (delta) => emit('reasoning', { round: round + 1, text: delta }),
    onRetry: (attempt, error) => {
      text = '';
      speakerSent = false;
      emit('draft', { text: '' });
      emit('progress', { stage: 'retrying', attempt });
      svc.conversations.log(actor, id, 'assistant.retry', error.code, { attempt, round: round + 1, note: error.responseNote?.kind });
    },
    onTextDelta: (delta) => {
      text += delta;
      // 说话人标记还没收全时先不发
      if (/^\s*【[^】]*$/.test(text)) return;
      const marks = readSpeakerMarks(text);
      if (!speakerSent && marks.speaker) {
        speakerSent = true;
        emit('speaker', { speaker: marks.speaker });
      }
      if (marks.message) emit('draft', { text: marks.message });
    },
  });
}

/**
 * 问一次模型；接口说附件失效了按原件重传一次、说上下文超长强制压一次再问，别的出错原样抛出。
 */
async function requestRecovering(svc: ChatServices, run: ChatRun, round: number, final: boolean) {
  const { controller, messages, turn } = run;
  let result: Awaited<ReturnType<typeof request>> | undefined;
  const reuploaded = new Set<string>();
  while (!result) {
    try {
      result = await request(svc, run, round, final);
    } catch (e) {
      if (controller.signal.aborted) throw new AppError('已停止回复。', 409);
      if (!(e instanceof AiConnectionError)) throw e;
      if (e.invalidFileIds) {
        const r = requeueInvalid(messages, turn, e.invalidFileIds, reuploaded);
        if (!r.stuck) continue;
        if (r.name) throw new AiConnectionError(e.code, `附件《${r.name}》在 DeepSeek 那边失效了，从原件重新上传以后还是用不了。`, e.status);
        throw e;
      }
      // 接口说上下文超长（估算偏小，或者前面的压缩没做成）：强制压一次，对话确实变短了才再问，只做一次
      if (!(e.code === 'too_large' && e.upstreamStatus === 400) || run.overflowRecovered) throw e;
      run.overflowRecovered = true;
      if (!(await compactRun(svc, run, true))) throw e;
    }
  }
  return result;
}

export async function askModel(svc: ChatServices, run: ChatRun, round: number, final = false): Promise<ModelReply> {
  const { id, emit, check, messages, turn } = run;
  check();
  if (final) messages.push({ role: 'system', content: STEP_LIMIT_NOTE });
  emit('progress', { stage: 'model', round: round + 1 });
  const result = await requestRecovering(svc, run, round, final);
  const { reply, rejected } = readModelReply(result, turn.registryName);
  if (reply.speaker) run.speaker = reply.speaker;
  const dropped = new Set(rejected.map((r) => r.id));
  const { tool_calls: calls, ...rest } = result.assistantMessage;
  const kept = (calls ?? []).filter((c) => !dropped.has(c.id));
  messages.push(
    dropped.size ? { ...rest, content: rest.content ?? '', ...(kept.length ? { tool_calls: kept } : {}) } : result.assistantMessage,
  );
  for (const r of rejected) run.facts.failed.push({ label: r.name, message: r.reason });
  svc.conversations.log(check(), id, 'assistant.reply', 'parsed', {
    chars: reply.message.length,
    tools: reply.calls.map((c) => c.call.name),
    rejected: rejected.length,
    round: round + 1,
    finish: result.finishReason,
    reasoningChars: result.reasoning.length,
  });
  return { ...reply, ...(rejected.length ? { note: rejectedNote(rejected) } : {}) };
}

const rejectedNote = (rejected: { name: string; reason: string }[]) =>
  '服务器：这几个调用没有执行——' + rejected.map((r) => `${r.name}：${r.reason}`).join('；') + '。只能调用提供的工具，参数要是 JSON 对象。';
