import { useEffect, useState } from 'react';
import { hashParams } from '../ui/index';
import { today } from '../../shared/core/index';

/* 财务各页的页面状态：看哪个月（这次打开里记住）、哪个页签（写进地址），和地址写的那一节滚到眼前。 */

const PERIOD_KEY = 'erp-finance-period';
export function usePeriod() {
  const [period, set] = useState(() => sessionStorage.getItem(PERIOD_KEY) || today().slice(0, 7));
  return [
    period,
    (v: string) => {
      if (!v) return;
      sessionStorage.setItem(PERIOD_KEY, v);
      set(v);
    },
  ] as const;
}
/**
 * 页签写进地址，刷新或从别处跳转都能回到同一页签。
 * sectionTabs：页签里某一节的名字 → 它所在的页签（例如 held → items），地址写节名也能打开那个页签；
 * 第三项返回地址里原来写的名字，页面用它滚到对应的那一节。
 */
export function useTab(first: string, sectionTabs: Record<string, string> = {}) {
  const raw = () => hashParams().get('tab') || first;
  const [requested, set] = useState(raw);
  // 必须只注册一次：App 处理同一事件时会同步重渲染，每次渲染都重新注册的话，
  // 这个监听会在派发途中被移除，页签就跟不上地址了。
  useEffect(() => {
    const listener = () =>
      set(hashParams().get('tab') || first);
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, [first]);
  const tab = sectionTabs[requested] ?? requested;
  return [
    tab,
    (next: string) => {
      const [base, query] = location.hash.split('?');
      const params = new URLSearchParams(query || '');
      params.set('tab', next);
      history.replaceState(null, '', base + '?' + params);
      set(next);
    },
    requested,
  ] as const;
}
/** 地址写的是某一节（例如 tab=deposits）时，把那一节滚到眼前。 */
export function useFocusSection(requested: string, sections: string[]) {
  // 只在进来（地址里写的节变了）时滚一次；各页每次渲染传的是新数组，只看“写的是不是这页的一节”
  const known = sections.includes(requested);
  useEffect(() => {
    if (!known) return;
    const timer = window.setTimeout(() => {
      const section = document.getElementById('fin-sec-' + requested);
      // 默认收起的一节先展开
      if (section instanceof HTMLDetailsElement) section.open = true;
      section?.scrollIntoView({ block: 'start' });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [requested, known]);
}
