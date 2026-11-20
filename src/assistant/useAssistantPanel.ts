import { useEffect, useRef, useState, type RefObject } from 'react';
import { isPhoneNow, listen, useIsPhone } from '../ui/index';
import {
  assistantPageLabel,
  assistantPanelModeKey,
  readAssistantPanelMode,
  type AssistantPanelMode,
} from './floating-assistant';
import { useFloatingAssistant } from './useFloatingAssistant';
import { isAssistantShortcut, takeOpenRequest } from './assistant-launcher';

/**
 * 聊天窗口本身的开关和摆法：打开收起、放大、停靠还是浮动、停靠时推不推开页面、头部“当前页面”、
 * Ctrl+J 开关、Esc 关闭、打开后焦点进面板、浮动时拖动和改大小（useFloatingAssistant）。
 * 打开时要读会话，由组件传 onOpen 进来。
 */

function useMedia(query: string) {
  const [match, setMatch] = useState(() => !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const update = () => setMatch(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return match;
}

/** 停靠时屏幕够宽才把页面往左推；不够宽就盖在页面上，页面不会被挤成一列。 */
const DOCK_PUSH_QUERY = '(min-width: 1800px)';

/** 停靠还是浮动：记在本机浏览器里，换的时候顺带退出放大 */
function usePanelMode(setLarge: (large: boolean) => void) {
  const [panelMode, setPanelMode] = useState<AssistantPanelMode>(() => {
    try {
      return readAssistantPanelMode(window.localStorage);
    } catch {
      return 'docked';
    }
  });
  const changePanelMode = (next: AssistantPanelMode) => {
    setPanelMode(next);
    setLarge(false);
    try {
      localStorage.setItem(assistantPanelModeKey, next);
    } catch {
      // 浏览器不让存（隐私模式、存储满了）：这次照样换，只是下次打开回到默认的停靠
    }
  };
  return { panelMode, changePanelMode };
}

/** 头部“当前页面”：打开时跟着地址和右侧详情面板的标题变 */
function usePageLabel(open: boolean) {
  const [pageLabel, setPageLabel] = useState('');
  useEffect(() => {
    if (!open) return;
    let record: string | null = document.querySelector('.detail-panel-head h2')?.textContent || null;
    const refresh = () => setPageLabel(assistantPageLabel(location.hash, record));
    const focus = (title: string | null) => {
      record = title;
      refresh();
    };
    refresh();
    window.addEventListener('hashchange', refresh);
    const stopPanelFocus = listen('erp-panel-focus', focus);
    return () => {
      window.removeEventListener('hashchange', refresh);
      stopPanelFocus();
    };
  }, [open]);
  return pageLabel;
}

// 停靠：屏幕够宽时由样式变量推开内容、详情面板和弹窗（on）；不够宽或放大时盖在页面上（overlay），
// 页面保持原宽度，不会被挤成只剩一列。
function useDockStyle(docked: boolean, large: boolean) {
  const roomToPush = useMedia(DOCK_PUSH_QUERY);
  useEffect(() => {
    if (!docked) return;
    document.documentElement.dataset.assistantDock = large ? 'overlay-wide' : roomToPush ? 'on' : 'overlay';
    return () => {
      delete document.documentElement.dataset.assistantDock;
    };
  }, [docked, large, roomToPush]);
}

/**
 * 从别处打开：顶栏、手机导航的“助手”按钮（erp-open-assistant），面板代码加载前就点过的，Ctrl+J 开关。
 * openAssistant 每次渲染都是新的（带着组件给的 onOpen），经 ref 取最新的，监听只装一次（Ctrl+J 随开关状态重装）。
 */
function useOpenTriggers(open: boolean, setOpen: (open: boolean) => void, openRef: RefObject<() => void>) {
  useEffect(() => listen('erp-open-assistant', () => openRef.current()), [openRef]);
  // 面板代码加载前就点了“助手”或按了 Ctrl+J：挂上就接着打开
  useEffect(() => {
    if (takeOpenRequest()) openRef.current();
  }, [openRef]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (!isAssistantShortcut(e)) return;
      e.preventDefault();
      if (open) setOpen(false);
      else openRef.current();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [open, setOpen, openRef]);
}

// Esc 关面板：焦点在面板里，或者焦点不在任何输入框、弹窗、详情上时。
// 弹窗、附件预览、“更多”菜单自己先处理 Esc（它们会拦下或在面板外），这里不抢。
function useEscClose(open: boolean, previewOpen: boolean, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    const listener = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || previewOpen) return;
      const target = e.target,
        element = target instanceof Element ? target : null;
      const inside = !!element?.closest('[data-global-assistant]');
      const idle =
        (!target || target === document.body || target === document.documentElement) &&
        !document.querySelector('[role="dialog"][aria-modal="true"], .detail-panel');
      if (!inside && !idle) return;
      if (element?.closest('.more-menu[open]')) return;
      setOpen(false);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [open, previewOpen, setOpen]);
}

