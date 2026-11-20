import { useEffect } from 'react';
import { inAndroidApp } from '../app-bridge';
import { hasBackLayer, prefersReducedMotion } from '../ui/index';

/*
 * 安卓 App 里滑到顶、滑到底时只拉伸中间的内容区（<main>），顶栏和底部导航不动。
 * WebView 自带的拉伸是对整个网页视图做的，固定的顶栏、底栏会跟着变形，所以 App 关掉了它（apps/android 的
 * setOverScrollMode），由这里做一样的效果：越拉越难拉，松手回弹。浏览器自己的拉伸本来只动内容，不用这里，所以只在 App 里开。
 * 只认手指按在 <main> 里、而且不在它里面自己能滚的区域（文件列表、多行输入框这类）里的拖动；开着登记了返回键的弹层
 * （窗口、详情、助手、菜单、筛选浮层，src/ui/back-layers.ts）时一律不拉：“更多”菜单、筛选浮层的 DOM 就在 <main> 里。
 */

/** 拉得再远最多伸长这么多（比例） */
const MAX_STRETCH = 0.08;
/** 手指拉多远伸长到最大值的六成多（越拉越难拉） */
const PULL_RANGE_PX = 400;
/** 松手回弹多久：到点就清掉样式，不等 transitionend（系统开了“减少动态效果”时样式表关掉过渡，它不会来） */
const RELEASE_MS = 300;
const RELEASE = `transform ${RELEASE_MS}ms var(--ease)`;

/** 拉了 pull 像素时内容区伸长多少（0 到 MAX_STRETCH） */
export function stretchOf(pull: number): number {
  return pull <= 0 ? 0 : MAX_STRETCH * (1 - Math.exp(-pull / PULL_RANGE_PX));
}

type Box<T> = { scrollHeight: number; clientHeight: number; parentElement: T | null };
/** overflow-y 是这几种、内容又比框高，就是自己能滚 */
const SCROLLS = new Set(['auto', 'scroll', 'overlay']);
/**
 * 这次按下的手指算不算拉内容区：一根手指、没开着弹层、按在 main 里，而且从手指往上到 main 没有自己能竖着滚的区域
 * （有就是在滚它）。
 */
export function pullsContent<T extends Box<T>>(
  touch: { fingers: number; target: T | null },
  main: T | null,
  page: { layerOpen: boolean; overflowY: (box: T) => string },
): boolean {
  if (touch.fingers !== 1 || !main || page.layerOpen) return false;
  for (let box = touch.target; box; box = box.parentElement) {
    if (box === main) return true;
    if (box.scrollHeight > box.clientHeight && SCROLLS.has(page.overflowY(box))) return false;
  }
  return false;
}

type Edge = 'top' | 'bottom';

/** 现在在不在这个边上 */
const atEdge = (edge: Edge) =>
  edge === 'top'
    ? window.scrollY <= 0
    : window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 1;

const content = () => document.querySelector<HTMLElement>('main');

export function useAppContentStretch() {
  useEffect(() => {
    if (!inAndroidApp(navigator.userAgent)) return;
    let edge: Edge | null = null,
      from = 0,
      lastY = 0,
      tracking = false,
      stretched = false,
      timer = 0;
    // 留着 transform 会让里面固定定位的东西（页面提示、勾选操作条）改按内容区定位，回弹完一定清掉
    const set = (transform: string, origin: string, transition: string) => {
      window.clearTimeout(timer);
      const main = content();
      if (!main) return;
      main.style.transition = transition;
      main.style.transformOrigin = origin;
      main.style.transform = transform;
    };
    const clear = () => set('', '', '');
    const release = () => {
      if (edge && stretched && !prefersReducedMotion()) {
        set('scaleY(1)', edge, RELEASE);
        timer = window.setTimeout(clear, RELEASE_MS);
      } else if (stretched) clear();
      edge = null;
      stretched = false;
    };
    const onStart = (e: TouchEvent) => {
      tracking = pullsContent(
        { fingers: e.touches.length, target: e.target instanceof Element ? e.target : null },
        content(),
        { layerOpen: hasBackLayer(), overflowY: (box) => getComputedStyle(box).overflowY },
      );
      lastY = e.touches[0]?.clientY ?? 0;
      edge = null;
    };
    const onMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (!tracking || y === undefined) return;
      if (!edge) {
        const direction: Edge | null = y > lastY ? 'top' : y < lastY ? 'bottom' : null;
        if (direction && atEdge(direction)) [edge, from] = [direction, y];
        lastY = y;
        return;
      }
      const pull = edge === 'top' ? y - from : from - y;
      if (pull <= 0) {
        clear();
        edge = null;
        stretched = false;
        return;
      }
      stretched = true;
      set(`scaleY(${1 + stretchOf(pull)})`, edge, 'none');
    };
    const onEnd = () => {
      tracking = false;
      release();
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      clear();
    };
  }, []);
}
