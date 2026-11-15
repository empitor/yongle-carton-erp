import { useEffect, useState } from 'react';
import {
  chooseYieldSide,
  mascotSize,
  yieldPeek,
  yieldReveal,
  yieldStrip,
  type FloatingDock,
  type YieldSide,
} from './floating-assistant';
import type { useFloatingAssistant } from './useFloatingAssistant';
import type { YieldSideState } from './assistant-types';

/**
 * 悬浮小人让位：压住按钮、表格、分页、详情面板时缩到屏幕边上只露一点，鼠标移上去探出来；
 * 量页面上压住了什么、选缩向哪边、给页面打“让出详情面板”的标记、算缩过去以后的位置。
 * 选边的规则在 floating-assistant.ts（chooseYieldSide、yieldStrip），这里只管量和接线。
 */

type Rect = { left: number; top: number; width: number; height: number };

/** 悬浮小人底下压着这些东西就让开：按钮、链接、输入框、表格单元格、分页、详情、弹窗。 */
const COVERED_SELECTOR =
  'button, a[href], input, select, textarea, summary, label, [role="button"], [role="tab"], td, th, .unified-pager, .detail-panel, .management-dialog';

/**
 * 小人真的压住了右侧详情面板：只算屏幕里看得见的那部分（用户停靠在边上半隐藏时一半在屏幕外），四边各收 8px，
 * 只擦到一点阴影、边线不算。原来在左边、上面没压住面板的，不用让。
 */
function mascotOverPanel(rect: Rect) {
  const inset = 8,
    width = document.documentElement.clientWidth,
    left = Math.max(0, rect.left) + inset,
    right = Math.min(width, rect.left + rect.width) - inset,
    top = rect.top + inset,
    bottom = rect.top + rect.height - inset;
  if (right <= left || bottom <= top) return false;
  return [...document.querySelectorAll('.detail-panel')].some((el) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      left < r.right &&
      right > r.left &&
      top < r.bottom &&
      bottom > r.top
    );
  });
}

/** 小人这块地方底下压着几处按钮、表格这类东西（5×5 个点里压住的点数；屏幕外的点不算）。0 就是没压住。 */
function mascotCoverage(rect: Rect) {
  // 5×5 个点，间隔二十来像素，一个按钮高 30 左右，漏不掉。
  const inset = 8,
    steps = [0, 0.25, 0.5, 0.75, 1];
  let hits = 0;
  for (const fx of steps)
    for (const fy of steps) {
      const x = rect.left + inset + (rect.width - inset * 2) * fx,
        y = rect.top + inset + (rect.height - inset * 2) * fy;
      if (
        document
          .elementsFromPoint(x, y)
          .some((el) => !el.closest('.global-assistant') && el.matches(COVERED_SELECTOR))
      )
        hits++;
    }
  return hits;
}
const mascotCovers = (rect: Rect) => mascotCoverage(rect) > 0;
/** 这一条会不会压到左侧导航（导航的图标和文字）；收起、移出屏幕看不见的导航不算。 */
function overNavigation(rect: Rect) {
  return [...document.querySelectorAll('.sidebar, .erp-nav')].some((el) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      rect.left < r.right &&
      rect.left + rect.width > r.left &&
      rect.top < r.bottom &&
      rect.top + rect.height > r.top
    );
  });
}

/**
 * 小人压住了东西时缩向哪边；没压住是 null。
 * 用户自己拖到边上半隐藏的（docked），位置是他选的、不换边：贴右边时压住表格、按钮缩成最右边的一条（edge）；
 * 贴左边的只压着侧栏边，不动。真的压住了右侧的详情面板时是 panel。
 */
function coveredSide(rect: Rect, dock: FloatingDock): YieldSideState {
  const docked = dock !== 'free';
  const width = document.documentElement.clientWidth,
    near: 'left' | 'right' = rect.left + mascotSize.width / 2 < width / 2 ? 'left' : 'right';
  const panel = mascotOverPanel(rect);
  const covered = panel || ((!docked || dock === 'dock-right') && mascotCovers(rect));
  if (!covered) return null;
  if (panel) return 'panel';
  if (docked) return 'edge';
  // 缩向哪一边：按缩过去以后屏幕上实际露出的那一条（yieldStrip）算压住多少东西。会压到左侧导航的一边不去，
  // 两边都不压导航时，近的那边压得不比另一边多就留在近的那边（chooseYieldSide）。
  // 缩到右边正好压在打开的详情面板上时，和压住面板一样只留一条小边、面板让出来。
  const cost = (s: YieldSide) => {
    const strip = yieldStrip(s, rect, width);
    return { hits: mascotCoverage(strip), nav: overNavigation(strip) };
  };
  const chosen = chooseYieldSide(near, { left: cost('left'), right: cost('right') });
  return chosen === 'right' && mascotOverPanel(yieldStrip('right', rect, width)) ? 'panel' : chosen;
}

