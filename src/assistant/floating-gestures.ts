import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import {
  clampFloatingPosition,
  clampMascotDragPosition,
  isFloatingDrag,
  moveFloatingMascot,
  resizeFloatingRect,
  settleFloatingMascot,
  snapFloatingPosition,
  type FloatingPoint,
  type FloatingSize,
} from './floating-assistant';
import type { FloatingPlace } from './useFloatingLayout';

/**
 * 浮动窗口和悬浮小人的手势：按住拖动、方向键挪、拖边改大小。只算位置、交给 useFloatingLayout 的 commit，
 * 进行中的手势放在 useFloatingAssistant 给的引用里（浏览器窗口变了、失焦时由它打断）。
 */

/** 正在拖的这一下：按下时的指针和位置、最后到哪、动没动过 */
export type DragGesture = {
  id: number;
  start: FloatingPoint;
  position: FloatingPoint;
  last: FloatingPoint;
  size: FloatingSize;
  moved: boolean;
};
/** 正在拖边改大小：哪条边、按下时的指针和窗口 */
export type ResizeGesture = {
  id: number;
  direction: string;
  start: FloatingPoint;
  rect: FloatingPoint & FloatingSize;
};

type Shared = {
  place: FloatingPlace;
  activeNode: RefObject<HTMLElement | null>;
  setMoving: (moving: boolean) => void;
};
export type DragContext = Shared & {
  /** 打开的聊天窗口（否则是收起的小人） */
  open: boolean;
  gesture: RefObject<DragGesture | null>;
  /** 拖完的那一下别再当成点击 */
  suppressClick: RefObject<boolean>;
  /** 触屏上点了小人（没拖动） */
  onTouchTap: () => void;
  /** 眼前的位置和大小（方向键挪用） */
  point: FloatingPoint;
  size: FloatingSize;
};
export type ResizeContext = Shared & {
  large: boolean;
  resizing: RefObject<ResizeGesture | null>;
};

const clampFor = (open: boolean) => (open ? clampFloatingPosition : clampMascotDragPosition);
/** 位置按右下角记：左上角加上大小 */
const corner = (p: FloatingPoint, size: FloatingSize) => ({
  x: p.x + size.width,
  y: p.y + size.height,
});
const dragged = (g: DragGesture, e: PointerEvent<HTMLElement>) => ({
  x: g.position.x + e.clientX - g.start.x,
  y: g.position.y + e.clientY - g.start.y,
});

function startDrag(c: DragContext, e: PointerEvent<HTMLElement>) {
  if (!e.isPrimary || e.button !== 0 || c.gesture.current) return;
  const interactive =
    e.target instanceof Element ? e.target.closest('button,input,textarea,select,a') : null;
  if (interactive && interactive !== e.currentTarget) return;
  const rect = c.activeNode.current?.getBoundingClientRect();
  if (!rect) return;
  c.suppressClick.current = false;
  c.gesture.current = {
    id: e.pointerId,
    start: { x: e.clientX, y: e.clientY },
    position: { x: rect.left, y: rect.top },
    last: { x: rect.left, y: rect.top },
    size: { width: rect.width, height: rect.height },
    moved: false,
  };
  e.currentTarget.setPointerCapture(e.pointerId);
}

function moveDrag(c: DragContext, e: PointerEvent<HTMLElement>) {
  const g = c.gesture.current;
  if (!g || g.id !== e.pointerId) return;
  if (!g.moved && !isFloatingDrag(g.start, { x: e.clientX, y: e.clientY })) return;
  g.moved = true;
  c.setMoving(true);
  if (e.cancelable) e.preventDefault();
  const p = clampFor(c.open)(dragged(g, e), g.size, c.place.viewRef.current);
  g.last = p;
  c.place.commit(corner(p, g.size), false, c.open ? undefined : 'free');
}

