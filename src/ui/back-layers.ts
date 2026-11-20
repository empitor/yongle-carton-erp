import { useEffect, useRef } from 'react';

/*
 * 安卓 App 的返回键按层级关窗用的弹层登记（入口在 src/app-bridge.ts）：
 * 弹窗、详情面板、助手窗口、菜单这类“一层”打开时登记自己的关闭函数（和 × 同一个）和是不是正在提交，关掉时注销。
 * 登记的层都挂在页面最外层（document.body 下）或只在打开时挂上，挂着就看得见，不另判断。
 * 浏览器和 Windows 外壳里登记了也没人调，行为不变。
 */

type Layer = { close: () => void; busy: () => boolean };

const layers: Layer[] = [];
/** 等弹层都关掉的（安卓 App 分享来的文件要等窗口关了再跳到 AI 导入） */
const waiting = new Set<() => void>();

/** 弹层都关了：等这一轮渲染走完（同一次提交里可能关一层、开一层）再看，还是没有才通知 */
function settle() {
  queueMicrotask(() => {
    if (layers.length) return;
    const due = [...waiting];
    waiting.clear();
    for (const fn of due) fn();
  });
}

/** 登记一层，返回注销函数。后登记的在上面 */
export function registerBackLayer(layer: Layer): () => void {
  layers.push(layer);
  return () => {
    const at = layers.indexOf(layer);
    if (at < 0) return;
    layers.splice(at, 1);
    if (!layers.length) settle();
  };
}

/** 现在有没有开着的弹层 */
export const hasBackLayer = () => layers.length > 0;

/** 弹层都关掉后调一次 fn，返回取消函数 */
export function afterBackLayersClosed(fn: () => void): () => void {
  waiting.add(fn);
  return () => {
    waiting.delete(fn);
  };
}

/**
 * 关最上面一层：正在提交就不关、留在这一层（stayed）；否则调它自己的关闭函数（closed），
 * 未保存提醒之类由关闭函数自己处理。没有弹层返回 none。
 */
export function closeTopLayer(): 'closed' | 'stayed' | 'none' {
  const top = layers.at(-1);
  if (!top) return 'none';
  if (top.busy()) return 'stayed';
  top.close();
  return 'closed';
}

/** 组件里登记自己这一层。active 为假时不登记（例如菜单没打开）。close、busy 每次渲染取最新的。 */
export function useBackLayer(close: () => void, options: { busy?: boolean; active?: boolean } = {}) {
  const { busy = false, active = true } = options;
  const latest = useRef({ close, busy });
  useEffect(() => {
    latest.current = { close, busy };
  });
  useEffect(() => {
    if (!active) return;
    return registerBackLayer({ close: () => latest.current.close(), busy: () => latest.current.busy });
  }, [active]);
}
