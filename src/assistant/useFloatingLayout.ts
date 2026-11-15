import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultFloatingAnchor,
  fitFloatingAnchor,
  fitFloatingMascot,
  fitFloatingSize,
  floatingMascotKey,
  floatingSizeKey,
  readFloatingAnchor,
  readFloatingMascot,
  readFloatingSize,
  saveFloatingAnchor,
  saveFloatingMascot,
  type FloatingDock,
  type FloatingMascot,
  type FloatingPoint,
  type FloatingSize,
  type FloatingViewport,
} from './floating-assistant';

/**
 * 浮动窗口和悬浮小人放在哪、窗口多大：记下的偏好读出来，拖动中按帧更新，放手后存；
 * 浏览器窗口变了只调整显示位置，不写偏好（useFloatingAssistant 在窗口变化时调 refit）。
 */
export type FloatingLayout = { panel: FloatingPoint; mascot: FloatingMascot };

/** 眼前能用的可视区域（手机上键盘弹出、页面缩放时按 visualViewport 算） */
export function floatingViewport(): FloatingViewport {
  const visual = window.visualViewport;
  return {
    left: visual?.offsetLeft || 0,
    top: visual?.offsetTop || 0,
    width: Math.min(document.documentElement.clientWidth, visual?.width ?? window.innerWidth),
    height: visual?.height ?? window.innerHeight,
  };
}
function persist(layout: FloatingLayout) {
  try {
    saveFloatingAnchor(window.localStorage, layout.panel);
    saveFloatingMascot(window.localStorage, layout.mascot);
  } catch {
    // 浏览器禁用了存储（隐私模式下连 localStorage 都取不到）：记不住位置照样能拖，不打扰人
  }
}
function hasSavedPosition() {
  try {
    // 窗口和小人的位置总是一起存（persist），看小人那份就够了
    return window.localStorage.getItem(floatingMascotKey) !== null;
  } catch {
    return false;
  }
}
function savedLayout(): FloatingLayout {
  try {
    return {
      panel: readFloatingAnchor(window.localStorage, floatingViewport()),
      mascot: readFloatingMascot(window.localStorage, floatingViewport()),
    };
  } catch {
    const anchor = defaultFloatingAnchor(floatingViewport());
    return { panel: anchor, mascot: { ...anchor, dock: 'free' } };
  }
}
/** 改完大小记成偏好 */
function saveSize(size: FloatingSize) {
  try {
    window.localStorage.setItem(floatingSizeKey, JSON.stringify(size));
  } catch {
    // 同上：存不了大小也照样能改，下次打开用默认大小
  }
}
function savedSize() {
  try {
    return readFloatingSize(window.localStorage, floatingViewport());
  } catch {
    return fitFloatingSize({ width: 440, height: 690 }, floatingViewport());
  }
}

export function useFloatingLayout() {
  const [view, setView] = useState(floatingViewport),
    [layout, setLayout] = useState(savedLayout),
    [panelSize, setPanelSize] = useState(savedSize);
  const layoutRef = useRef(layout),
    viewRef = useRef(view),
    sizeRef = useRef(panelSize),
    placed = useRef(hasSavedPosition()),
    frame = useRef<number | null>(null),
    pending = useRef<FloatingLayout | null>(null);
  sizeRef.current = panelSize;
  const flush = () => {
    frame.current = null;
    if (pending.current) {
      setLayout(pending.current);
      pending.current = null;
    }
  };
  /** 换位置：dock 不给是窗口，给了是小人；immediate 立刻显示（否则下一帧），remember 记成偏好 */
  const commit = useCallback(
    (point: FloatingPoint, immediate = false, dock?: FloatingDock, remember = true) => {
      const next: FloatingLayout =
        dock === undefined
          ? { ...layoutRef.current, panel: point }
          : { ...layoutRef.current, mascot: { ...point, dock } };
      layoutRef.current = next;
      if (immediate) {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
        pending.current = null;
        setLayout(next);
        if (remember) {
          placed.current = true;
          persist(next);
        }
        return;
      }
      pending.current = next;
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    },
    [],
  );
  /** 浏览器窗口变了：只调整显示位置，不写入偏好；用户没摆过时跟着默认的右下角 */
  const refit = useCallback(() => {
    const next = floatingViewport();
    setView(next);
    viewRef.current = next;
    const anchor = placed.current
      ? fitFloatingAnchor(layoutRef.current.panel, next)
      : defaultFloatingAnchor(next);
    commit(anchor, true, undefined, false);
    const mascot: FloatingMascot = placed.current
      ? fitFloatingMascot(layoutRef.current.mascot, next)
      : { ...anchor, dock: 'free' };
    commit(mascot, true, mascot.dock, false);
  }, [commit]);
  // 离开页面、面板卸下时把摆过的位置存下
  useEffect(() => {
    const save = () => {
      if (placed.current) persist(layoutRef.current);
    };
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      save();
    };
  }, []);
  return {
    view,
    layout,
    panelSize,
    layoutRef,
    viewRef,
    commit,
    refit,
    /** 拖边改大小时跟着变 */
    resizePanel: (size: FloatingSize) => {
      setPanelSize(size);
      sizeRef.current = size;
    },
    savePanelSize: () => saveSize(sizeRef.current),
  };
}
export type FloatingPlace = ReturnType<typeof useFloatingLayout>;
