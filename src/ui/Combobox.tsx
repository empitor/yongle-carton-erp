import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useBackLayer } from './back-layers';
import { hidePopup, placePopup, screenView, type Rect } from './popup-position';

export type ComboOption = { value: string; label: string; hint?: string; keywords?: string };

/** 列表最宽取输入框宽和这个里大的、最高这么多（超出在列表里滚） */
const LIST_MIN_WIDTH = 280,
  LIST_MAX_HEIGHT = 260;

/**
 * 可搜索下拉：客户、产品这类选项多的字段用它代替原生 select。
 * 列表放进浏览器顶层、按输入框在屏幕上的位置摆（src/ui/popup-position.ts，和“更多”菜单同一套），
 * 不被明细表、窗口正文、详情面板截掉；手机弹出键盘时只按键盘上面那块摆。任何一层滚动、窗口变大小都跟着重摆，
 * 输入框滚出能看见的范围时收起。安卓返回键先收起列表、再关窗口。
 */
export default function Combobox({
  value,
  options,
  onChange,
  placeholder = '输入搜索或选择',
  ariaLabel,
  required = false,
  disabled = false,
}: {
  value: string;
  options: ComboOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null),
    listRef = useRef<HTMLUListElement>(null);
  const listId = useId(),
    optionId = (index: number) => listId + '-' + index;
  const close = () => {
    setOpen(false);
    setQuery('');
  };
  useBackLayer(close, { active: open });
  const selected = options.find((o) => o.value === String(value));
  const { matches, hidden } = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = options.filter((o) => {
      const text = (o.label + ' ' + (o.hint || '') + ' ' + (o.keywords || '')).toLowerCase();
      return terms.every((t) => text.includes(t));
    });
    // 只画前 50 条，选项再多也不卡；其余的靠搜索找到。
    return { matches: all.slice(0, 50), hidden: Math.max(0, all.length - 50) };
  }, [options, query]);
  useListPlacement(open, listRef, input, matches.length + '/' + hidden, close);
  // 上下键移到的那一项滚进列表看得见的地方
  useEffect(() => {
    if (open) document.getElementById(listId + '-' + active)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, listId]);
  const choose = (option?: ComboOption) => {
    if (!option) return;
    onChange(option.value);
    close();
  };
  const openList = () => {
    setOpen(true);
    setActive(0);
  };
  return (
    // data-value 给必填引导看“选了没有”（输入框里显示的是选项文字，不能拿来判断）
    <div className="combobox" data-value={selected?.value ?? ''}>
      <input
        ref={input}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && matches[active] ? optionId(active) : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        required={required && !selected}
        disabled={disabled}
        placeholder={selected ? selected.label : placeholder}
        value={open ? query : selected?.label || ''}
        onFocus={openList}
        // 按 Esc 收起后输入框还有焦点，再点一下不会再触发 focus：点了就重新打开
        onClick={() => {
          if (!open) openList();
        }}
        onBlur={close}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && open) {
            e.preventDefault();
            choose(matches[active]);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            close();
          }
        }}
      />
      {open && (
        // tabIndex -1：列表能滚，浏览器会把它排进 Tab 顺序；焦点一直留在输入框（选项靠 aria-activedescendant），Tab 直接到下一格。
        // 在列表上按下鼠标（拖滚动条、点提示行）不抢焦点：不然输入框一失焦，列表就收起了
        <ul
          ref={listRef}
          id={listId}
          className="combobox-list"
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
        >
          {matches.map((option, index) => (
            <li
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={option.value === String(value)}
              className={index === active ? 'active' : ''}
              // 用 mousedown 抢在输入框失焦之前选中。
              onMouseDown={(e) => {
                e.preventDefault();
                choose(option);
              }}
              onMouseEnter={() => setActive(index)}
            >
              <span>{option.label}</span>
              {option.hint && <small>{option.hint}</small>}
            </li>
          ))}
          {!matches.length && <li className="combobox-empty">没有匹配项</li>}
          {hidden > 0 && <li className="combobox-empty">还有 {hidden} 项，输入关键词缩小范围</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * 打开时、列表内容变了（打字筛过，content 变了）时摆一次；开着的时候哪一层滚动、窗口变大小（含手机弹出键盘）都跟着重摆，
 * 输入框滚出能看见的范围就调 gone 收起。收起、卸下时从顶层拿下来
 */
function useListPlacement(
  open: boolean,
  listRef: RefObject<HTMLUListElement | null>,
  input: RefObject<HTMLInputElement | null>,
  content: string,
  gone: () => void,
) {
  const latestGone = useRef(gone);
  useEffect(() => {
    latestGone.current = gone;
  });
  useLayoutEffect(() => {
    const list = listRef.current,
      field = input.current;
    if (!open || !list || !field) return;
    const place = () =>
      placePopup(list, field, {
        align: 'start',
        view: visibleView(),
        width: Math.max(field.offsetWidth, LIST_MIN_WIDTH),
        maxHeight: LIST_MAX_HEIGHT,
      });
    place();
    let frame = 0;
    const follow = (e: Event) => {
      // 列表自己在滚（翻看选项）不用重摆
      if (e.target instanceof Node && list.contains(e.target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => (scrolledOut(field) ? latestGone.current() : place()));
    };
    const viewport = window.visualViewport;
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    viewport?.addEventListener('resize', follow);
    viewport?.addEventListener('scroll', follow);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
      viewport?.removeEventListener('resize', follow);
      viewport?.removeEventListener('scroll', follow);
      hidePopup(list);
    };
  }, [open, listRef, input, content]);
}

// 只有可搜索下拉用的两样：按还能看见的那段摆、输入框滚出看不见就收起（放在这里，免得跟着“更多”菜单进首屏）
/** 还能看见的那段：手机弹出键盘后只剩键盘上面那块（visualViewport），没有就是整个窗口 */
function visibleView(): Rect {
  const v = window.visualViewport;
  return v ? { top: v.offsetTop, left: v.offsetLeft, right: v.offsetLeft + v.width, bottom: v.offsetTop + v.height } : screenView();
}

/** el 是不是已经滚出了能看见的范围：外面哪一层会截内容（overflow 不是 visible）的，或者整个窗口，有一层把它整个截掉就算 */
function scrolledOut(el: Element) {
  const r = el.getBoundingClientRect();
  const outside = (a: Rect) => r.bottom <= a.top || r.top >= a.bottom || r.right <= a.left || r.left >= a.right;
  if (outside(visibleView())) return true;
  for (let p = el.parentElement; p; p = p.parentElement)
    if (getComputedStyle(p).overflowY !== 'visible' && outside(p.getBoundingClientRect())) return true;
  return false;
}
