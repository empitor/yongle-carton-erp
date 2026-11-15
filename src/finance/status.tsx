import type { ReactNode } from 'react';
import { StatusChip, type Tone } from '../ui/index';
import { financeStatuses, monthlyRowStatus } from '../../shared/finance/index';

/* 财务各页的状态标签。叫法和颜色档在 shared/finance/labels.ts，导出用同一份。 */

export function Status({ value }: { value: unknown }) {
  const [text, tone] = financeStatuses[String(value)] || [String(value ?? '—'), 'muted'];
  return (
    <span className="business-status" data-tone={tone}>
      {text}
    </span>
  );
}
/** 月度台账、概览明细的一行（状态要看的几项见 shared/finance/labels.ts 的 monthlyRowStatus） */
type MonthlyRow = Parameters<typeof monthlyRowStatus>[0];
/** 月度台账、概览明细一行的状态；空的写“—” */
export function flowStatus(row: MonthlyRow): readonly [string, string] {
  const [text, level] = monthlyRowStatus(row);
  return [text || '—', level];
}
export function FlowStatus({ row }: { row: MonthlyRow }) {
  const [text, tone] = flowStatus(row);
  return (
    <span className="business-status" data-tone={tone}>
      {text}
    </span>
  );
}
/** 状态的颜色档（muted、warning、info、success）换成状态标签的色调；详情面板头部用：待确认灰、进行中蓝、完成绿、取消黄、作废红。 */
export const chipTones: Record<string, Tone> = {
  muted: 'neutral',
  warning: 'warning',
  info: 'accent',
  success: 'success',
};
const chipOverrides: Record<string, Tone> = {
  void: 'danger',
  cancelled: 'warning',
  rejected: 'warning',
};
function statusTone(value: unknown): Tone {
  const key = String(value);
  return chipOverrides[key] ?? chipTones[financeStatuses[key]?.[1] ?? 'muted'] ?? 'neutral';
}
export function FinStatusChip({ value, children }: { value: unknown; children?: ReactNode }) {
  return (
    <StatusChip tone={statusTone(value)}>
      {children ?? financeStatuses[String(value)]?.[0] ?? String(value ?? '—')}
    </StatusChip>
  );
}

/** 红字（冲销）凭证的标记：分录和原凭证同方向，金额按负数计 */
export function RedInk() {
  return <StatusChip tone="danger">红字</StatusChip>;
}
