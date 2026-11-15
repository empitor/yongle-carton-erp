import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { FlowDocView } from '../../shared/business/index';
import { Combobox, FormField, FormSection, RowDelete } from '../ui/index';
import { sumByUnit } from '../ui/index';
import { FINISHED_UNIT } from '../../shared/core/index';
import { remainingText as remaining, waitingText } from './task-progress';

type TaskView = FlowDocView<'task'>;
/**
 * 登记完工窗口要看的一张任务：编号、状态、产品、计划数和单位，计划日、已完工、待入库、进度、归档
 * （单据页传进来的任务视图带上产品名；只读这些，没有的按没登记过算）
 */
export type CompletionTask = Pick<TaskView, 'id' | 'number' | 'status' | 'productId' | 'quantity' | 'unit'> &
  Partial<Pick<TaskView, 'date' | 'plannedDate' | 'completed' | 'pendingCompleted' | 'progress' | 'archived'>> & {
    productName?: string;
  };
/** 表里的一行任务：第几个加进来、勾没勾、合格和报废 */
export type CompletionRow = CompletionTask & { order: number; checked: boolean; good: string; scrap: string };
/** 一行里人能改的：勾选、合格、报废 */
type RowPatch = Partial<Pick<CompletionRow, 'checked' | 'good' | 'scrap'>>;

/** 登记完工窗口里的一行任务：合格数预填为任务还差的数量 */
export const completionRow = (t: CompletionTask, order: number, checked: boolean): CompletionRow => ({
  ...t,
  order,
  checked,
  good: remaining(t),
  scrap: '0',
});

/**
 * 登记完工窗口里“做完了哪些任务 / 做完多少”：从页头进来勾选做完的任务，从一张任务进来只列这一张、能再加任务；
 * 每行填合格和报废。改了任何一格都调 changed（窗口据此作废已看过的领料分配）。
 */
export default function CompletionTasks({
  picking,
  rows,
  setRows,
  others,
  productName,
  changed,
}: {
  /** 从页头进来：列出全部没做完的任务让人勾选 */
  picking: boolean;
  rows: CompletionRow[];
  setRows: (update: (rows: CompletionRow[]) => CompletionRow[]) => void;
  /** 还能再加的任务（没做完、还不在表里的） */
  others: CompletionTask[];
  productName: (r: CompletionTask) => string | undefined;
  changed: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const rowChange = (id: number, patch: RowPatch) => {
    changed();
    setRows((v) => v.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const remove = (id: number) => {
    changed();
    setRows((v) => v.filter((x) => x.id !== id));
  };
  const chosen = rows.filter((r) => r.checked),
    allChecked = rows.length > 0 && rows.every((r) => r.checked),
    multiple = chosen.length > 1;
  return (
      <FormSection
        title={picking ? '做完了哪些任务' : '做完多少'}
        hint="合格数量预填为任务还差的数量（已扣掉登记过、待核对入库的），按实际改；报废和合格同一单位。"
        columns={1}
        extra={
          !picking && others.length > 0 && !adding ? (
            <button type="button" className="secondary" onClick={() => setAdding(true)}>
              <Plus size={14} aria-hidden="true" />
              再加任务
            </button>
          ) : undefined
        }
      >
        {rows.length ? (
          <div className="line-table pb-tasks">
            <table>
              <thead>
                <tr>
                  {picking && (
                    <th className="wh-check">
                      <input
                        type="checkbox"
                        aria-label="全选任务"
                        checked={allChecked}
                        onChange={(e) => {
                          const checked = e.currentTarget.checked;
                          changed();
                          setRows((v) => v.map((r) => ({ ...r, checked })));
                        }}
                      />
                    </th>
                  )}
                  <th>任务</th>
                  <th className="num">合格</th>
                  <th className="num">报废</th>
                  {!picking && <th aria-label="操作" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <TaskRow
                    key={r.id}
                    r={r}
                    picking={picking}
                    alone={rows.length === 1}
                    productName={productName}
                    change={(patch) => rowChange(r.id, patch)}
                    remove={() => remove(r.id)}
                  />
                ))}
              </tbody>
              {multiple && (
                <tfoot>
                  <tr>
                    {picking && <td />}
                    <td>合计 {chosen.length} 张任务</td>
                    <td className="num">
                      {sumByUnit(chosen.map((r) => ({ value: r.good, unit: FINISHED_UNIT })))}
                    </td>
                    <td className="num">
                      {sumByUnit(chosen.map((r) => ({ value: r.scrap, unit: FINISHED_UNIT })))}
                    </td>
                    {!picking && <td />}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        ) : (
          <p className="choice-list-empty">
            没有能登记完工的任务。剩下的数量都已登记、在等核对入库的，先到完工记录里核对入库。
          </p>
        )}
        {adding && (
          <FormField label="再加一张任务" hint="几张任务一起登记时共用下面这批纸板">
            <Combobox
              ariaLabel="再加一张任务"
              placeholder="选择没做完的任务"
              value=""
              onChange={(id) => {
                const t = others.find((x) => x.id === Number(id));
                if (!t) return;
                changed();
                setRows((v) => [...v, completionRow(t, v.length, true)]);
                setAdding(false);
              }}
              options={others.map((t) => ({
                value: String(t.id),
                label: t.number + ' · ' + (productName(t) || ''),
                hint: '还差 ' + remaining(t) + ' ' + t.unit,
              }))}
            />
          </FormField>
        )}
      </FormSection>
  );
}

/** 表里的一行任务：勾选（从页头进来时）、任务号和还差多少、合格、报废、去掉（从一张任务进来时，只剩一行时不能去掉） */
function TaskRow(o: {
  r: CompletionRow;
  picking: boolean;
  alone: boolean;
  productName: (r: CompletionTask) => string | undefined;
  change: (patch: RowPatch) => void;
  remove: () => void;
}) {
  const r = o.r,
    off = !r.checked;
  return (
    <tr className={off ? 'wh-row-off' : undefined}>
      {o.picking && (
        <td className="wh-check">
          <input
            type="checkbox"
            aria-label={'选择完工任务' + r.number}
            checked={r.checked}
            onChange={(e) => o.change({ checked: e.currentTarget.checked })}
          />
        </td>
      )}
      <td className="wh-cell-text pb-task">
        <span className="wh-nowrap">{r.number}</span>
        <small>
          {o.productName(r) || '—'} · 还差 {remaining(r)} {r.unit}
          {waitingText(r) && '（另有 ' + waitingText(r) + ' ' + r.unit + '已登记、待核对入库）'}
        </small>
      </td>
      <td className="num" data-label="合格">
        <div className="wh-qty">
          <input
            aria-label={r.number + '实际良品'}
            inputMode="decimal"
            required={r.checked}
            disabled={off}
            value={r.good}
            onChange={(e) => o.change({ good: e.currentTarget.value })}
          />
          <span>{r.unit}</span>
        </div>
      </td>
      <td className="num" data-label="报废">
        <div className="wh-qty">
          <input
            aria-label={r.number + '实际废品'}
            inputMode="decimal"
            required={r.checked}
            disabled={off}
            value={r.scrap}
            onChange={(e) => o.change({ scrap: e.currentTarget.value })}
          />
          <span>{r.unit}</span>
        </div>
      </td>
      {!o.picking && (
        <td className="pb-remove">
          <RowDelete label={'去掉 ' + r.number} disabled={o.alone} onClick={o.remove} />
        </td>
      )}
    </tr>
  );
}
