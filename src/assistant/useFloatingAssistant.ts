import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
} from 'react';
import {
  clampMascotDragPosition,
  fitFloatingMascot,
  fitFloatingSize,
  floatingMascotPosition,
  floatingPosition,
  mascotSize,
  type FloatingPoint,
  type FloatingSize,
  type FloatingViewport,
} from './floating-assistant';
import { useFloatingLayout, type FloatingPlace } from './useFloatingLayout';
import {
  dragHandlers,
  resizeHandlers,
  type DragGesture,
  type ResizeGesture,
} from './floating-gestures';

/**
 * 浮动的聊天窗口和收起时的悬浮小人：量出眼前的大小、算出摆在哪，给拖动、改大小的把手绑事件。
 * 位置和偏好在 useFloatingLayout，手势在 floating-gestures.ts；这里接起来，浏览器窗口变了、失焦时打断手势。
 */
export function useFloatingAssistant(open: boolean, large: boolean, onTouchTap: () => void) {
  const place = useFloatingLayout();
  const { view, layout } = place;
  const [node, setNode] = useState<HTMLElement | null>(null),
    [moving, setMoving] = useState(false);
  const activeNode = useRef<HTMLElement | null>(null),
    gesture = useRef<DragGesture | null>(null),
    resizing = useRef<ResizeGesture | null>(null),
    suppressClick = useRef(false);
  const elementRef = useCallback((element: HTMLElement | null) => {
    activeNode.current = element;
    setNode(element);
  }, []);
  const mode = open ? (large ? 'large' : 'panel') : 'mascot';
  const measured = useMeasuredSize(node, mode);
  useInterruptions(place, { gesture, resizing, suppressClick }, setMoving);
  const panel = large
    ? fitFloatingSize({ width: view.width - 16, height: view.height - 16 }, view)
    : fitFloatingSize(place.panelSize, view);
  const size = open ? panel : (measured ?? mascotSize);
  const point = open
    ? floatingPosition(layout.panel, size, view)
    : moving
      ? clampMascotDragPosition(
          { x: layout.mascot.x - size.width, y: layout.mascot.y - size.height },
          size,
          view,
        )
      : floatingMascotPosition(layout.mascot, size, view);
  const shared = { place, activeNode, setMoving };
  return {
    elementRef,
    resizeBind: (direction: string) =>
      resizeHandlers({ ...shared, large, resizing }, direction),
    bind: dragHandlers({ ...shared, open, gesture, suppressClick, onTouchTap, point, size }),
    moving,
    dock: layout.mascot.dock,
    compact: view.height < 520,
    style: floatingStyle(open ? panel : null, point, view),
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (suppressClick.current && e.detail !== 0) {
        e.preventDefault();
        e.stopPropagation();
        suppressClick.current = false;
      }
    },
  };
}

/** 量眼前这个样子（小人、窗口、放大）的实际大小；换了样子、还没量到时是 null */
function useMeasuredSize(node: HTMLElement | null, mode: string) {
  const [measured, setMeasured] = useState<{ mode: string; size: FloatingSize } | null>(null);
  useLayoutEffect(() => {
    if (!node) return;
    const measure = () => {
      const r = node.getBoundingClientRect();
      setMeasured((previous) =>
        previous?.mode === mode &&
        previous.size.width === r.width &&
        previous.size.height === r.height
          ? previous
          : { mode, size: { width: r.width, height: r.height } },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, mode]);
  return measured?.mode === mode ? measured.size : null;
}

/**
 * 浏览器窗口变了（含手机键盘、页面缩放）：打断正在拖的、改大小的，位置跟着调整；
 * 窗口失焦时正拖着的小人就地放下。被打断的那一下不再当成点击。
 */
function useInterruptions(
  place: FloatingPlace,
  refs: {
    gesture: RefObject<DragGesture | null>;
    resizing: RefObject<ResizeGesture | null>;
    suppressClick: RefObject<boolean>;
  },
  setMoving: (moving: boolean) => void,
) {
  const { refit, commit, layoutRef, viewRef } = place;
  const { gesture, resizing, suppressClick } = refs;
  // 列进依赖的引用、setMoving 一直是同一个，只有 refit、commit 变了才重新绑（和原来一样）
  useEffect(() => {
    const dropGesture = () => {
      if (!gesture.current) return false;
      gesture.current = null;
      suppressClick.current = true;
      return true;
    };
    const resize = () => {
      resizing.current = null;
      setMoving(false);
      dropGesture();
      refit();
    };
    const blur = () => {
      if (!dropGesture()) return;
      setMoving(false);
      const mascot = fitFloatingMascot(layoutRef.current.mascot, viewRef.current);
      commit(mascot, true, mascot.dock);
    };
    window.addEventListener('resize', resize);
    window.addEventListener('blur', blur);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', blur);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
    };
  }, [refit, commit, layoutRef, viewRef, gesture, resizing, suppressClick, setMoving]);
}

/** 浮动时的定位：左上角放在算好的位置；打开时给出窗口大小；最大不超出可视区域 */
function floatingStyle(
  panel: FloatingSize | null,
  point: FloatingPoint,
  view: FloatingViewport,
): CSSProperties {
  return {
    ...(panel ? { width: panel.width, height: panel.height } : {}),
    left: point.x,
    top: point.y,
    right: 'auto',
    bottom: 'auto',
    maxWidth: Math.max(1, view.width - 16),
    maxHeight: Math.max(1, view.height - 16),
  };
}
