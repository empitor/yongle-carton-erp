import type { Dispatch, SetStateAction } from 'react';
import { planDate, type FlowDocView, type FlowKind } from '../../shared/business/index';
import { FINISHED_UNIT, RAW_UNIT, finishedUnit, fieldLabel } from '../../shared/core/index';
import { DataTable, type Col } from '../ui/index';
import { FlowStatus } from './FlowDetails';
import { shipDate } from './flow-dates';
import { title } from './lookups';

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

/** 单据列表：单行高密度，点一行在右侧打开详情。行里不放按钮，勾选后的操作在底部选择条。空着时页面在表格下面说。 */
export default function FlowTable({ kind, filtered, sliced, selected, setSelected, view, setView, labelRow }: Props) {
  return (
    <DataTable
      className="flow-table"
      label={title(kind) + '列表'}
      cols={flowCols(kind, labelRow, setView)}
      rows={sliced}
      onRow={setView}
      selected={view?.id}
      empty={null}
      check={{
        key: (r) => r.id,
        selected,
        set: setSelected,
        all: filtered,
        allLabel: '全选当前筛选结果',
        rowLabel: (r) => '选择 ' + r.number,
      }}
    />
  );
}

/**
 * 列：单号、往来方或产品、内容、计划日期或日期、实际完工 / 发货、状态。
 * 列优先级：右侧详情打开、列表变窄时先收实际日期，生产任务再收产品（产品在详情标题里写着），送货再收计划日期；
 * 生产任务的计划日期一直留着（排产时最要看）（src/ui/list-layout-5.css“列表的列优先级”）。
 */
function flowCols(
  kind: FlowKind,
  labelRow: Props['labelRow'],
  open: Props['setView'],
): Col<FlowDocView>[] {
  const planned = kind === 'task' || kind === 'delivery';
  return [
    {
      key: 'number',
      label: '单号',
      rowNo: true,
      render: (r) => (
        <button className="row-key" aria-label={'查看 ' + r.number} onClick={() => open(r)}>
          {r.number}
        </button>
      ),
    },
    {
      key: 'party',
      label: kind === 'arrival' ? '供应商' : kind === 'delivery' ? '客户' : '产品',
      wrap: true,
      priority: kind === 'task' ? 'mid' : undefined,
      render: (r) => labelRow(r) || '—',
    },
    {
      key: 'content',
      label:
        kind === 'task' ? '完工 / 计划' : kind === 'production' ? '合格 / 报废' : kind === 'arrival' ? '到货内容' : '送货内容',
      render: (r) => <FlowContent r={r} />,
    },
    {
      key: 'date',
      label: planned ? '计划日期' : '日期',
      priority: kind === 'delivery' ? 'mid' : undefined,
      render: (r) => (planned ? planDate(r) : r.date),
    },
    ...(planned
      ? [
          {
            key: 'actual',
            label: kind === 'task' ? '实际完工' : fieldLabel('date', { record: 'delivery' }),
            priority: 'low',
            render: (r) => (kind === 'task' ? r.kind === 'task' && r.actualCompletionDate : shipDate(r)) || '—',
          } satisfies Col<FlowDocView>,
        ]
      : []),
    { key: 'status', label: '状态', render: (r) => <FlowStatus doc={r} /> },
  ];
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
