import type { FlowKind } from '../../shared/core/index';
import type { ReactNode } from 'react';
import { flowStatusChoices } from '../../shared/business/index';
import { FilterRow } from '../ui/index';

/** 单据页、到货送货页“筛选”里的状态下拉：选项是这一类单据界面上的状态叫法。 */
export function StatusFilter({
  kind,
  label,
  value,
  change,
}: {
  kind: FlowKind;
  label: string;
  value: string;
  change: (value: string) => void;
}) {
  return (
    <FilterRow label={label}>
      <select aria-label="按状态筛选" value={value} onChange={(e) => change(e.target.value)}>
        <option value="">全部状态</option>
        {flowStatusChoices[kind].map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
    </FilterRow>
  );
}

/**
 * 单据页、到货送货页列表空着时：说一句为什么空；有搜索或筛选时给“清除筛选”，
 * 没有时给这一页的下一步（安排生产、登记完工、安排送货，可以没有）。读取中只说在读。
 */
export function ListEmpty({
  text,
  busy,
  filtered,
  clear,
  next,
}: {
  text: string;
  busy: boolean;
  filtered: boolean;
  clear: () => void;
  next?: ReactNode;
}) {
  return (
    <div className="empty-state flow-empty">
      <span>{text}</span>
      {!busy &&
        (filtered ? (
          <button className="secondary" onClick={clear}>
            清除筛选
          </button>
        ) : (
          next
        ))}
    </div>
  );
}
