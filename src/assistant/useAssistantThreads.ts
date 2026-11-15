import { useRef, useState, type RefObject } from 'react';
import { errorMessage } from '../../shared/core/index';
import type { ThreadView } from '../../shared/assistant/index';
import { remoteCopyNote } from './attachment-slots';
import {
  clearThreadHistory,
  createThread,
  deleteThread,
  readAssistantState,
  readThread,
  type AssistantState,
} from './assistant-api';
import type { ConfirmFn } from './assistant-types';
import type { ChatThread } from './thread-view';

/** 换会话时要别的 hook 一起做的事，由组件以回调传进来（调用时才用，不在这里读它们） */
type ThreadEvents = {
  setError: (message: string) => void;
  confirm: ConfirmFn;
  /** 正在发送、执行、上传时不能清空或删除会话 */
  locked: () => boolean;
  /** 换会话之前（停掉语音） */
  beforeSwitch: () => void;
  /** 载入了一段会话（恢复它的待发附件） */
  onLoaded: (thread: ThreadView) => void;
  /** 当前会话换成新建的、清空了或删掉了：清掉待发附件、半截回复、核对区 */
  onFresh: (kind: 'new' | 'clear' | 'remove') => void;
};

/** 这一次渲染里的会话状态和设置函数：下面几组操作都从这里取 */
type ThreadsCore = {
  userId: string | undefined;
  on: ThreadEvents;
  state: AssistantState | null;
  setState: (state: AssistantState | null) => void;
  thread: ChatThread | null;
  setThread: (thread: ChatThread | null) => void;
  threadRef: RefObject<ChatThread | null>;
  userRef: RefObject<string | undefined>;
  creatingThread: RefObject<Promise<ThreadView> | null>;
};

/**
 * 会话：会话列表和当前会话、执行过的方案；读列表、确保有会话、载入、新建、清空、删除。
 * 换会话时要停语音、恢复待发附件、清掉半截回复，这些属于别的 hook，由组件以回调传进来（调用时才用，不在这里读它们）。
 */
export function useAssistantThreads(userId: string | undefined, on: ThreadEvents) {
  const [state, setState] = useState<AssistantState | null>(null),
    [thread, setThread] = useState<ChatThread | null>(null);
  const threadRef = useRef<ChatThread | null>(null),
    userRef = useRef(userId),
    creatingThread = useRef<Promise<ThreadView> | null>(null);
  userRef.current = userId;
  threadRef.current = thread;
  const core: ThreadsCore = { userId, on, state, setState, thread, setThread, threadRef, userRef, creatingThread };
  const loaders = threadLoaders(core);
  const removers = threadRemovers(core, loaders);
  /** 换账号：会话列表、当前会话都清掉 */
  const reset = () => {
    setThread(null);
    setState(null);
    creatingThread.current = null;
  };
  return { state, thread, setThread, threadRef, userRef, ...loaders, ...removers, reset };
}

/** 读会话列表、载入一段会话、确保有会话、新建会话 */
function threadLoaders(c: ThreadsCore) {
  const { userId, on, userRef, threadRef } = c;
  const loadState = () =>
    readAssistantState().then((s) => {
      if (userRef.current !== userId) throw new Error('账号已切换，已丢弃旧账号响应。');
      c.setState(s);
      return s;
    });
  const loadThread = async (id: string) => {
    on.beforeSwitch();
    const t = await readThread(id);
    if (userRef.current !== userId) return null;
    c.setThread(t);
    on.onLoaded(t);
    return t;
  };
  async function ensureThread(): Promise<ChatThread> {
    if (threadRef.current) return threadRef.current;
    // 优先复用列表里最近的会话，避免用户只是打开助手或语音回填后
    // 因为当前未选中会话而每次发送都新建一个“新会话”。
    const existing = c.state?.threads[0];
    if (existing) {
      const loaded = await loadThread(existing.id);
      if (loaded) return loaded;
    }
    const owner = userId;
    if (!c.creatingThread.current)
      c.creatingThread.current = createThread().finally(() => {
        c.creatingThread.current = null;
      });
    const created = await c.creatingThread.current;
    if (userRef.current !== owner) throw Error('账号已切换。');
    threadRef.current = created;
    c.setThread(created);
    void loadState();
    return created;
  }
  const newThread = async () => {
    on.beforeSwitch();
    try {
      const created = await createThread();
      if (userRef.current !== userId) return;
      c.setThread(created);
      threadRef.current = created;
      on.onFresh('new');
      await loadState();
    } catch (e) {
      if (userRef.current !== userId) return;
      on.setError(errorMessage(e));
    }
  };
  return { loadState, loadThread, ensureThread, newThread };
}

/** 清空、删除当前会话（先问一句；正在发送、执行、上传时不动） */
function threadRemovers(c: ThreadsCore, loaders: ReturnType<typeof threadLoaders>) {
  const { userId, on, userRef } = c;
  const clearThread = async () => {
    if (on.locked()) return;
    const target = c.thread;
    if (
      !(await on.confirm({
        title: '清空会话',
        message: '这段聊天和本会话的附件都会清掉，还没执行的方案作废。订单等业务数据和操作记录不受影响。' + remoteCopyNote,
        confirmLabel: '清空会话',
        danger: true,
      }))
    )
      return;
    on.beforeSwitch();
    try {
      const owner = userId,
        next = await clearThreadHistory(currentId(target));
      if (userRef.current !== owner) return;
      c.setThread(next);
      on.onFresh('clear');
    } catch (e) {
      on.setError(errorMessage(e));
    }
  };
  const removeThread = async () => {
    if (on.locked()) return;
    if (
      !(await on.confirm({
        title: '删除会话',
        message: '本会话的聊天记录和附件都会删除，还没执行的方案作废。订单等业务数据和操作记录不受影响。' + remoteCopyNote,
        confirmLabel: '删除会话',
        danger: true,
      }))
    )
      return;
    on.beforeSwitch();
    const owner = userId;
    try {
      await deleteThread(currentId(c.thread));
      if (userRef.current !== owner) return;
      const nextState = await loaders.loadState();
      const nextThread = nextState.threads[0];
      if (nextThread) await loaders.loadThread(nextThread.id);
      else {
        c.setThread(null);
        c.threadRef.current = null;
        on.onFresh('remove');
      }
    } catch (e) {
      on.setError(errorMessage(e));
    }
  };
  return { clearThread, removeThread };
}

/** 清空、删除的是眼前这段会话；没有会话时（locked 已经拦下）说清楚，不发请求 */
function currentId(thread: ChatThread | null) {
  if (!thread) throw new Error('还没有打开会话。');
  return thread.id;
}
