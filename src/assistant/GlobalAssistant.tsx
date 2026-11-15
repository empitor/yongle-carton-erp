import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { errorMessage } from '../../shared/core/index';
import { useAuthState, useConfirm } from '../ui/index';
import { AttachmentPreview } from './AttachmentPreview';
import { useAssistantUploads } from './useAssistantUploads';
import { useAssistantSpeech } from './useAssistantSpeech';
import { useAssistantTopbarEntry } from './assistant-launcher';
import { useAssistantPanel } from './useAssistantPanel';
import { useMascotYield } from './useMascotYield';
import { useAssistantThreads } from './useAssistantThreads';
import { useAssistantReview } from './useAssistantReview';
import { useAssistantChat } from './useAssistantChat';
import { useReplyCue } from './useReplyCue';
import { useReadAloud } from './useReadAloud';
import { useRecordContext } from './useRecordContext';
import AssistantLauncher from './AssistantLauncher';
import AssistantPanel from './AssistantPanel';
import type { CardDecision, PreviewFiles } from './assistant-types';

/** 读会话列表；onlyIfNone 时眼前已经有会话就不换，否则载入最近的一段 */
function loadLatest(
  threads: ReturnType<typeof useAssistantThreads>,
  setError: (message: string) => void,
  onlyIfNone: boolean,
) {
  void threads
    .loadState()
    .then((s) => {
      if (s.threads[0] && !(onlyIfNone && threads.threadRef.current))
        return threads.loadThread(s.threads[0].id);
    })
    .catch((e: unknown) => setError(errorMessage(e)));
}

/**
 * 小甬小勒聊天窗口：把各块装起来。状态和请求在各 hook（面板、让位、会话、核对、发送、语音、朗读、新回复提示），
 * 显示在悬浮小人（AssistantLauncher）和打开的窗口（AssistantPanel）里；这里只接线，外加换账号时统一清空。
 */
export default function GlobalAssistant() {
  const auth = useAuthState(),
    userId = auth?.actor?.id,
    [error, setError] = useState(''),
    [previewFiles, setPreviewFiles] = useState<PreviewFiles>(null),
    [includePrevious, setIncludePrevious] = useState(true);
  const [context, clearContext] = useRecordContext(userId);
  // 收起方式：悬浮小人或顶栏入口，二选一（顶栏用 useAssistantTopbarEntry 读同一个设置）。
  const floatingLauncher = !useAssistantTopbarEntry();
  const [confirmDialog, confirm] = useConfirm();
  const history = useRef<HTMLDivElement>(null),
    atBottom = useRef(true);
  // 换会话、清空、删除时要动语音、附件、半截回复和核对区：这些 hook 在下面，回调到调用时才用它们。
  const threads = useAssistantThreads(userId, {
    setError,
    confirm,
    locked: () => sessionLocked,
    beforeSwitch: () => speech.cancel(),
    onLoaded: (t) => uploads.restore(t.pendingAttachments || []),
    onFresh: (kind) => {
      uploads.reset();
      chat.clearReply(kind !== 'clear');
      if (kind === 'new') {
        setIncludePrevious(true);
        setError('');
      } else review.close();
    },
  });
  const { thread } = threads;
  const panel = useAssistantPanel(
    userId,
    () => userId && loadLatest(threads, setError, true),
    !!previewFiles,
  );
  const { open, phone, floating } = panel;
  // 核对区先建、聊天后建：确认或拒绝之后要调聊天的“接着办”，用一个引用接过去
  const afterCard = useRef<(card: CardDecision) => void>(() => {});
  const mascot = useMascotYield({ open, floatingLauncher, phone, floating });
  const review = useAssistantReview({
    userId,
    userRef: threads.userRef,
    threadRef: threads.threadRef,
    thread,
    loadThread: threads.loadThread,
    loadState: threads.loadState,
    setError,
    onDecided: (card) => afterCard.current(card),
    history,
  });
  const uploads = useAssistantUploads(userId, threads.threadRef, threads.ensureThread, setError);
  const chat = useAssistantChat({
    userId,
    userRef: threads.userRef,
    thread,
    threadRef: threads.threadRef,
    assistant: threads.state,
    setThread: threads.setThread,
    ensureThread: threads.ensureThread,
    loadState: threads.loadState,
    loadThread: threads.loadThread,
    uploads,
    speechActive: () => speech.active,
    includePrevious,
    setError,
    atBottom,
  });
  afterCard.current = (card) => void chat.continueAfterCard(card);
  const speech = useAssistantSpeech({
    userId,
    contextKey: thread?.id || 'new',
    disabled: chat.busy || !open,
    ai: threads.state?.ai,
    onText: (text) => {
      setError('');
      chat.setMessage((current) => (current.trim() ? current.replace(/\s*$/, ' ') : '') + text);
    },
    onError: (message) => setError(message),
  });
  // 读出来：整个窗口一份，同一时间只读一条；换会话、关窗、换账号时停。
  // 出错原因只写在那条回复的喇叭旁边（ReadAloudButton），不再在输入框上方重复一遍。
  const readAloud = useReadAloud({ ai: threads.state?.ai });
  // stop 一直是同一个函数（useReadAloud 的 useCallback），只在换会话、开关窗口、换账号时停
  const stopReading = readAloud.stop;
  useEffect(() => stopReading(), [thread?.id, open, userId, stopReading]);
  // 换账号：停掉进行中的回复，各块清空，再读新账号的会话。只跟着账号变，用到的各块取最新的
  const switchAccount = useEffectEvent((id: string | undefined) => {
    chat.reset();
    threads.reset();
    review.reset();
    setError('');
    setPreviewFiles(null);
    setIncludePrevious(true);
    if (id) loadLatest(threads, setError, false);
  });
  useEffect(() => switchAccount(userId), [userId]);
  useEffect(() => {
    if (atBottom.current) history.current?.scrollTo({ top: history.current.scrollHeight });
  }, [thread, chat.draft, chat.said, chat.progress, open]);
  const cue = useReplyCue(thread, open);
  const activeSpeaker = chat.working ?? cue.speak.speaker;
  const sessionLocked = !thread || chat.busy || review.executing || uploads.working;
  const composer = { context, clearContext, includePrevious, setIncludePrevious, error, setError };
  const parts = { threads, chat, review, uploads, speech, readAloud, confirm, history, atBottom, setPreviewFiles, composer };
  return (
    <aside
      data-global-assistant="true"
      className={'global-assistant' + (confirmDialog ? ' ga-confirming' : '')}
    >
      {open ? (
        <AssistantPanel
          panel={panel}
          parts={parts}
          userId={userId}
          floatingLauncher={floatingLauncher}
          speaker={activeSpeaker}
          speakTick={cue.speak.tick}
          sessionLocked={sessionLocked}
        />
      ) : floatingLauncher ? (
        <AssistantLauncher
          floating={floating}
          yieldSide={mascot.yieldSide}
          pose={mascot.mascotPose}
          style={mascot.launcherStyle}
          busy={chat.busy}
          speaker={activeSpeaker}
          speakTick={cue.speak.tick}
          bubble={cue.bubble}
          onOpen={panel.openAssistant}
        />
      ) : null}
      {confirmDialog}
      {previewFiles && (
        <AttachmentPreview
          files={previewFiles.files}
          initialId={previewFiles.id}
          close={() => setPreviewFiles(null)}
        />
      )}
    </aside>
  );
}
