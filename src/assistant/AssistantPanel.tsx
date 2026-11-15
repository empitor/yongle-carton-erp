import { useState, type DragEvent } from 'react';
import type { AssistantSpeaker } from '../../shared/assistant/index';
import { assistantDisplayName } from './assistant-launcher';
import AssistantHeader from './AssistantHeader';
import AssistantMemoryPanel from './AssistantMemoryPanel';
import AssistantConversation, { type AssistantParts } from './AssistantConversation';
import type { useAssistantPanel } from './useAssistantPanel';

/** 浮动窗口八个方向的改大小把手 */
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * 打开着的聊天窗口：外壳（停靠或浮动、放大、拖文件进来、改大小的把手）、头部、“当前页面”，
 * 下面没登录时说明、开着记忆面板时是记忆，否则是这段会话。
 */
export default function AssistantPanel({
  panel,
  parts,
  userId,
  floatingLauncher,
  speaker,
  speakTick,
  sessionLocked,
}: {
  panel: ReturnType<typeof useAssistantPanel>;
  parts: AssistantParts;
  userId: string | undefined;
  floatingLauncher: boolean;
  speaker: AssistantSpeaker | undefined;
  speakTick: number;
  /** 没有会话或正在发送、执行、上传时不能清空、删除会话 */
  sessionLocked: boolean;
}) {
  const { docked, large, floating } = panel,
    { threads, chat, review, uploads } = parts;
  const [dragging, setDragging] = useState(false);
  const drop = fileDropHandlers(
    setDragging,
    () => !(chat.busy || uploads.working || parts.speech.active),
    uploads.add,
  );
  return (
    <section
      ref={docked ? undefined : floating.elementRef}
      className={
        'ga-panel' +
        (docked ? ' ga-docked' : '') +
        (large ? ' ga-large' : '') +
        (!docked && floating.compact ? ' ga-compact' : '') +
        (dragging ? ' ga-dragging' : '') +
        (floating.moving ? ' ga-moving' : '')
      }
      {...drop}
      role="dialog"
      aria-modal="false"
      aria-label={assistantDisplayName}
      tabIndex={-1}
      style={docked ? undefined : floating.style}
    >
      {!large &&
        !docked &&
        RESIZE_EDGES.map((direction) => (
          <div
            key={direction}
            className={'ga-resize ga-resize-' + direction}
            aria-label={'调整聊天窗口大小 ' + direction}
            {...floating.resizeBind(direction)}
          />
        ))}
      <AssistantHeader
        docked={docked}
        phone={panel.phone}
        large={large}
        floatingLauncher={floatingLauncher}
        signedIn={!!userId}
        busy={chat.busy}
        newDisabled={chat.busy || review.executing || uploads.working}
        sessionLocked={sessionLocked}
        speaker={speaker}
        speakTick={speakTick}
        dragBind={floating.bind}
        onNew={() => {
          chat.clearReply(false);
          void threads.newThread();
        }}
        onPanelMode={panel.changePanelMode}
        onToggleLarge={() => panel.setLarge((v) => !v)}
        onClear={() => void threads.clearThread()}
        onMemory={() => panel.setMemoryOpen(true)}
        onRemove={() => void threads.removeThread()}
        onClose={() => panel.setOpen(false)}
      />
      {panel.pageLabel && <p className="ga-page-context">当前页面：{panel.pageLabel}</p>}
      {!userId ? (
        <p className="ga-empty">请先登录。聊天和工具权限按账号分开。</p>
      ) : panel.memoryOpen ? (
        <AssistantMemoryPanel
          key={userId}
          confirm={parts.confirm}
          onClose={() => panel.setMemoryOpen(false)}
        />
      ) : (
        <AssistantConversation parts={parts} composerRef={panel.composer} />
      )}
    </section>
  );
}

/** 把文件拖进窗口当附件：拖着时窗口高亮；正在发送、上传、录音时放下也不收 */
function fileDropHandlers(
  setDragging: (dragging: boolean) => void,
  canTake: () => boolean,
  add: (files: File[]) => Promise<void>,
) {
  return {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        setDragging(true);
      }
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      // 拖到窗口里面的子元素上不算离开
      const next = e.relatedTarget;
      if (!(next instanceof Node && e.currentTarget.contains(next))) setDragging(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      setDragging(false);
      if (!canTake()) return;
      void add([...e.dataTransfer.files]);
    },
  };
}
