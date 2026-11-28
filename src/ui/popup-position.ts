/*
 * 浮在顶层的弹出列表（“更多”菜单、可搜索下拉）怎么摆，全站只有这一套：
 * 列表放进浏览器顶层（popover），按触发它的元素在屏幕上的位置算固定坐标。祖先的 overflow、transform、filter、
 * backdrop-filter 都影响不到它，在弹窗、可滚动面板、横向能滚的明细表、带毛玻璃的底栏里都不会被裁掉或推偏。
 * 下面放不下、上面更宽敞就往上开，还放不下就限高、在列表里滚；贴着屏幕边也不出界。
 */

/** 屏幕上的一块：上下左右（和 getBoundingClientRect 一样按视口算） */
export type Rect = { top: number; bottom: number; left: number; right: number };

/** 列表和触发它的元素之间的间距、离屏幕边的距离 */
const GAP = 4,
  EDGE = 8;

/** 往哪边开、最多能给多高：natural 是列表不限高时的高度，view 是能看见的那块屏幕 */
export function popupSide(anchor: Rect, natural: number, view: Rect) {
  const below = view.bottom - anchor.bottom - GAP - EDGE,
    above = anchor.top - view.top - GAP - EDGE;
  return { up: natural > below && above > below, room: Math.max(below, above) };
}

/**
 * 摆在哪：start 和触发元素左边对齐（下拉），end 和右边对齐（“更多”菜单，伸出屏幕左边时改成从左边起）；
 * 两边、上下都不出界
 */
export function popupSpot(anchor: Rect, size: { width: number; height: number }, view: Rect, up: boolean, align: 'start' | 'end') {
  let left = align === 'end' ? anchor.right - size.width : anchor.left;
  if (align === 'end' && left < view.left + EDGE) left = anchor.left;
  left = Math.max(view.left + EDGE, Math.min(left, view.right - size.width - EDGE));
  const top = Math.max(view.top + EDGE, Math.min(up ? anchor.top - GAP - size.height : anchor.bottom + GAP, view.bottom - size.height - EDGE));
  return { left, top };
}

/** 整个窗口（“更多”菜单按它摆；可搜索下拉按还能看见的那段摆，见 Combobox.tsx） */
export const screenView = (): Rect => ({ top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight });

const topLayerOf = (list: HTMLElement) => typeof list.showPopover === 'function';

/**
 * 把列表放进顶层、摆到 anchor 旁边。width 给了就先定宽（按能看见的那块算），maxHeight 是列表自己的最高高度。
 * 不支持顶层的浏览器：祖先让 fixed 改了定位基准时，按实际偏出去的距离拉回来。
 */
export function placePopup(
  list: HTMLElement,
  anchor: Element,
  { align, view, width, maxHeight = Infinity }: { align: 'start' | 'end'; view: Rect; width?: number; maxHeight?: number },
) {
  if (topLayerOf(list)) {
    if (!list.hasAttribute('popover')) list.setAttribute('popover', 'manual');
    if (!list.matches(':popover-open')) list.showPopover();
  }
  const s = list.style;
  s.position = 'fixed';
  s.right = 'auto';
  s.bottom = 'auto';
  s.maxHeight = '';
  s.overflowY = 'auto';
  if (width !== undefined) s.width = Math.min(width, view.right - view.left - 2 * EDGE) + 'px';
  const r = anchor.getBoundingClientRect();
  const { up, room } = popupSide(r, list.offsetHeight, view);
  s.maxHeight = Math.min(room, maxHeight) + 'px';
  const { left, top } = popupSpot(r, { width: list.offsetWidth, height: list.offsetHeight }, view, up, align);
  s.left = left + 'px';
  s.top = top + 'px';
  const actual = list.getBoundingClientRect();
  if (Math.abs(actual.left - left) > 0.5) s.left = left - (actual.left - left) + 'px';
  if (Math.abs(actual.top - top) > 0.5) s.top = top - (actual.top - top) + 'px';
}

/** 收起：从顶层拿下来，摆放写的样式都清掉 */
export function hidePopup(list: HTMLElement) {
  if (topLayerOf(list) && list.matches(':popover-open')) list.hidePopover();
  list.style.cssText = '';
}
