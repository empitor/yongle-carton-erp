import { useEffect, useState } from 'react';
import { floatingLauncherModeKey, readFloatingLauncher } from './floating-assistant';
import { speakerNames } from '../../shared/assistant/index';
import { emit, listen } from '../ui/index';

/**
 * 小甬小勒的入口用到的几样小东西，单独放：顶栏要用，又不能为此把整个助手面板（懒加载）提前打进首屏。
 */

/** 助手在界面上的名字：头部、悬浮小人、顶栏入口、读屏都用这一个。 */
export const assistantDisplayName = speakerNames.yong + speakerNames.le;

export function readLauncherIsFloating() {
  try {
    return readFloatingLauncher(window.localStorage);
  } catch {
    return true;
  }
}

/** 记下收起方式（悬浮小人还是顶栏入口），通知顶栏和面板跟着换 */
export function saveLauncherIsFloating(floating: boolean) {
  try {
    localStorage.setItem(floatingLauncherModeKey, floating ? 'floating' : 'docked');
  } catch {
    // 浏览器禁用了存储：这次照样换（下面通知顶栏和面板），只是下次打开不记得
  }
  emit('erp-assistant-launcher-change');
}

/** 开关助手的快捷键 Ctrl+J（Mac 上 Cmd+J） */
export function isAssistantShortcut(e: KeyboardEvent) {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j';
}

// 聊天面板是按需加载的：代码还没到时点的“助手”、按的 Ctrl+J 先记下，面板一挂上就接着打开，点了不会没反应。
let panelMounted = false,
  openRequested = false;
/** 面板挂上时调一次：之后由面板自己收听；返回加载前有没有人要打开过 */
export function takeOpenRequest() {
  panelMounted = true;
  const asked = openRequested;
  openRequested = false;
  return asked;
}
function useOpenRequestBeforeLoad() {
  useEffect(() => {
    if (panelMounted) return;
    const request = () => {
      if (!panelMounted) openRequested = true;
    };
    const key = (e: KeyboardEvent) => {
      if (panelMounted || !isAssistantShortcut(e)) return;
      e.preventDefault();
      openRequested = true;
    };
    const stop = listen('erp-open-assistant', request);
    window.addEventListener('keydown', key);
    return () => {
      stop();
      window.removeEventListener('keydown', key);
    };
  }, []);
}

/**
 * 顶栏要不要显示“小甬小勒”入口：收起方式选了“放到顶栏”时为 true，选悬浮小人时为 false。
 * 两种入口二选一，不同时出现（手机另有底部导航，不看这个）。
 * 顶栏从首屏起就挂着，顺带在面板代码加载前记下“要打开”。
 */
export function useAssistantTopbarEntry(): boolean {
  useOpenRequestBeforeLoad();
  const [floating, setFloating] = useState(readLauncherIsFloating);
  useEffect(() => {
    const update = () => setFloating(readLauncherIsFloating());
    const stopAssistantLauncherChange = listen('erp-assistant-launcher-change', update);
    window.addEventListener('storage', update);
    return () => {
      stopAssistantLauncherChange();
      window.removeEventListener('storage', update);
    };
  }, []);
  return !floating;
}
