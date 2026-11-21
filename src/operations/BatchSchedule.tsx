import { Plus, Trash2 } from 'lucide-react';
import type { ScheduleEntry } from '../../shared/business/index';
import { safeUnits } from '../../shared/core/index';
import { quantityString } from '../../shared/core/index';

/** 到货安排的一段：数量（和库存一样的数量文本）+ 截止日期。 */
export type ScheduleDraft = { quantity: string; dueDate: string };
/** 订货单视图、导出预览里一行的到货安排一段：系统补的“日期未定”那段带 implicit */
type ScheduleSegment = Pick<ScheduleEntry, 'quantityUnits' | 'dueDate'> & { implicit?: boolean };
/** 窗口里每行纸板正在填的到货安排，按行的合并依据（key）记 */
export type RowDrafts = Record<string, ScheduleDraft[]>;
/** 订货单、导出预览的一行里到货安排要用的：合并依据、名称、订购数、现有的到货安排 */
type ScheduleRow = { key: string; name: string; orderedUnits: number; schedule: readonly ScheduleSegment[] };

/** 读不出来的数是 NaN，后面的校验会拦下 */
const units = (v: string) => safeUnits(v, NaN);

/** 每一段都要写数量和日期，合计不能超过订购数。返回出错的那句话，没有错返回空串。 */
function scheduleError(name: string, orderedUnits: number, list: ScheduleDraft[]) {
  for (const e of list) {
    const q = units(e.quantity);
    if (!e.quantity.trim() || !Number.isFinite(q) || q <= 0)
      return name + '：到货安排每一段都要写数量。';
    if (!e.dueDate) return name + '：到货安排每一段都要写日期，不写日期的部分不用加。';
  }
  const sum = list.reduce((n, e) => n + units(e.quantity), 0);
  if (sum > orderedUnits) return name + '：到货安排合计比订货数量多。';
  return '';
}

/** 各行到货安排里第一处填错的那句话；都填对了是空串 */
export const scheduleProblem = (rows: readonly ScheduleRow[], drafts: RowDrafts) =>
  rows.map((r) => scheduleError(r.name, r.orderedUnits, drafts[r.key] || [])).find(Boolean) || '';

/** 从批次视图里的到货安排取出可编辑的几段（系统补的“日期未定”那段不算）。 */
const scheduleDrafts = (schedule: readonly ScheduleSegment[]): ScheduleDraft[] =>
  schedule.flatMap((s) =>
    !s.implicit && s.dueDate ? [{ quantity: quantityString(s.quantityUnits), dueDate: s.dueDate }] : [],
  );

/** 打开窗口时各行可编辑的到货安排 */
export const rowDrafts = (rows: readonly ScheduleRow[]): RowDrafts =>
  Object.fromEntries(rows.map((r): [string, ScheduleDraft[]] => [r.key, scheduleDrafts(r.schedule)]));

/** 提交给服务端的到货安排 */
export const scheduleBody = (drafts: RowDrafts) =>
  Object.entries(drafts).flatMap(([rowKey, list]) =>
    list.map((e) => ({ rowKey, quantity: e.quantity.trim(), dueDate: e.dueDate })),
  );

/**
 * 一行纸板的到货安排：拆成几段“多少在哪天之前到”，日期可以不定。
 * 没写的部分显示“其余 x 日期待定”。
 */
export default function BatchSchedule({
  name,
  unit,
  orderedUnits,
  value,
  onChange,
  disabled,
}: {
  name: string;
  unit: string;
  orderedUnits: number;
  value: ScheduleDraft[];
  onChange: (v: ScheduleDraft[]) => void;
  disabled?: boolean;
}) {
  const planned = value.reduce(
    (n, e) => n + (Number.isFinite(units(e.quantity)) ? units(e.quantity) : 0),
    0,
  );
  const rest = orderedUnits - planned;
  const set = (i: number, patch: Partial<ScheduleDraft>) =>
    onChange(value.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <div className="ob-schedule">
      {value.map((e, i) => (
        <div className="ob-schedule-line" key={i}>
          <input
            aria-label={name + ' 第' + (i + 1) + '段数量'}
            inputMode="decimal"
            value={e.quantity}
            disabled={disabled}
            onChange={(ev) => set(i, { quantity: ev.target.value })}
          />
          <span>{unit}，</span>
          <input
            type="date"
            aria-label={name + ' 第' + (i + 1) + '段截止日期'}
            value={e.dueDate}
            disabled={disabled}
            onChange={(ev) => set(i, { dueDate: ev.target.value })}
          />
          <span>前到</span>
          <button
            type="button"
            className="icon-button"
            aria-label={'删掉 ' + name + ' 第' + (i + 1) + '段'}
            disabled={disabled}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="ob-schedule-foot">
        <small>
          {rest > 0
            ? (value.length ? '其余 ' : '') + quantityString(rest) + ' ' + unit + ' 日期待定'
            : rest < 0
              ? '合计比订货数量多 ' + quantityString(-rest) + ' ' + unit
              : '全部定了日期'}
        </small>
        {rest > 0 && (
          <button
            type="button"
            className="link-button"
            disabled={disabled}
            onClick={() => onChange([...value, { quantity: quantityString(rest), dueDate: '' }])}
          >
            <Plus size={12} aria-hidden="true" />
            定一段日期
          </button>
        )}
      </div>
    </div>
  );
}