/** 打开了窗口、用顶栏入口（launcherHidden）、手机、正在拖时停下不看、不让位 */
type YieldWatch = {
  open: boolean;
  launcherHidden: boolean;
  phone: boolean;
  moving: boolean;
  dock: FloatingDock;
  left: number;
  top: number;
};

/**
 * 盯着页面看小人压没压住东西：页面变了、滚动、窗口变了、换页时重新量。压住了马上让；
 * 移开后等一会儿再回来，滚动时不来回跳。
 */
function useYieldSide({ open, launcherHidden, phone, moving, dock, left, top }: YieldWatch) {
  const [yieldSide, setYieldSide] = useState<YieldSideState>(null);
  useEffect(() => {
    if (open || launcherHidden || phone || moving) {
      setYieldSide(null);
      return;
    }
    let frame = 0,
      back = 0,
      timer = 0;
    const check = () => {
      frame = 0;
      const side = coveredSide({ left, top, ...mascotSize }, dock);
      if (side) {
        window.clearTimeout(back);
        back = 0;
        setYieldSide(side);
      } else if (!back)
        back = window.setTimeout(() => {
          back = 0;
          setYieldSide(null);
        }, 700);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    // 页面内容变化很频繁，隔一会儿看一次就够了。
    const observer = new MutationObserver(() => {
      if (!timer)
        timer = window.setTimeout(() => {
          timer = 0;
          schedule();
        }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    window.addEventListener('hashchange', schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('hashchange', schedule);
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(back);
      window.clearTimeout(timer);
    };
  }, [open, launcherHidden, phone, moving, dock, left, top]);
  return yieldSide;
}

/**
 * 缩到详情面板旁边时，给页面一个标记：详情面板往左让出小人露出的那一条（src/ui/areas/admin.css）。
 * 露多宽、鼠标移上去探出多少由这里设成变量，CSS 只读变量，两边不会对不上
 */
function usePanelYieldMark(yieldSide: YieldSideState) {
  useEffect(() => {
    const root = document.documentElement,
      over = yieldSide === 'panel';
    root.classList.toggle('ga-yield-over-panel', over);
    if (over) {
      root.style.setProperty('--ga-yield-peek', yieldPeek + 'px');
      root.style.setProperty('--ga-yield-reveal', yieldReveal + 'px');
    }
    return () => {
      root.classList.remove('ga-yield-over-panel');
      root.style.removeProperty('--ga-yield-peek');
      root.style.removeProperty('--ga-yield-reveal');
    };
  }, [yieldSide]);
}

/** 让位时小人放哪：缩到左边一半在屏幕外，压住面板或贴右边的只露 yieldPeek，缩到右边一半在屏幕外 */
function yieldLeft(yieldSide: Exclude<YieldSideState, null>) {
  if (yieldSide === 'left') return -mascotSize.width / 2;
  if (yieldSide === 'panel' || yieldSide === 'edge')
    return document.documentElement.clientWidth - yieldPeek;
  return document.documentElement.clientWidth - mascotSize.width / 2;
}

export function useMascotYield({
  open,
  floatingLauncher,
  phone,
  floating,
}: {
  open: boolean;
  floatingLauncher: boolean;
  phone: boolean;
  floating: ReturnType<typeof useFloatingAssistant>;
}) {
  // 悬浮小人压住按钮、表格、分页时，缩到最近的屏幕边上，只露出一点；鼠标移上去会探出来，点开照常。
  // 真的压住了右侧的详情面板时（panel，包括停靠在右边半隐藏、压住面板右边缘的）：小人缩到屏幕最右边只留一条小边
  // （yieldPeek），详情面板往左让出这一条，小人不压住面板里的任何文字和按钮；鼠标移上去照样探出来，点开、拖回来都照常。
  // 原来在左边或别处、没压住面板的不动。
  const yieldSide = useYieldSide({
    open,
    launcherHidden: !floatingLauncher,
    phone,
    moving: floating.moving,
    dock: floating.dock,
    left: Number(floating.style.left) || 0,
    top: Number(floating.style.top) || 0,
  });
  const mascotPose: FloatingDock = yieldSide
    ? yieldSide === 'left'
      ? 'dock-left'
      : 'dock-right'
    : floating.dock;
  usePanelYieldMark(yieldSide);
  const launcherStyle = yieldSide ? { ...floating.style, left: yieldLeft(yieldSide) } : floating.style;
  return { yieldSide, mascotPose, launcherStyle };
}
