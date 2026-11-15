import type { Dispatch, RefObject, SetStateAction } from 'react';
import { deliverBusinessFile } from '../documents/index';
import { emit } from '../ui/index';
import { errorMessage } from '../../shared/core/index';
import { isErpNavigation, readSpeaker, type AssistantSpeaker, type InterimSaid } from '../../shared/assistant/index';
import { executePageCommand, observeErpPage } from './assistant-page';
import { replyFollowUps, type ChatEventHandlers } from './chat-stream';
import type { ChatEffect } from './chat-events';
import type { ChatThread } from './thread-view';
import type { useReasoning } from './useReasoning';
import type { DeepSeekThinking } from '../../shared/ai/index';
import type { AssistantUploads, CardDecision } from './assistant-types';

/*
 * 一次发送的两头：发出去的内容（带上眼前页面的快照），收回来的每种事件怎么改界面。
 * 状态本身在 useAssistantChat，这里只用它给的设置函数。
 */

/** 发给服务器的一句话：卡片的决定不带用户的话和附件；思考档位选过才带 */
export function chatRequestBody(o: {
  pageClientId: string;
  text: string;
  card?: CardDecision;
  attachmentIds: string[];
  includePrevious: boolean;
  thinking: DeepSeekThinking | null;
}) {
  const pageSnapshot = observeErpPage();
  return {
    requestId: crypto.randomUUID(),
    pageClientId: o.pageClientId,
    pageSnapshot,
    text: o.text,
    ...(o.card ? { card: o.card } : {}),
    attachmentIds: o.attachmentIds,
    usePreviousAttachments: o.includePrevious,
    ...(o.thinking ? { thinking: o.thinking } : {}),
    context: {
      page: location.hash,
      ...(pageSnapshot.record
        ? { module: pageSnapshot.record.module, id: pageSnapshot.record.id }
        : {}),
    },
  };
}

/** 服务器这一轮让页面跟着做的事：下载文件、通知各页面刷新、跳到某页 */
function applyEffect(d: ChatEffect, setError: (message: string) => void) {
  if (d.type === 'download' && d.file)
    void deliverBusinessFile(d.file).catch((e: unknown) => setError(errorMessage(e)));
  if (d.workspaceId) emit('erp-ai-workspace-changed', { workspaceId: d.workspaceId });
  if (d.type === 'business') emit('erp-business-changed');
  if (d.module === 'workspaces') emit('erp-ai-workspace-list-changed');
  if (d.type === 'navigate' && isErpNavigation(d.url)) location.hash = d.url;
}

/** 收回复时要改的界面状态（useAssistantChat 的设置函数） */
export type ReplyView = {
  setWorking: Dispatch<SetStateAction<AssistantSpeaker | undefined>>;
  setDraft: (text: string) => void;
  setSaid: Dispatch<SetStateAction<InterimSaid[]>>;
  setProgress: (text: string) => void;
  setStep: (step: boolean) => void;
  setThread: (thread: ChatThread) => void;
  setError: (message: string) => void;
  /** 正在生成的那段字（没收全时留作半截回复） */
  draftRef: RefObject<string>;
  reasoning: ReturnType<typeof useReasoning>;
  uploads: AssistantUploads;
};

/**
 * 一次回复里每种事件的处理（没收到最终结果、服务器说失败由读事件流的 readEventStream 抛出）。
 * page：“看一眼页面”的命令只认这个页面、这个账号。
 */
export function replyHandlers(
  v: ReplyView,
  page: { clientId: string; owner: string; currentOwner: () => string | undefined },
): ChatEventHandlers {
  return {
    pageCommand: (d) =>
      void executePageCommand(d, page.clientId, page.owner, page.currentOwner).catch((e: unknown) =>
        v.setError(errorMessage(e)),
      ),
    effect: (d) => applyEffect(d, v.setError),
    speaker: (who) => v.setWorking(who),
    draft: (text) => {
      v.setDraft(text);
      v.draftRef.current = text;
    },
    said: (d) => {
      v.setSaid((list) => [...list, d]);
      // 头一句话就带着说话人：“正在处理”那行也写上是谁
      v.setWorking((w) => w ?? readSpeaker(d.speaker));
      v.setDraft('');
      v.draftRef.current = '';
    },
    reasoning: v.reasoning.append,
    modelProgress: v.reasoning.progress,
    progress: (text, isStep) => {
      v.setProgress(text);
      v.setStep(isStep);
    },
    result: (d) => {
      v.setThread(d);
      // 存下的回复里已经有先说的话（interim）：正在生成的那份同时清掉，不然等 loadState 的这段时间会显示两遍
      v.setSaid([]);
      v.reasoning.finish(d.messages.at(-1)?.id);
      v.uploads.restore(d.pendingAttachments);
      const next = replyFollowUps(d);
      if (next.businessChanged) emit('erp-business-changed');
      if (next.workspace) emit('erp-ai-workspace-changed', next.workspace);
    },
    // 服务器明说这一轮失败了：收到一半的字不留
    error: () => {
      v.draftRef.current = '';
    },
  };
}
