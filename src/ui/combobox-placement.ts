/** 可搜索下拉的列表最高多少（和 menus.css 的 .combobox-list max-height 一致） */
export const COMBOBOX_LIST_MAX = 260;

type Span = { top: number; bottom: number };

/**
 * 列表往下开还是往上开：下面放得下就往下；下面放不下、上面放得下整张列表才往上，
 * 免得窗口里靠下的下拉被正文的滚动区截掉、被底栏盖住（数据管理编辑窗最下面那几格）。
 * 上下都放不下时往下开：往下被截掉的还能在滚动区里滚到，往上被截掉的滚不到（只有一两行的明细表）。
 * field 是输入框，area 是能看见的范围（外面各层会截掉内容的祖先和窗口叠起来剩下的那段）。
 */
export function opensUpward(field: Span, area: Span, list = COMBOBOX_LIST_MAX) {
  return area.bottom - field.bottom < list && field.top - area.top >= list;
}

/** 外面各层会截掉内容的祖先（滚动区、overflow 不是 visible 的，含横向能滚的明细表）和窗口叠起来还能看见的范围 */
function visibleArea(el: HTMLElement): Span {
  const area = { top: 0, bottom: window.innerHeight };
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowY === 'visible') continue;
    const r = p.getBoundingClientRect();
    area.top = Math.max(area.top, r.top);
    area.bottom = Math.min(area.bottom, r.bottom);
  }
  return area;
}

/** 这个输入框的下拉该不该往上开（打开的那一刻量一次） */
export const shouldOpenUpward = (input: HTMLElement) => opensUpward(input.getBoundingClientRect(), visibleArea(input));
