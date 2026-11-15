import type { RefObject } from 'react';
import { readSpeaker, speakerNames, type AssistantSpeaker, type InterimSaid } from '../../shared/assistant/index';
import AssistantOrderTask from './AssistantOrderTask';
import { InterimParts } from './AssistantTrail';
import { assistantDisplayName } from './assistant-launcher';
import { SpeakerAvatar } from './YlSpirits';
import { MessageItem, type MessageItemProps } from './AssistantMessageItem';
import ReasoningFold from './ReasoningFold';
import type { ChatThread } from './thread-view';
import type { LiveReasoning, ReasoningPart } from './assistant-types';

/** 离底部不到这么多像素算停在最底下（新内容来了跟着滚） */
const BOTTOM_SLACK_PX = 80;

type Props = Omit<MessageItemProps, 'm' | 'thread' | 'now' | 'savedReasoning'> & {
  thread: ChatThread | null;
  working: AssistantSpeaker | undefined;
  draft: string;
  /** 这一轮模型调命令前先说的话（正在生成时） */
  said: InterimSaid[];
  progress: string;
  /** 状态行说的是正在跑的命令：思考中也照样显示 */
  step: boolean;
  partial: string;
  history: RefObject<HTMLDivElement | null>;
  atBottom: RefObject<boolean>;
  /** 思考过程：正在生成的和本页收到过的回复各自的（按消息编号） */
  reasoning: { live: LiveReasoning; saved: Record<string, ReasoningPart[]> };
};

/**
 * 聊天记录（只显示）：空会话的介绍、每条消息（AssistantMessageItem.tsx）、订单任务、没收全的回复、
 * 正在处理（先说的话、正文、下面单独一行状态）。滚动时记下是不是停在最底下。
 */
export default function AssistantMessages(props: Props) {
  const { thread, history, atBottom, busy, said, partial, reasoning } = props;
  const now = Date.now();
  return (
    <div
      className="ga-history"
      ref={history}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
      }}
    >
      {!thread?.messages.length && <EmptyIntro />}
      {thread?.messages.map((m) => (
        <MessageItem key={m.id} {...props} m={m} thread={thread} now={now} savedReasoning={reasoning.saved} />
      ))}
      <AssistantOrderTask workflow={thread?.orderWorkflow} />
      {partial && <PartialReply partial={partial} />}
      {busy && !!said.length && <SaidNow said={said} />}
      {busy && <WorkingNow {...props} />}
    </div>
  );
}

/** 空会话的介绍 */
function EmptyIntro() {
  return (
    <div className="ga-empty">
      <h3>
        我是{speakerNames.yong}，这位是{speakerNames.le}
      </h3>
      <p>
        订单、客户、收件箱找{speakerNames.yong}；采购、仓库、生产、财务找
        {speakerNames.le}
        。例如：查找最近两个月未完成的订单，或查询某个型号的库存。
      </p>
    </div>
  );
}

/** 没收全的回复：留着给人看，说明改数据都要点确认 */
function PartialReply({ partial }: { partial: string }) {
  return (
    <article className="ga-message ga-assistant">
      <small>{assistantDisplayName} · 回复未完整接收</small>
      <div className="ga-text">{partial}</div>
      <div className="ga-tool-result">回复没有收全。改数据都要在确认卡片上点确认，没点过的不会生效。</div>
    </article>
  );
}

/** 正在生成时，模型调命令前先说的话（谁说的按第一段） */
function SaidNow({ said }: { said: InterimSaid[] }) {
  const speaker = readSpeaker(said[0].speaker);
  return (
    <article className="ga-message ga-assistant">
      <small className="ga-who">
        {speaker && <SpeakerAvatar speaker={speaker} />}
        {speaker ? speakerNames[speaker] : assistantDisplayName}
      </small>
      <InterimParts parts={said} speaker={speaker} />
    </article>
  );
}

/** 正在处理：谁在处理、思考过程、正在生成的正文、状态行 */
function WorkingNow({ working, reasoning, draft, progress, step }: Props) {
  return (
    <article className="ga-message ga-assistant">
      <small className="ga-who">
        {working && <SpeakerAvatar speaker={working} />}
        {working ? speakerNames[working] + ' 正在处理' : '正在处理'}
      </small>
      <ReasoningFold parts={reasoning.live.parts} liveChars={reasoning.live.chars} />
      {draft && <div className="ga-text">{draft}</div>}
      {/* 状态单独一行、在正文下面：命令在跑时一直看得到；只是在思考时，上面那行“正在思考 · N 字”就是进度，不再重复 */}
      {progress && (step || draft || !reasoning.live.chars) && (
        <div className="ga-status" role="status">
          {progress}
        </div>
      )}
    </article>
  );
}
