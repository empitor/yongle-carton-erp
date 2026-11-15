import type { ReactNode } from 'react';
import { Hint } from '../ui/index';
import type { TodayRowData } from './today-groups';

/** 今日待办的一行：单号 · 客户和产品 · 状态 · 交期或逾期 · 一个动作；有规格提示时显示在这一行下面。 */
export default function TodayRow({ row: r, action }: { row: TodayRowData; action?: ReactNode }) {
  return (
    <li className={'td-row' + (r.hints?.length ? ' has-hint' : '')}>
      <a className="td-row-main" href={r.href}>
        {r.number && <span className="td-no">{r.number}</span>}
        <span className="td-text" title={r.main}>
          {r.main}
        </span>
        {r.ai && <span className="td-ai">AI 导入</span>}
        {r.status && <span className="td-status">{r.status}</span>}
        {r.late ? <span className="td-late">逾期 {r.late} 天</span> : r.note && <span className="td-note">{r.note}</span>}
      </a>
      {action && <span className="td-act">{action}</span>}
      {!!r.hints?.length && (
        <div className="td-hints">
          {r.hints.map((hint) => (
            <Hint tone="warning" key={hint}>
              {hint}
            </Hint>
          ))}
        </div>
      )}
    </li>
  );
}
