import { useEffect, useRef, useState } from 'react';
import type { AssistantSpeaker } from '../../shared/assistant/index';
import { isNewReply, replyCue, type ChatThread } from './thread-view';

/**
 * 新回复来了：说话的人跳一下（speak.tick 加一）；窗口收起时再冒个气泡，7 秒后收掉，打开窗口也收掉。
 * 刚打开的旧会话不算。谁说的、气泡写什么在 thread-view.ts。
 */
export function useReplyCue(thread: ChatThread | null, open: boolean) {
  const [speak, setSpeak] = useState<{ speaker?: AssistantSpeaker; tick: number }>({ tick: 0 }),
    [bubble, setBubble] = useState<{ speaker: AssistantSpeaker; text: string } | null>(null);
  const seenMessage = useRef<{ thread?: string; id?: string }>({});
  useEffect(() => {
    const last = thread?.messages.at(-1);
    if (!thread || !last) return;
    const seen = seenMessage.current;
    seenMessage.current = { thread: thread.id, id: last.id };
    if (!isNewReply(seen, thread, last)) return;
    const cue = replyCue(last);
    if (!cue) return;
    setSpeak((current) => ({ speaker: cue.speaker, tick: current.tick + 1 }));
    if (!open) setBubble({ speaker: cue.speaker, text: cue.line });
  }, [thread, open]);
  useEffect(() => {
    if (open) setBubble(null);
    if (!bubble) return;
    const timer = window.setTimeout(() => setBubble(null), 7000);
    return () => window.clearTimeout(timer);
  }, [bubble, open]);
  return { speak, bubble };
}
