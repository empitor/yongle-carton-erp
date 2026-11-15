import { useEffect, useRef, useState, type RefObject } from 'react';
import { markMissing, refreshMissing } from './required-guide';

/* 统一编辑窗（ManagementDialog.tsx）的两件事：必填引导，和打开时的焦点、键盘。 */

/** 点了这些按钮才算“要保存”：之后出现的报错才去定位还空着的必填项 */
const SAVE_BUTTONS = '.editor-footer button, button.primary';
/** 点了保存以后多久内出现的报错算这次保存的 */
const ARMED_FOR_MS = 15000;
/** 点了保存以后等多久再看报错（等页面把报错显示出来） */
const PRESSED_WAIT_MS = 300;

/**
 * 必填引导：点了保存/确认之后出现报错，把还空着的星号字段标红、滚过去，返回字段名，在按钮上方列出来。
 * 只在点按钮之后才定位，边填边出现的提示不会把光标抢走。
 */
export function useMissingGuide(ref: RefObject<HTMLElement | null>): string[] {
  const [missing, setMissing] = useState<string[]>([]);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    return watchMissing(root, setMissing);
  }, [ref]);
  return missing;
}

/** 盯着窗口里的报错和输入，必填项的名字变了就交给 update；返回停止盯的函数 */
function watchMissing(root: HTMLElement, setMissing: (names: string[]) => void) {
  let seen = '',
    shown = '',
    armedUntil = 0,
    frame = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  const update = (names: string[]) => {
    if (names.join('、') === shown) return;
    shown = names.join('、');
    setMissing(names);
  };
  const check = () => {
    frame = 0;
    const text = alertsText(root);
    if (text && text !== seen && Date.now() < armedUntil) {
      armedUntil = 0;
      update(markMissing(root));
    } else update(refreshMissing(root));
    seen = text;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(check);
  };
  const typed = () => {
    clearTimeout(timer);
    timer = setTimeout(schedule, 0);
  };
  // 再点一次保存，同样的报错也要重新定位
  const pressed = (e: Event) => {
    if (e.target instanceof Element && e.target.closest(SAVE_BUTTONS)) {
      seen = '';
      armedUntil = Date.now() + ARMED_FOR_MS;
      clearTimeout(timer);
      timer = setTimeout(schedule, PRESSED_WAIT_MS);
    }
  };
  // 浏览器自带的必填检查拦下了提交（没有报错文字）：同样标红、定位、列出名字
  const invalid = () => {
    clearTimeout(timer);
    armedUntil = 0;
    timer = setTimeout(() => update(markMissing(root)), 0);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-value'],
  });
  root.addEventListener('input', typed);
  root.addEventListener('change', typed);
  root.addEventListener('click', pressed, true);
  root.addEventListener('invalid', invalid, true);
  return () => {
    root.removeEventListener('invalid', invalid, true);
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    root.removeEventListener('input', typed);
    root.removeEventListener('change', typed);
    root.removeEventListener('click', pressed, true);
  };
}

/** 窗口里的报错文字（字段下面的小字不算），拼成一串比较前后变没变 */
function alertsText(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>('[role="alert"]')]
    .filter((a) => !a.classList.contains('form-field-error'))
    .map((a) => a.textContent?.trim() || '')
    .filter(Boolean)
    .join('|');
}

/**
 * 打开时焦点移进窗口、Tab 只在窗口里转、Esc 关窗（保存中不关），关掉后焦点回到打开前的地方，背后的页面不滚动。
 * close、busy 放进 ref：焦点和键盘监听只在打开时挂一次，开始保存、保存结束时焦点不会从输入框跳回弹窗本身。
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, close: () => void, busy: boolean) {
  const closeRef = useRef(close);
  const busyRef = useRef(busy);
  useEffect(() => {
    closeRef.current = close;
    busyRef.current = busy;
  });
  useEffect(() => {
    const active = document.activeElement;
    const prior = active instanceof HTMLElement || active instanceof SVGElement ? active : null;
    const root = ref.current;
    if (!root) return;
    root.focus();
    const listener = (e: KeyboardEvent) => {
      if (!topDialog(root) || (e.target instanceof Element && e.target.closest('[data-global-assistant]'))) return;
      if (e.key === 'Escape' && !busyRef.current) closeRef.current();
      if (e.key === 'Tab') keepTabInside(root, e);
    };
    document.addEventListener('keydown', listener);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', listener);
      document.body.style.overflow = overflow;
      prior?.focus();
    };
  }, [ref]);
}

/** 这个窗口是不是最上面那个看得见的弹窗（叠着几个时只有最上面的接键盘） */
function topDialog(root: HTMLElement) {
  return (
    [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
      .filter((d) => d.getClientRects().length)
      .at(-1) === root
  );
}

/** Tab、Shift+Tab 到头了绕回窗口里的另一头 */
function keepTabInside(root: HTMLElement, e: KeyboardEvent) {
  const items = [
    ...root.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary',
    ),
  ];
  const first = items[0],
    last = items.at(-1);
  if (!items.length) {
    e.preventDefault();
    return;
  }
  if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
    e.preventDefault();
    last?.focus();
  } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === root)) {
    e.preventDefault();
    first?.focus();
  }
}
