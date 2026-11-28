import { useMemo, useRef, useState } from 'react';
import { shouldOpenUpward } from './combobox-placement';

export type ComboOption = { value: string; label: string; hint?: string; keywords?: string };

/** 可搜索下拉：客户、产品这类选项多的字段用它代替原生 select。 */
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
    [active, setActive] = useState(0),
    [upward, setUpward] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // 打开时量一次往哪边开：靠近窗口底边、下面放不下就往上开，不被正文截掉、被底栏盖住
  const openList = () => {
    if (!open && input.current) setUpward(shouldOpenUpward(input.current));
    setOpen(true);
  };
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
  const choose = (option?: ComboOption) => {
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    setQuery('');
  };
  return (
    // data-value 给必填引导看“选了没有”（输入框里显示的是选项文字，不能拿来判断）
    <div className="combobox" data-value={selected?.value ?? ''}>
      <input
        ref={input}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        required={required && !selected}
        disabled={disabled}
        placeholder={selected ? selected.label : placeholder}
        value={open ? query : selected?.label || ''}
        onFocus={() => {
          openList();
          setActive(0);
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          openList();
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openList();
            setActive((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && open) {
            e.preventDefault();
            choose(matches[active]);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
            setQuery('');
          }
        }}
      />
      {open && (
        <ul className={'combobox-list' + (upward ? ' upward' : '')} role="listbox" aria-label={ariaLabel}>
          {matches.map((option, index) => (
            <li
              key={option.value}
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
