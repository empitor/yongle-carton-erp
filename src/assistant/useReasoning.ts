import { useRef, useState } from 'react';
import { appendReasoning, countThinking, reasoningChars, type ThinkingCount } from './chat-stream';
import type { ChatProgress } from './chat-events';
import type { LiveReasoning, ReasoningPart } from './assistant-types';

const idle: { parts: ReasoningPart[]; count: ThinkingCount } = {
  parts: [],
  count: { done: 0, current: 0 },
};

/**
 * 思考过程：这次回复正在生成的思考内容和字数，以及本页收到过的回复各自的思考内容（按消息编号）。
 * 服务端不存、不回传，只留在这个页面里，刷新就没了。拼接和计数规则在 chat-stream.ts。
 */
export function useReasoning() {
  const [current, setCurrent] = useState(idle),
    [saved, setSaved] = useState<Record<string, ReasoningPart[]>>({});
  // 回复结束时要把正在生成的这份挪到那条回复名下，用 ref 拿最新的一份
  const ref = useRef(idle);
  const update = (next: typeof idle) => {
    ref.current = next;
    setCurrent(next);
  };
  const { parts, count } = current;
  const live: LiveReasoning = {
    parts,
    // 进度里报的字数和收到的内容取大的：内容可能晚于进度到
    chars: Math.max(count.done + count.current, reasoningChars(parts)),
  };
  return {
    live,
    saved,
    append: (round: number, text: string) =>
      update({ ...ref.current, parts: appendReasoning(ref.current.parts, round, text) }),
    progress: (d: ChatProgress) => {
      const count = countThinking(ref.current.count, d);
      if (count !== ref.current.count) update({ ...ref.current, count });
    },
    /** 这次回复结束：有回复编号就把思考内容记到那条回复名下（默认收起），没有就丢掉 */
    finish: (messageId?: string) => {
      const done = ref.current.parts;
      update(idle);
      if (messageId && done.length) setSaved((s) => ({ ...s, [messageId]: done }));
    },
    /** 换账号：全部清掉 */
    reset: () => {
      update(idle);
      setSaved({});
    },
  };
}