/** 助手里的站内链接（回复里的记录链接这类） */
const ASSISTANT_PAGE_LINK = '[data-global-assistant] a[href^="#"]';
/**
 * 助手要不要收起：手机上助手是全屏的，开着时地址一变（hashchange：点了回复里的记录链接，或助手带去某页）就收起，
 * 让人看到要去的页面；点了助手里的站内链接也收起（链接和现在的地址一样时不会触发 hashchange）。电脑上不收。
 * target 是点到的元素，只看它在不在助手的站内链接里。
 */
export function collapsesOnNavigate(
  panel: { open: boolean; phone: boolean },
  event: { type: string; target: { closest(selector: string): unknown } | null },
): boolean {
  if (!panel.open || !panel.phone) return false;
  return event.type === 'hashchange' || (event.type === 'click' && !!event.target?.closest(ASSISTANT_PAGE_LINK));
}

function useCloseOnNavigate(open: boolean, phone: boolean, setOpen: (open: boolean) => void) {
  useEffect(() => {
    const onEvent = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      if (collapsesOnNavigate({ open, phone }, { type: e.type, target })) setOpen(false);
    };
    window.addEventListener('hashchange', onEvent);
    document.addEventListener('click', onEvent);
    return () => {
      window.removeEventListener('hashchange', onEvent);
      document.removeEventListener('click', onEvent);
    };
  }, [open, phone, setOpen]);
}

// 打开后焦点进面板：电脑上直接能打字；手机上不弹键盘，只把焦点放到面板上（是不是手机按打开那一刻算）。
function useFocusOnOpen(open: boolean) {
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      if (!isPhoneNow() && composer.current && !composer.current.disabled) composer.current.focus();
      else document.querySelector<HTMLElement>('.global-assistant .ga-panel')?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);
  return composer;
}

export function useAssistantPanel(
  userId: string | undefined,
  /** 打开面板后要做的事（读会话列表、载入最近的会话） */
  onOpen: () => void,
  /** 附件预览开着时 Esc 先关预览，不关面板 */
  previewOpen: boolean,
) {
  const [open, setOpen] = useState(false),
    [large, setLarge] = useState(false),
    // 记忆面板打开时代替聊天记录和输入区；换账号关上
    [memoryOpen, setMemoryOpen] = useState(false);
  useEffect(() => setMemoryOpen(false), [userId]);
  const { panelMode, changePanelMode } = usePanelMode(setLarge);
  // 手机上一律全屏，不用浮动窗口，也不改用户在电脑上的选择。
  const phone = useIsPhone();
  const docked = open && (panelMode === 'docked' || phone);
  const pageLabel = usePageLabel(open);
  useDockStyle(docked, large);
  const openAssistant = () => {
    setOpen(true);
    onOpen();
  };
  const openRef = useRef(openAssistant);
  openRef.current = openAssistant;
  useOpenTriggers(open, setOpen, openRef);
  useEscClose(open, previewOpen, setOpen);
  useCloseOnNavigate(open, phone, setOpen);
  const composer = useFocusOnOpen(open);
  const floating = useFloatingAssistant(open && !docked, large, openAssistant);
  return {
    open,
    setOpen,
    large,
    setLarge,
    memoryOpen,
    setMemoryOpen,
    changePanelMode,
    phone,
    docked,
    pageLabel,
    openAssistant,
    composer,
    floating,
  };
}
