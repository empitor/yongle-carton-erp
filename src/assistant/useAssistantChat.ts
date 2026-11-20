import { useRef, useState, type RefObject } from 'react';
import { emit, readAuthState, readEventStream, type FileSaver } from '../ui/index';
import { AI_HTTP_TIMEOUT_MS, type DeepSeekThinking } from '../../shared/ai/index';
import { errorMessage } from '../../shared/core/index';
import type { AssistantSpeaker, InterimSaid, ThreadView } from '../../shared/assistant/index';
import { cancelReply, postChat, type AssistantState } from './assistant-api';
import { chatFailureText, partialAlreadySaved, replyInterrupted, routeChatEvent } from './chat-stream';
import { chatRequestBody, replyHandlers } from './chat-reply';
import { withUserMessage, type ChatThread } from './thread-view';
import { useReasoning } from './useReasoning';
import type { AssistantUploads, CardDecision } from './assistant-types';

/** 一次回复最多等多久：模型单次请求的上限乘这么多倍（一轮里要问模型、跑命令好几次） */
const REPLY_TIMEOUT_ROUNDS = 9;
/** 没选过、服务器也没存时的思考档位 */
const DEFAULT_THINKING: DeepSeekThinking = 'high';

type ChatOptions = {
  userId: string | undefined;
  userRef: RefObject<string | undefined>;
  thread: ChatThread | null;
  threadRef: RefObject<ChatThread | null>;
  /** 助手状态（GET /assistant）：AI 能不能用、这个账号存的思考档位 */
  assistant: AssistantState | null;
  setThread: (next: ChatThread) => void;
  ensureThread: () => Promise<ChatThread>;
  loadState: () => Promise<AssistantState>;
  loadThread: (id: string) => Promise<ThreadView | null>;
  uploads: AssistantUploads;
  /** 正在录音或识别时不发送 */
  speechActive: () => boolean;
  includePrevious: boolean;
  setError: (message: string) => void;
  /** 聊天记录是不是停在最底下；发送时拉回底部 */
  atBottom: RefObject<boolean>;
  /** 回复里带下载文件时用它保存（useSaveFile） */
  saveFile: FileSaver;
};

/**
 * 发一句话（或者把卡片确认、拒绝的结果交给助手接着办）、收一次回复：输入框的字、状态行、谁在说、调命令前先说的话、半截回复、没收全的回复；
 * 发请求、按事件更新界面（读流用 src/ui 的 readEventStream，分事件在 chat-stream.ts，发的内容和每种事件怎么处理在 chat-reply.ts）、出错时重新载入核实；停止回复。
 */
export function useAssistantChat(o: ChatOptions) {
  const s = useChatState();
  const reasoning = useReasoning();
  // 思考档位：选了先记在页面上，下一句话带给服务器（服务器记成这个账号的默认）
  const [thinkingChoice, setThinkingChoice] = useState<DeepSeekThinking | null>(null);
  const send = (override?: string, card?: CardDecision) =>
    sendChat({ o, s, reasoning, thinking: thinkingChoice }, override, card);
  /** 停止回复：断开这次请求，并告诉服务器别再往下办 */
  const stop = () => {
    s.controller.current?.abort();
    if (o.thread?.id)
      void cancelReply(o.thread.id).catch(() => {
        // 没告诉成也不用管：请求已经断开，服务器发现连接断了会自己停下（server/assistant/router.ts 的 onLost）
      });
  };
  /** 换账号：停掉进行中的回复，输入框和提示都清空 */
  const reset = () => {
    s.controller.current?.abort();
    s.clearReply(true);
    s.setBusy(false);
    s.sending.current = false;
    s.setMessage('');
    s.setProgress('');
    s.setStep(false);
    s.setSaid([]);
    setThinkingChoice(null);
    reasoning.reset();
  };
  return {
    message: s.message,
    setMessage: s.setMessage,
    busy: s.busy,
    working: s.working,
    progress: s.progress,
    step: s.step,
    draft: s.draft,
    said: s.said,
    partial: s.partial,
    reasoning,
    /** 思考档位菜单 */
    thinkingMenu: { value: thinkingChoice ?? o.assistant?.thinking ?? DEFAULT_THINKING, set: setThinkingChoice },
    send,
    /** 卡片确认或拒绝之后：把结果交给助手接着办（不显示成用户说的话） */
    continueAfterCard: (card: CardDecision) => send(undefined, card),
    stop,
    clearReply: s.clearReply,
    reset,
  };
}

/** 发送和收回复时界面上变的东西，和这次请求要记住的几样（停止用的控制器、正在生成的字、是不是正在发） */
function useChatState() {
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [working, setWorking] = useState<AssistantSpeaker | undefined>(undefined),
    [progress, setProgress] = useState(''),
    // 状态行说的是不是正在跑的命令（思考中也显示）
    [step, setStep] = useState(false),
    [draft, setDraft] = useState(''),
    [said, setSaid] = useState<InterimSaid[]>([]),
    [partial, setPartial] = useState('');
  const pageClientId = useRef(crypto.randomUUID()),
    controller = useRef<AbortController | null>(null),
    draftRef = useRef(''),
    sending = useRef(false);
  /** 清掉半截回复；withDraft 时连正在生成的那段一起清 */
  const clearReply = (withDraft: boolean) => {
    if (withDraft) setDraft('');
    setPartial('');
    draftRef.current = '';
  };
  return {
    message, setMessage, busy, setBusy, working, setWorking, progress, setProgress, step, setStep,
    draft, setDraft, said, setSaid, partial, setPartial, pageClientId, controller, draftRef, sending, clearReply,
  };
}