function endDrag(c: DragContext, e: PointerEvent<HTMLElement>, cancelled = false) {
  const g = c.gesture.current;
  if (!g || g.id !== e.pointerId) return;
  c.gesture.current = null;
  const view = c.place.viewRef.current;
  if (!cancelled && (g.moved || isFloatingDrag(g.start, { x: e.clientX, y: e.clientY }))) {
    g.moved = true;
    g.last = clampFor(c.open)(dragged(g, e), g.size, view);
  }
  if (g.moved) {
    if (c.open) {
      const end = cancelled
        ? clampFloatingPosition(g.last, g.size, view)
        : snapFloatingPosition(g.last, g.size, view);
      c.place.commit(corner(end, g.size), true);
    } else {
      const end = settleFloatingMascot(g.last, g.size, view);
      c.place.commit(end, true, end.dock);
    }
    c.suppressClick.current = true;
  } else if (cancelled) c.suppressClick.current = true;
  c.setMoving(false);
  if (e.currentTarget.hasPointerCapture(e.pointerId))
    e.currentTarget.releasePointerCapture(e.pointerId);
  // Touch browsers may omit/delay the compatibility click directly after a drag.
  // Use the verified pointer tap and swallow its later duplicate click; keyboard stays native.
  if (!cancelled && !g.moved && !c.open && (e.pointerType === 'touch' || e.pointerType === 'pen')) {
    c.suppressClick.current = true;
    c.onTouchTap();
  }
}

/** 焦点在拖动把手上时方向键挪位置，按住 Shift 一次挪得多 */
function keyMove(c: DragContext, e: KeyboardEvent<HTMLElement>) {
  if (e.target !== e.currentTarget || !e.key.startsWith('Arrow')) return;
  const step = e.shiftKey ? 40 : 12,
    dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
    dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
  if (!dx && !dy) return;
  e.preventDefault();
  const view = c.place.viewRef.current;
  if (c.open) {
    const next = clampFloatingPosition({ x: c.point.x + dx, y: c.point.y + dy }, c.size, view);
    c.place.commit(corner(next, c.size), true);
  } else {
    const next = moveFloatingMascot(c.place.layoutRef.current.mascot, c.size, view, dx, dy);
    c.place.commit(next, true, next.dock);
  }
}

/** 拖动把手（窗口头部、悬浮小人）上要绑的事件 */
export function dragHandlers(c: DragContext) {
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => startDrag(c, e),
    onPointerMove: (e: PointerEvent<HTMLElement>) => moveDrag(c, e),
    onPointerUp: (e: PointerEvent<HTMLElement>) => endDrag(c, e),
    onPointerCancel: (e: PointerEvent<HTMLElement>) => endDrag(c, e, true),
    onLostPointerCapture: (e: PointerEvent<HTMLElement>) => endDrag(c, e, true),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => keyMove(c, e),
  };
}

function startResize(c: ResizeContext, direction: string, e: PointerEvent<HTMLElement>) {
  if (c.large || !e.isPrimary || e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const r = c.activeNode.current?.getBoundingClientRect();
  if (!r) return;
  c.resizing.current = {
    id: e.pointerId,
    direction,
    start: { x: e.clientX, y: e.clientY },
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
  };
  e.currentTarget.setPointerCapture(e.pointerId);
  c.setMoving(true);
}

function moveResize(c: ResizeContext, e: PointerEvent<HTMLElement>) {
  const g = c.resizing.current;
  if (!g || g.id !== e.pointerId) return;
  const r = resizeFloatingRect(
    g.rect,
    g.direction,
    e.clientX - g.start.x,
    e.clientY - g.start.y,
    c.place.viewRef.current,
  );
  c.place.resizePanel({ width: r.width, height: r.height });
  c.place.commit(corner(r, r));
}

function endResize(c: ResizeContext, e: PointerEvent<HTMLElement>) {
  if (c.resizing.current?.id !== e.pointerId) return;
  c.resizing.current = null;
  c.setMoving(false);
  c.place.commit(c.place.layoutRef.current.panel, true);
  c.place.savePanelSize();
  if (e.currentTarget.hasPointerCapture(e.pointerId))
    e.currentTarget.releasePointerCapture(e.pointerId);
}

/** 窗口某条边（n、se……）上的改大小把手要绑的事件 */
export function resizeHandlers(c: ResizeContext, direction: string) {
  const stop = () => {
    c.resizing.current = null;
    c.setMoving(false);
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => startResize(c, direction, e),
    onPointerMove: (e: PointerEvent<HTMLElement>) => moveResize(c, e),
    onPointerUp: (e: PointerEvent<HTMLElement>) => endResize(c, e),
    onPointerCancel: stop,
    onLostPointerCapture: stop,
  };
}
