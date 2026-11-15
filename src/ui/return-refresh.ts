import { emit } from './events';

/**
 * 服务器不推送：别的设备、别的人改了数据，这边靠自己重新取。从别的窗口、别的应用切回这个页面时
 * （页面重新可见、窗口重新拿到焦点）发一次 erp-business-changed，导航数字和眼前的列表都重新取。
 * 两种事件常常一起来，离上一次不到 RETURN_REFRESH_GAP_MS 的不重复发。全站只在 App 里装一次。
 */
export const RETURN_REFRESH_GAP_MS = 5_000;

/** 切回来时该不该发：只有页面可见时才发，离上一次太近的不发。now、visible 由调用方给，便于单独测 */
export function returnRefresher(gap = RETURN_REFRESH_GAP_MS) {
  let last = -Infinity;
  return (now: number, visible: boolean) => {
    if (!visible || now - last < gap) return false;
    last = now;
    return true;
  };
}

/** 装上切回来自动重新取的监听，返回卸下的函数 */
export function refreshOnReturn() {
  const should = returnRefresher();
  const check = () => {
    if (should(Date.now(), document.visibilityState === 'visible')) emit('erp-business-changed');
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  return () => {
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check);
  };
}
