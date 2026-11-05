import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import {
  fitFloatingSize,
  readFloatingSize,
  resizeFloatingRect,
  floatingSizeKey,
  clampFloatingPosition,
  defaultFloatingAnchor,
  fitFloatingAnchor,
  floatingPosition,
  isFloatingDrag,
  mascotSize,
  readFloatingAnchor,
  saveFloatingAnchor,
  snapFloatingPosition,
  clampMascotDragPosition,
  fitFloatingMascot,
  floatingMascotPosition,
  readFloatingMascot,
  saveFloatingMascot,
  settleFloatingMascot,
  moveFloatingMascot,
  type FloatingDock,
  type FloatingMascot,
  type FloatingPoint,
  type FloatingSize,
  type FloatingViewport,
} from './floating-assistant';
type FloatingLayout = { panel: FloatingPoint; mascot: FloatingMascot };
function persist(layout: FloatingLayout) {
  try {
    saveFloatingAnchor(window.localStorage, layout.panel);
    saveFloatingMascot(window.localStorage, layout.mascot);
  } catch {}
}
function viewport(): FloatingViewport {
  const visual = window.visualViewport;
  return {
    left: visual?.offsetLeft || 0,
    top: visual?.offsetTop || 0,
    width: Math.min(document.documentElement.clientWidth, visual?.width ?? window.innerWidth),
    height: visual?.height ?? window.innerHeight,
  };
}
export function useFloatingAssistant(open: boolean, large: boolean, onTouchTap: () => void) {
  const [view, setView] = useState(viewport),
    [layout, setLayout] = useState<FloatingLayout>(() => {
      try {
        return {
          panel: readFloatingAnchor(window.localStorage, viewport()),
          mascot: readFloatingMascot(window.localStorage, viewport()),
        };
      } catch {
        const anchor = defaultFloatingAnchor(viewport());
        return { panel: anchor, mascot: { ...anchor, dock: 'free' } };
      }
    }),
    [node, setNode] = useState<HTMLElement | null>(null),
    [measured, setMeasured] = useState<{ mode: string; size: FloatingSize } | null>(null),
    [moving, setMoving] = useState(false),
    [panelSize, setPanelSize] = useState(() => {
      try {
        return readFloatingSize(window.localStorage, viewport());
      } catch {
        return fitFloatingSize({ width: 440, height: 690 }, viewport());
      }
    });
  const resizing = useRef<{
    id: number;
    direction: string;
    start: FloatingPoint;
    rect: FloatingPoint & FloatingSize;
  } | null>(null);
  const sizeRef = useRef(panelSize);
  sizeRef.current = panelSize;
  const mode = open ? (large ? 'large' : 'panel') : 'mascot';
  const activeNode = useRef<HTMLElement | null>(null),
    layoutRef = useRef(layout),
    viewRef = useRef(view),
    suppressClick = useRef(false),
    frame = useRef<number | null>(null),
    pending = useRef<FloatingLayout | null>(null);
  const gesture = useRef<{
    id: number;
    start: FloatingPoint;
    position: FloatingPoint;
    last: FloatingPoint;
    size: FloatingSize;
    moved: boolean;
  } | null>(null);
  const elementRef = useCallback((element: HTMLElement | null) => {
    activeNode.current = element;
    setNode(element);
  }, []);
  const commit = useCallback((point: FloatingPoint, immediate = false, dock?: FloatingDock) => {
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
      persist(next);
      return;
    }
    pending.current = next;
    if (frame.current === null)
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (pending.current) {
          setLayout(pending.current);
          pending.current = null;
        }
      });
  }, []);
  useEffect(() => {
    persist(layoutRef.current);
  }, []);
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
  useEffect(() => {
    const resize = () => {
      const next = viewport();
      setView(next);
      resizing.current = null;
      setMoving(false);
      viewRef.current = next;
      if (gesture.current) {
        gesture.current = null;
        suppressClick.current = true;
      }
      commit(fitFloatingAnchor(layoutRef.current.panel, next), true);
      const mascot = fitFloatingMascot(layoutRef.current.mascot, next);
      commit(mascot, true, mascot.dock);
    };
    const blur = () => {
      if (gesture.current) {
        gesture.current = null;
        suppressClick.current = true;
        setMoving(false);
        const mascot = fitFloatingMascot(layoutRef.current.mascot, viewRef.current);
        commit(mascot, true, mascot.dock);
      }
    };
    window.addEventListener('resize', resize);
    window.addEventListener('blur', blur);
    const save = () => persist(layoutRef.current);
    window.addEventListener('pagehide', save);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', blur);
      window.removeEventListener('pagehide', save);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      save();
    };
  }, [commit]);
  const panel = large
    ? fitFloatingSize({ width: view.width - 16, height: view.height - 16 }, view)
    : fitFloatingSize(panelSize, view);
  const size = open ? panel : measured?.mode === mode ? measured.size : mascotSize;
  const point = open
    ? floatingPosition(layout.panel, size, view)
    : moving
      ? clampMascotDragPosition(
          { x: layout.mascot.x - size.width, y: layout.mascot.y - size.height },
          size,
          view,
        )
      : floatingMascotPosition(layout.mascot, size, view);
  const clampGesture = open ? clampFloatingPosition : clampMascotDragPosition;
  const finish = (e: PointerEvent<HTMLElement>, cancelled = false) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (!cancelled && (g.moved || isFloatingDrag(g.start, { x: e.clientX, y: e.clientY }))) {
      g.moved = true;
      g.last = clampGesture(
        { x: g.position.x + e.clientX - g.start.x, y: g.position.y + e.clientY - g.start.y },
        g.size,
        viewRef.current,
      );
    }
    if (g.moved) {
      if (open) {
        const end = cancelled
          ? clampFloatingPosition(g.last, g.size, viewRef.current)
          : snapFloatingPosition(g.last, g.size, viewRef.current);
        commit({ x: end.x + g.size.width, y: end.y + g.size.height }, true);
      } else {
        const end = settleFloatingMascot(g.last, g.size, viewRef.current);
        commit(end, true, end.dock);
      }
      suppressClick.current = true;
    } else if (cancelled) suppressClick.current = true;
    setMoving(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    // Touch browsers may omit/delay the compatibility click directly after a drag.
    // Use the verified pointer tap and swallow its later duplicate click; keyboard stays native.
    if (!cancelled && !g.moved && !open && (e.pointerType === 'touch' || e.pointerType === 'pen')) {
      suppressClick.current = true;
      onTouchTap();
    }
  };
  const bind = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (!e.isPrimary || e.button !== 0 || gesture.current) return;
      const interactive = (e.target as Element).closest('button,input,textarea,select,a');
      if (interactive && interactive !== e.currentTarget) return;
      const rect = activeNode.current?.getBoundingClientRect();
      if (!rect) return;
      suppressClick.current = false;
      gesture.current = {
        id: e.pointerId,
        start: { x: e.clientX, y: e.clientY },
        position: { x: rect.left, y: rect.top },
        last: { x: rect.left, y: rect.top },
        size: { width: rect.width, height: rect.height },
        moved: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g || g.id !== e.pointerId) return;
      if (!g.moved && !isFloatingDrag(g.start, { x: e.clientX, y: e.clientY })) return;
      g.moved = true;
      setMoving(true);
      if (e.cancelable) e.preventDefault();
      const p = clampGesture(
        { x: g.position.x + e.clientX - g.start.x, y: g.position.y + e.clientY - g.start.y },
        g.size,
        viewRef.current,
      );
      g.last = p;
      commit({ x: p.x + g.size.width, y: p.y + g.size.height }, false, open ? undefined : 'free');
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => finish(e),
    onPointerCancel: (e: PointerEvent<HTMLElement>) => finish(e, true),
    onLostPointerCapture: (e: PointerEvent<HTMLElement>) => finish(e, true),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget || !e.key.startsWith('Arrow')) return;
      const step = e.shiftKey ? 40 : 12,
        dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
        dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      const p = { x: point.x + dx, y: point.y + dy };
      if (open) {
        const next = clampFloatingPosition(p, size, viewRef.current);
        commit({ x: next.x + size.width, y: next.y + size.height }, true);
      } else {
        const next = moveFloatingMascot(layoutRef.current.mascot, size, viewRef.current, dx, dy);
        commit(next, true, next.dock);
      }
    },
  };
  return {
    elementRef,
    resizeBind: (direction: string) => ({
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (large || !e.isPrimary || e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const r = activeNode.current?.getBoundingClientRect();
        if (!r) return;
        resizing.current = {
          id: e.pointerId,
          direction,
          start: { x: e.clientX, y: e.clientY },
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        setMoving(true);
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        const g = resizing.current;
        if (!g || g.id !== e.pointerId) return;
        const r = resizeFloatingRect(
          g.rect,
          g.direction,
          e.clientX - g.start.x,
          e.clientY - g.start.y,
          viewRef.current,
        );
        setPanelSize({ width: r.width, height: r.height });
        sizeRef.current = { width: r.width, height: r.height };
        commit({ x: r.x + r.width, y: r.y + r.height });
      },
      onPointerUp: (e: PointerEvent<HTMLElement>) => {
        if (resizing.current?.id !== e.pointerId) return;
        resizing.current = null;
        setMoving(false);
        commit(layoutRef.current.panel, true);
        try {
          window.localStorage.setItem(floatingSizeKey, JSON.stringify(sizeRef.current));
        } catch {}
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      },
      onPointerCancel: () => {
        resizing.current = null;
        setMoving(false);
      },
      onLostPointerCapture: () => {
        resizing.current = null;
        setMoving(false);
      },
    }),
    bind,
    moving,
    dock: layout.mascot.dock,
    compact: view.height < 520,
    style: {
      ...(open ? { width: panel.width, height: panel.height } : {}),
      left: point.x,
      top: point.y,
      right: 'auto',
      bottom: 'auto',
      maxWidth: Math.max(1, view.width - 16),
      maxHeight: Math.max(1, view.height - 16),
    } as CSSProperties,
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (suppressClick.current && e.detail !== 0) {
        e.preventDefault();
        e.stopPropagation();
        suppressClick.current = false;
      }
    },
  };
}
