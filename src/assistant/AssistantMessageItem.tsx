import { ExportFileCard } from '../documents/index';
import { exportFileSchema, isErpNavigation, readSpeaker, speakerNames, type JsonView } from '../../shared/assistant/index';
import { AttachmentCards } from './AttachmentCards';
import { attachmentSlots, remoteCopyNote } from './attachment-slots';
import { InterimParts, SourceList } from './AssistantTrail';
import { assistantDisplayName } from './assistant-launcher';
import { SpeakerAvatar } from './YlSpirits';
import AssistantExecuted from './AssistantExecuted';
import { factLines, planCardButton, planCardNote } from './plan-card';
import ReasoningFold from './ReasoningFold';
import { exportFileMismatch } from './chat-events';
import { ReadAloudButton } from './ReadAloudButton';
import type { ReadAloud } from './useReadAloud';
import type { ChatMessage, ChatThread } from './thread-view';
import type { AssistantUploads, ChatAttachment, ConfirmFn, PreviewFiles, ReasoningPart } from './assistant-types';

/** 聊天里的一张确认卡片（服务器标好了现在的状态） */
export type ChatPlan = NonNullable<ChatMessage['plans']>[number];

/** 一条消息要用的：整段会话、各种动作（由聊天记录 AssistantMessages 转交） */
export type MessageItemProps = {
  m: ChatMessage;
  thread: ChatThread;
  now: number;
  busy: boolean;
  executing: boolean;
  uploads: AssistantUploads;
  confirm: ConfirmFn;
  setPreviewFiles: (files: PreviewFiles) => void;
  /** 点方案卡片上的“查看修改内容并确认” */
  onReview: (plan: ChatPlan) => void;
  /** 删了附件后重新载入这段会话 */
  reloadThread: (id: string) => Promise<unknown>;
  /** 助手回复下面的“读出来”（整个窗口一份） */
  readAloud: ReadAloud;
  /** 本页收到过的回复各自的思考过程（按消息编号） */
  savedReasoning: Record<string, ReasoningPart[]>;
};

/**
 * 聊天记录里的一条消息：谁说的、调命令前先说的话、思考过程、助手的话原样显示、接力、来源、
 * 这一轮服务器实际做了什么、读出来、导出文件、附件、记录链接、确认卡片。
 */
export function MessageItem(props: MessageItemProps) {
  const { m, thread, now, readAloud, savedReasoning } = props;
  const speaker = readSpeaker(m.speaker);
  return (
    <article className={'ga-message ga-' + m.role}>
      <small className="ga-who">
        {m.role !== 'user' && speaker && <SpeakerAvatar speaker={speaker} />}
        {m.role === 'user' ? '你' : speaker ? speakerNames[speaker] : assistantDisplayName}
      </small>
      {m.role === 'assistant' && <InterimParts parts={m.interim} speaker={speaker} />}
      {m.role === 'assistant' && <ReasoningFold parts={savedReasoning[m.id]} />}
      {!!m.text && <div className="ga-text">{m.text}</div>}
      {m.relay?.map((part, index) => (
        <div className="ga-relay" key={index}>
          <small className="ga-who">
            <SpeakerAvatar speaker={part.speaker} />
            {speakerNames[part.speaker]}
          </small>
          <div className="ga-text">{part.text}</div>
        </div>
      ))}
      <SourceList sources={m.sources} />
      {/* 固定的一行：这一轮服务器实际做了什么（事实，不是助手的话） */}
      {factLines(m.facts, m.plans, now).map((line, i) =>
        line.executed ? (
          <AssistantExecuted key={i} executed={line.executed} />
        ) : (
          <div className="ga-tool-result" key={i}>
            {line.text}
          </div>
        ),
      )}
      {/* 只给已经存下来的助手回复放“读出来”；正在生成、没收全的那两条不放 */}
      {m.role === 'assistant' && <ReadAloudButton reader={readAloud} threadId={thread.id} messageId={m.id} />}
      {m.exports?.map((file, i) => <ExportedFile key={i} file={file} />)}
      {!!m.attachments?.length && <MessageAttachments {...props} attachments={m.attachments} />}
      {m.links
        ?.filter((l) => isErpNavigation(l.url))
        .map((l, i) => (
          <a className="ga-record-link" key={i} href={l.url}>
            {l.label} ↗
          </a>
        ))}
      {m.plans?.map((p) => <PlanCardItem key={p.id} plan={p} {...props} />)}
    </article>
  );
}

/** 消息里的一份导出文件：放下载卡片；信息对不上时说清楚，不放下载 */
function ExportedFile({ file }: { file: JsonView }) {
  const parsed = exportFileSchema.safeParse(file);
  if (!parsed.success) return <div className="ga-tool-result">{exportFileMismatch}</div>;
  return <ExportFileCard file={parsed.data} />;
}

/** 这条消息带的附件：预览、带入下条、删除（删前问一句，删了重新载入这段会话） */
function MessageAttachments({
  attachments,
  thread,
  busy,
  uploads,
  confirm,
  setPreviewFiles,
  reloadThread,
}: MessageItemProps & { attachments: ChatAttachment[] }) {
  return (
    <AttachmentCards
      slots={attachmentSlots(attachments)}
      disabled={busy || uploads.working}
      preview={(a) =>
        setPreviewFiles({
          files: attachments.filter((f) => !f.deleted),
          id: a.id,
        })
      }
      reuse={(a) => {
        uploads.reuse(a);
      }}
      remove={async (s) => {
        if (
          !(await confirm({
            title: '删除附件',
            message: '删除这份聊天附件的原文。聊天记录里留一个“已删除”标记，订单和其他模块里的原件不受影响。' + remoteCopyNote,
            confirmLabel: '删除附件',
            danger: true,
          }))
        )
          return;
        await uploads.remove(s);
        await reloadThread(thread.id);
      }}
    />
  );
}

/** 聊天里的方案卡片：标题、按服务器标记写的小字，还在等确认的放按钮 */
function PlanCardItem({ plan, now, busy, executing, onReview }: MessageItemProps & { plan: ChatPlan }) {
  const button = planCardButton(plan, now);
  return (
    <div className="ga-plan">
      <strong>{plan.label}</strong>
      {/* 按服务器给的标记写要不要密码，不按账号猜（plan-card.ts） */}
      <p>{planCardNote(plan, now)}</p>
      {/* 只有还在等确认的卡片放按钮；执行了、作废了、过期了的小字已经写明 */}
      {button && (
        <button disabled={busy || executing} onClick={() => onReview(plan)}>
          {button.label}
        </button>
      )}
    </div>
  );
}
