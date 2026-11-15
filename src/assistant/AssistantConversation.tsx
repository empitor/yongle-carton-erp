import type { RefObject } from 'react';
import { ThreadSwitcher } from './AssistantHeader';
import AssistantMessages from './AssistantMessages';
import AssistantReview from './AssistantReview';
import AssistantComposer from './AssistantComposer';
import type { useAssistantThreads } from './useAssistantThreads';
import type { useAssistantChat } from './useAssistantChat';
import type { useAssistantReview } from './useAssistantReview';
import type { ReadAloud } from './useReadAloud';
import type { AssistantSpeech, AssistantUploads, ConfirmFn, PreviewFiles } from './assistant-types';

/** 聊天窗口里各块要用的状态和动作（由 GlobalAssistant 的各 hook 给） */
export type AssistantParts = {
  threads: ReturnType<typeof useAssistantThreads>;
  chat: ReturnType<typeof useAssistantChat>;
  review: ReturnType<typeof useAssistantReview>;
  uploads: AssistantUploads;
  speech: AssistantSpeech;
  readAloud: ReadAloud;
  confirm: ConfirmFn;
  /** 聊天记录区，和它是不是停在最底下 */
  history: RefObject<HTMLDivElement | null>;
  atBottom: RefObject<boolean>;
  setPreviewFiles: (files: PreviewFiles) => void;
  /** 输入区上方：选中的记录、沿用最近附件、出错原因 */
  composer: {
    context: { label?: string } | null;
    clearContext: () => void;
    includePrevious: boolean;
    setIncludePrevious: (include: boolean) => void;
    error: string;
    setError: (message: string) => void;
  };
};

/** 聊着的这段会话：会话下拉、聊天记录、核对区、输入区 */
export default function AssistantConversation({
  parts,
  composerRef,
}: {
  parts: AssistantParts;
  /** 输入框：打开窗口后焦点放进来 */
  composerRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { threads, chat, review, uploads } = parts,
    thread = threads.thread;
  return (
    <>
      <ThreadSwitcher
        threads={threads.state?.threads}
        current={thread?.id}
        disabled={chat.busy || review.executing || uploads.working}
        onPick={(id) => {
          chat.clearReply(false);
          void threads.loadThread(id);
        }}
      />
      <AssistantMessages
        thread={thread}
        busy={chat.busy}
        executing={review.executing}
        working={chat.working}
        draft={chat.draft}
        said={chat.said}
        progress={chat.progress}
        step={chat.step}
        partial={chat.partial}
        uploads={uploads}
        confirm={parts.confirm}
        history={parts.history}
        atBottom={parts.atBottom}
        setPreviewFiles={parts.setPreviewFiles}
        onReview={review.show}
        reloadThread={threads.loadThread}
        readAloud={parts.readAloud}
        reasoning={chat.reasoning}
      />
      {review.plan && (
        <AssistantReview
          review={review.plan}
          reviewRef={review.reviewRef}
          executing={review.executing}
          switchingPolicy={review.switchingPolicy}
          password={review.reviewPassword}
          onPassword={review.setReviewPassword}
          onPolicy={(policy) => void review.changePolicy(policy)}
          onExecute={() => void review.execute()}
          onReject={() => void review.reject()}
          onClose={review.close}
        />
      )}
      <AssistantComposer
        context={parts.composer.context}
        onClearContext={parts.composer.clearContext}
        uploads={uploads}
        thread={thread}
        includePrevious={parts.composer.includePrevious}
        setIncludePrevious={parts.composer.setIncludePrevious}
        error={parts.composer.error}
        setError={parts.composer.setError}
        speech={parts.speech}
        aiReady={!!threads.state?.ai?.ready}
        message={chat.message}
        setMessage={chat.setMessage}
        busy={chat.busy}
        composer={composerRef}
        setPreviewFiles={parts.setPreviewFiles}
        onSend={() => void chat.send()}
        onStop={chat.stop}
        thinking={chat.thinkingMenu}
      />
    </>
  );
}
