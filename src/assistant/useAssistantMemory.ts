import { useEffect, useRef, useState } from 'react';
import { useAction } from '../ui/index';
import {
  addMemory,
  clearMemories,
  forgetMemory,
  readMemories,
  setMemoryAutoSave,
  updateMemory,
  type AssistantMemoryView,
} from './assistant-api';

/**
 * “记忆”面板的数据：打开时读一次，加、改、删、清空、开关自动记忆后都换成服务端返回的最新一份。
 * 成功返回 true，失败把原因放进 error。
 */
export function useAssistantMemory() {
  const [view, setView] = useState<AssistantMemoryView | null>(null);
  const action = useAction();
  const run = async (job: () => Promise<AssistantMemoryView>) => {
    let done = false;
    await action.run(async () => {
      setView(await job());
      done = true;
    });
    return done;
  };
  // 面板打开时读一次：run 每次渲染都是新的，经 ref 取，不因它重读
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    void runRef.current(readMemories);
  }, []);
  return {
    view,
    busy: action.busy,
    error: action.error,
    add: (content: string) => run(() => addMemory(content)),
    update: (id: number, content: string) => run(() => updateMemory(id, content)),
    remove: (id: number) => run(() => forgetMemory(id)),
    clear: () => run(clearMemories),
    setAutoSave: (autoSave: boolean) => run(() => setMemoryAutoSave(autoSave)),
  };
}
