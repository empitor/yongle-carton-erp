import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { RecordSort } from '../../shared/core/index';

type Column = 'first' | 'due';

/** 点一下换成哪种排序 */
function nextSort(column: Column, sort: RecordSort): RecordSort {
  if (column === 'due') return sort === 'due' ? 'recent' : 'due';
  return sort === 'recent' ? 'name' : sort === 'name' ? 'oldest' : 'recent';
}

/** 现在按什么排（按钮的提示里用） */
function sortHint(column: Column, sort: RecordSort, text: string) {
  if (column === 'due') return '按日期从近到远';
  return sort === 'name' ? '按' + text + '排' : sort === 'oldest' ? '最早的在前' : '最新的在前';
}

/**
 * 能点着排序的表头：首列（单号 / 名称）在“最新在前 → 按名称 → 最早在前”之间切换；交期列在“按交期 → 最新在前”之间切换。
 */
export default function SortHead({
  text,
  column,
  className,
  sort,
  onSort,
}: {
  text: string;
  column: Column;
  className?: string;
  sort: RecordSort;
  onSort: (next: RecordSort) => void;
}) {
  const active = column === 'due' ? sort === 'due' : sort !== 'due';
  const hint = sortHint(column, sort, text);
  const ascending = column === 'due' || sort === 'name' || sort === 'oldest';
  const Icon = !active ? ArrowUpDown : ascending ? ArrowUp : ArrowDown;
  return (
    <th
      className={className}
      aria-sort={!active ? 'none' : ascending ? 'ascending' : 'descending'}
    >
      <button
        type="button"
        className={'th-sort' + (active ? ' is-active' : '')}
        title={active ? '现在' + hint + '，点一下换排序' : '点一下按这一列排序'}
        onClick={() => onSort(nextSort(column, sort))}
      >
        {text}
        <Icon size={12} aria-hidden="true" />
        {active && sort !== 'recent' && column === 'first' && <small>{sort === 'name' ? '按名称' : '最早'}</small>}
      </button>
    </th>
  );
}
