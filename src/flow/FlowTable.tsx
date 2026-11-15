import type { Dispatch, SetStateAction } from 'react';
import { planDate, type FlowDocView, type FlowKind } from '../../shared/business/index';
import { FINISHED_UNIT, RAW_UNIT, finishedUnit } from '../../shared/core/index';
import { FlowStatus } from './FlowDetails';
import { shipDate } from './flow-dates';

type Props = {
  kind: FlowKind;
  filtered: FlowDocView[];
  sliced: FlowDocView[];
  selected: number[];
  setSelected: Dispatch<SetStateAction<number[]>>;
  view: FlowDocView | null;
  setView: (r: FlowDocView) => void;
  /** 往来方或产品的名称（单据上没存、档案也还没读到时没有） */
  labelRow: (r: FlowDocView) => string | undefined;
};

/** 单据列表：单行高密度，点一行在右侧打开详情。行里不放按钮，勾选后的操作在底部选择条。 */
export default function FlowTable({ kind, filtered, sliced, selected, setSelected, view, setView, labelRow }: Props) {
  const planned = kind === 'task' || kind === 'delivery';
  return (
    <div className="table-wrap unified-table-region" tabIndex={0}>
      <table className="flow-table">
        <thead>
          <tr>
            <th>
              <input
                aria-label="全选当前筛选结果"
                type="checkbox"
                checked={filtered.length > 0 && filtered.every((r) => selected.includes(r.id))}
                onChange={(e) => setSelected(e.currentTarget.checked ? filtered.map((r) => r.id) : [])}
              />
            </th>
            <th>单号</th>
            {/* 生产任务的产品在右侧详情标题里写着，变窄时先收它，计划日期留着（排产时最要看） */}
            <th className={kind === 'task' ? 'col-mid' : undefined}>{kind === 'arrival' ? '供应商' : kind === 'delivery' ? '客户' : '产品'}</th>
            <th>
              {kind === 'task' ? '完工 / 计划' : kind === 'production' ? '合格 / 报废' : kind === 'arrival' ? '到货内容' : '送货内容'}
            </th>
            {/* 列优先级：右侧详情打开、列表变窄时先收实际日期，生产任务再收产品；计划日期一直留着（src/design.css“列表的列优先级”） */}
            <th className={planned && kind !== 'task' ? 'col-mid' : undefined}>{planned ? '计划日期' : '日期'}</th>
            {planned && <th className="col-low">{kind === 'task' ? '实际完工' : '实际发货'}</th>}
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {sliced.map((r) => (
            <FlowTableRow
              key={r.id}
              r={r}
              kind={kind}
              planned={planned}
              opened={view?.id === r.id}
              checked={selected.includes(r.id)}
              setSelected={setSelected}
              setView={setView}
              label={labelRow(r)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 列表的一行：点行（勾选框、按钮、链接以外的地方）或在行上按回车打开详情 */
function FlowTableRow({
  r,
  kind,
  planned,
  opened,
  checked,
  setSelected,
  setView,
  label,
}: {
  r: FlowDocView;
  kind: FlowKind;
  planned: boolean;
  /** 右侧详情开着的就是这一张 */
  opened: boolean;
  checked: boolean;
  setSelected: Props['setSelected'];
  setView: Props['setView'];
  label: string | undefined;
}) {
  return (
    <tr
      tabIndex={0}
      className={'record-row' + (opened ? ' selected' : '')}
      onClick={(e) => {
        if (!(e.target instanceof Element && e.target.closest('input,button,a'))) setView(r);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) setView(r);
      }}
    >
      <td>
        <input
          type="checkbox"
          aria-label={'选择 ' + r.number}
          checked={checked}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            setSelected((s) => (on ? [...s, r.id] : s.filter((i) => i !== r.id)));
          }}
        />
      </td>
      <td className="record-no">
        <button className="row-key" aria-label={'查看 ' + r.number} onClick={() => setView(r)}>
          {r.number}
        </button>
      </td>
      <td className={'cell-wrap' + (kind === 'task' ? ' col-mid' : '')}>{label || '—'}</td>
      <td>
        <FlowContent r={r} />
      </td>
      <td className={planned && kind !== 'task' ? 'col-mid' : undefined}>{planned ? planDate(r) : r.date}</td>
      {kind === 'task' && <td className="col-low">{(r.kind === 'task' && r.actualCompletionDate) || '—'}</td>}
      {kind === 'delivery' && <td className="col-low">{shipDate(r) || '—'}</td>}
      <td>
        <FlowStatus doc={r} />
      </td>
    </tr>
  );
}

/** 内容列：生产任务的完工进度，完工的合格和报废，到货、送货的第一行“名称：数量 单位”、其余 +N（和到货、送货页列表同一个写法） */
function FlowContent({ r }: { r: FlowDocView }) {
  if (r.kind === 'task')
    return (
      <span className="inline-progress">
        <span className="board-progress">
          <i style={{ width: r.progress + '%' }} />
        </span>
        {r.completed} / {r.quantity} {finishedUnit(r.unit)}
      </span>
    );
  if (r.kind === 'production')
    return (
      <>
        {r.goodQuantity} / {r.scrapQuantity || '0'} {FINISHED_UNIT}
      </>
    );
  const first = firstLine(r);
  return (
    <>
      {first ? (
        <>
          {first.name}：{first.quantity} {first.unit}
        </>
      ) : (
        '—'
      )}
      {r.lines.length > 1 && <span className="sub">+{r.lines.length - 1}</span>}
    </>
  );
}

/** 到货、送货的第一行：到货写纸板名称和它的单位（没写是张），送货写品名和成品单位 */
function firstLine(r: FlowDocView<'arrival' | 'delivery'>) {
  if (r.kind === 'arrival') {
    const line = r.lines.at(0);
    return line && { name: line.item.name, quantity: line.quantity, unit: line.item.unit || RAW_UNIT };
  }
  const line = r.lines.at(0);
  return line && { name: line.productName, quantity: line.quantity, unit: finishedUnit(line.unit) };
}
