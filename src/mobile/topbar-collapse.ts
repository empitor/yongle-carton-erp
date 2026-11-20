import { useEffect, type RefObject } from 'react';
import { useIsPhone } from '../ui/index';

/*
 * 手机宽度下的顶栏（搜索、新建、账号）跟着滚动收起：往下滚时跟手往上收、内容同时淡出，往回滚时跟手露出；
 * 手指离开、滚动停下时停在半路的吸附到收起或露出（样子参考 B 站首页顶栏）。只动位移和透明度，不改排版。
 * 滚到头的拉伸回弹不改变滚动位置，所以不带动顶栏。不是手机宽度时不挂监听。
 */

/** 手指离开后滚动停下多久算停稳、开始吸附 */
const SETTLE_DELAY_MS = 120;
const SETTLING = 'topbar-settling';

/**
 * 跟手：往下滚（delta 为正）收起、往上滚露出。收起的距离不超过顶栏高度，也不超过已经滚动的距离（回到顶部时一定全露出）。
 */
export function followScroll(hidden: number, delta: number, scrollY: number, height: number): number {
  return Math.max(0, Math.min(hidden + delta, height, scrollY));
}

/** 停下时吸附：收了一半以上就收完（离顶部不够一个顶栏时只收到顶部为止），否则全露出 */
export function settle(hidden: number, scrollY: number, height: number): number {
  return hidden * 2 >= height ? Math.min(height, Math.max(0, scrollY)) : 0;
}

/** 滚动位置限制在 0 到最大值之间：边界回弹时浏览器可能报出界外的值，不算 */
const clampedScroll = () =>
  Math.min(Math.max(window.scrollY, 0), Math.max(0, document.documentElement.scrollHeight - window.innerHeight));

/** 给顶栏元素接上收起：写 --topbar-hidden（收起多少像素）和 --topbar-fade（内容透明度），样式在 topbar.css */
export function useTopbarCollapse(ref: RefObject<HTMLElement | null>) {
  const phone = useIsPhone();
  useEffect(() => {
    const bar = ref.current;
    if (!bar || !phone) return;
    let hidden = 0,
      last = clampedScroll(),
      touching = false,
      timer = 0,
      height = bar.offsetHeight;
    // 顶栏高度只在它变了时读：滚动时先改样式再读布局，每次都会逼浏览器把样式和布局重算一遍
    const resized = new ResizeObserver(() => {
      height = bar.offsetHeight;
    });
    resized.observe(bar);
    const apply = (value: number, settling: boolean) => {
      hidden = value;
      bar.classList.toggle(SETTLING, settling);
      bar.style.setProperty('--topbar-hidden', `${value}px`);
      bar.style.setProperty('--topbar-fade', String(1 - value / Math.max(1, height)));
    };
    const scheduleSettle = () => {
      window.clearTimeout(timer);
      if (touching) return;
      timer = window.setTimeout(() => apply(settle(hidden, last, height), true), SETTLE_DELAY_MS);
    };
    const onScroll = () => {
      const y = clampedScroll(),
        delta = y - last;
      last = y;
      apply(followScroll(hidden, delta, y, height), false);
      scheduleSettle();
    };
    const onTouch = (e: TouchEvent) => {
      touching = e.type === 'touchstart';
      scheduleSettle();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('touchstart', onTouch, { passive: true });
    window.addEventListener('touchend', onTouch, { passive: true });
    window.addEventListener('touchcancel', onTouch, { passive: true });
    return () => {
      window.clearTimeout(timer);
      resized.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('touchstart', onTouch);
      window.removeEventListener('touchend', onTouch);
      window.removeEventListener('touchcancel', onTouch);
      apply(0, false);
    };
  }, [ref, phone]);
}
