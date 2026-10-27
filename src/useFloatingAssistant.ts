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
  clampFloatingPosition,
  defaultFloatingAnchor,
  fitFloatingAnchor,
  floatingPosition,
  isFloatingDrag,
  mascotSize,
  readFloatingAnchor,
  saveFloatingAnchor,
  snapFloatingPosition,
  type FloatingPoint,
  type FloatingSize,
  type FloatingViewport,
} from './floating-assistant';
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
    [anchor, setAnchor] = useState(() => {
      try {
        return readFloatingAnchor(window.localStorage, viewport());
      } catch {
        return defaultFloatingAnchor(viewport());
      }
    }),
    [node, setNode] = useState<HTMLElement | null>(null),
    [measured, setMeasured] = useState<{ mode: string; size: FloatingSize } | null>(null),
    [moving, setMoving] = useState(false);
  const mode = open ? (large ? 'large' : 'panel') : 'mascot';
  const activeNode = useRef<HTMLElement | null>(null),
    anchorRef = useRef(anchor),
    viewRef = useRef(view),
    suppressClick = useRef(false),
    frame = useRef<number | null>(null),
    pending = useRef<FloatingPoint | null>(null);
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
  const commit = useCallback((next: FloatingPoint, immediate = false) => {
    anchorRef.current = next;
    if (immediate) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      pending.current = null;
      setAnchor(next);
      try {
        saveFloatingAnchor(window.localStorage, next);
      } catch {}
      return;
    }
    pending.current = next;
    if (frame.current === null)
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (pending.current) {
          setAnchor(pending.current);
          pending.current = null;
        }
      });
  }, []);
  useEffect(() => {
    try {
      saveFloatingAnchor(window.localStorage, anchorRef.current);
    } catch {}
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
      viewRef.current = next;
      if (gesture.current) {
        gesture.current = null;
        suppressClick.current = true;
        setMoving(false);
      }
      commit(fitFloatingAnchor(anchorRef.current, next), true);
    };
    const blur = () => {
      if (gesture.current) {
        gesture.current = null;
        suppressClick.current = true;
        setMoving(false);
        commit(anchorRef.current, true);
      }
    };
    window.addEventListener('resize', resize);
    window.addEventListener('blur', blur);
    const persist = () => {
      try {
        saveFloatingAnchor(window.localStorage, anchorRef.current);
      } catch {}
    };
    window.addEventListener('pagehide', persist);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', blur);
      window.removeEventListener('pagehide', persist);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      persist();
    };
  }, [commit]);
  const fallback: FloatingSize = open
    ? {
        width: Math.min(large ? 760 : 440, view.width - 16),
        height: Math.min(large ? view.height - 32 : 690, view.height - 32),
      }
    : mascotSize;
  const size = measured?.mode === mode ? measured.size : fallback;
  const point = floatingPosition(anchor, size, view);
  const finish = (e: PointerEvent<HTMLElement>, cancelled = false) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (!cancelled && (g.moved || isFloatingDrag(g.start, { x: e.clientX, y: e.clientY }))) {
      g.moved = true;
      g.last = clampFloatingPosition(
        { x: g.position.x + e.clientX - g.start.x, y: g.position.y + e.clientY - g.start.y },
        g.size,
        viewRef.current,
      );
    }
    if (g.moved) {
      const end = cancelled
        ? clampFloatingPosition(g.last, g.size, viewRef.current)
        : snapFloatingPosition(g.last, g.size, viewRef.current);
      commit({ x: end.x + g.size.width, y: end.y + g.size.height }, true);
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
      const p = clampFloatingPosition(
        { x: g.position.x + e.clientX - g.start.x, y: g.position.y + e.clientY - g.start.y },
        g.size,
        viewRef.current,
      );
      g.last = p;
      commit({ x: p.x + g.size.width, y: p.y + g.size.height });
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
      const p = clampFloatingPosition({ x: point.x + dx, y: point.y + dy }, size, viewRef.current);
      commit({ x: p.x + size.width, y: p.y + size.height }, true);
    },
  };
  return {
    elementRef,
    bind,
    moving,
    compact: view.height < 520,
    style: {
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