/** 发一次要用的：组件给的、界面状态、思考过程、这次带的思考档位 */
type ChatRun = {
  o: ChatOptions;
  s: ReturnType<typeof useChatState>;
  reasoning: ReturnType<typeof useReasoning>;
  thinking: DeepSeekThinking | null;
};

/** 现在发不了：录音中、没字也没附件（卡片的决定不看这两样）、正在发、附件没传好、AI 不能用 */
function blocked({ o, s }: ChatRun, text: string, card?: CardDecision) {
  return (
    (!card && (o.speechActive() || (!text.trim() && !o.uploads.ready.length))) ||
    s.busy ||
    o.uploads.working ||
    o.uploads.failed ||
    s.sending.current ||
    !o.assistant?.ai.ready
  );
}

/** 开始发：上一次的半截、状态行、先说的话、思考都清掉，聊天记录拉回底部 */
function begin({ o, s, reasoning }: ChatRun) {
  s.sending.current = true;
  s.setBusy(true);
  o.setError('');
  s.clearReply(true);
  s.setProgress('等待AI…');
  s.setStep(false);
  s.setSaid([]);
  reasoning.finish();
  o.atBottom.current = true;
}

/** card：人刚在这张确认卡片上点了确认或拒绝，不带用户的话，让助手按结果接着办 */
async function sendChat(run: ChatRun, override?: string, card?: CardDecision) {
  const { o, s } = run;
  if (blocked(run, override ?? s.message, card)) return;
  begin(run);
  const content = card ? '' : (override ?? s.message);
  if (!card) s.setMessage('');
  const owner = o.userId;
  try {
    if (!owner) throw new Error('请先登录，再和助手对话。');
    const current = await o.ensureThread();
    if (o.userRef.current !== owner) return;
    if (!card) o.setThread(withUserMessage(current, crypto.randomUUID(), content));
    const currentState = await o.loadState();
    if (!currentState.ai.ready) throw new Error(currentState.ai.message || '还没填写 DeepSeek 密钥。');
    // 读不出登录状态（网关错误页、会话失效）时给中文说明，会话失效回登录页
    const authState = await readAuthState(),
      abort = new AbortController();
    if (o.userRef.current !== owner) return;
    s.controller.current = abort;
    const stream = await postChat(
      current.id,
      authState.csrf,
      chatRequestBody({
        pageClientId: s.pageClientId.current,
        text: content,
        card,
        attachmentIds: card ? [] : o.uploads.ready.map((a) => a.id),
        includePrevious: o.includePrevious,
        thinking: run.thinking,
      }),
      AbortSignal.any([abort.signal, AbortSignal.timeout(AI_HTTP_TIMEOUT_MS * REPLY_TIMEOUT_ROUNDS)]),
    );
    await readReply(run, stream, owner);
    s.clearReply(true);
    await o.loadState();
  } catch (e) {
    await recover(run, e, owner);
  } finally {
    if (o.userRef.current === owner) settle(s);
  }
}

/** 读这次回复：每条事件交给对应的处理（换了账号就不管了），最后的整份会话换上 */
async function readReply({ o, s, reasoning }: ChatRun, stream: Response, owner: string) {
  const { setWorking, setDraft, setSaid, setProgress, setStep, draftRef } = s;
  const on = replyHandlers(
    { setWorking, setDraft, setSaid, setProgress, setStep, setThread: o.setThread, setError: o.setError, draftRef, reasoning, uploads: o.uploads, saveFile: o.saveFile },
    { clientId: s.pageClientId.current, owner, currentOwner: () => o.userRef.current },
  );
  const thread = await readEventStream<ThreadView>(
    stream,
    (event, data) => {
      if (o.userRef.current === owner) routeChatEvent(event, data, on);
    },
    replyInterrupted,
  );
  if (o.userRef.current === owner) on.result(thread);
}

/** 没发成或没收全：没收全的字留作半截回复，重新载入聊天核实服务器办了什么 */
async function recover({ o, s, reasoning }: ChatRun, e: unknown, owner: string | undefined) {
  reasoning.finish();
  const error = e instanceof Error ? e : new Error(errorMessage(e));
  const fallback = error.name === 'AbortError' ? '' : s.draftRef.current.trim();
  if (fallback) s.setPartial(fallback);
  o.setError(chatFailureText(error, o.userRef.current !== owner));
  if (!o.threadRef.current?.id) return;
  // 重新载入没成：上面的出错说明已经告诉人先去核实，这里不再另报
  const current = await o.loadThread(o.threadRef.current.id).catch(() => null);
  if (current?.messages.at(-1)?.facts?.executed.length) emit('erp-business-changed');
  if (partialAlreadySaved(current, fallback)) s.setPartial('');
}

/** 这次发送结束（成功、失败都走）：状态行、先说的话、谁在说都收起，可以再发 */
function settle(s: ReturnType<typeof useChatState>) {
  s.sending.current = false;
  s.setBusy(false);
  s.setProgress('');
  s.setStep(false);
  s.setSaid([]);
  s.setWorking(undefined);
  s.controller.current = null;
}
