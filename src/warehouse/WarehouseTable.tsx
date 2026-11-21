import { planDate } from '../../shared/business/index';
import { DataTable, StatusChip, type Col } from '../ui/index';
import { businessStatusTone } from '../recordkit/record-meta';
import {
  actualOf,
  firstLine,
  lineRefs,
  statusOf,
  warehouseOverdue,
  type PurchaseLookup,
  type WarehouseKind,
  type WarehouseRow,
} from './warehouse-list';
import { fieldLabel, fieldShort } from '../../shared/core/index';

type Props = {
  kind: WarehouseKind;
  /** 这一页的记录 */
  rows: readonly WarehouseRow[];
  /** 记录里这一行对应的采购单（到货要写采购单号） */
  purchaseOf: PurchaseLookup;
  /** 对方的名字（单据里没存名字的从档案补；档案里也查不到时没有） */
  partyName: (r: WarehouseRow) => string | undefined;
  /** 右侧开着的是不是这一条 */
  selected: (r: WarehouseRow) => boolean;
  open: (r: WarehouseRow) => void;
};

const rowKey = (r: WarehouseRow) => String(r.id);

/**
 * 到货、送货列表的表格：单号、对方、采购单或订单、内容、计划（只有送货，到货的安排在订货单上）、实际、状态。
 * 点行（或单号）打开详情。空着时页面在表格下面说。
 */
export default function WarehouseTable({ kind, rows, purchaseOf, partyName, selected, open }: Props) {
  const opened = rows.find(selected);
  return (
    <DataTable
      className="flow-table arrival-table"
      label={(kind === 'arrival' ? '到货' : '送货') + '列表'}
      cols={warehouseCols(kind, purchaseOf, partyName, open)}
      rows={rows}
      rowKey={rowKey}
      onRow={open}
      selected={opened && rowKey(opened)}
      empty={null}
    />
  );
}

/** 列优先级：右侧详情打开、列表变窄时采购单 / 订单和内容一起收，只留单号、对方、计划、实际、状态（src/ui/list-layout-5.css“列表的列优先级”） */
function warehouseCols(
  kind: WarehouseKind,
  purchaseOf: PurchaseLookup,
  partyName: Props['partyName'],
  open: Props['open'],
): Col<WarehouseRow>[] {
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
    { key: 'party', label: kind === 'arrival' ? '供应商' : '客户', wrap: true, render: partyName },
    {
      key: 'refs',
      label: kind === 'arrival' ? '采购单' : '订单',
      priority: 'low',
      render: (r) => {
        const numbers = lineRefs(kind, r, purchaseOf);
        return (
          <>
            {numbers[0] || '—'}
            {numbers.length > 1 && <span className="sub">+{numbers.length - 1}</span>}
          </>
        );
      },
    },
    {
      key: 'content',
      label: kind === 'arrival' ? '到货内容' : '送货内容',
      wrap: true,
      priority: 'low',
      render: (r) => {
        const first = firstLine(r);
        return (
          <>
            {first && (
              <>
                {first.name && first.name + '：'}
                {first.quantity} {first.unit}
              </>
            )}
            {r.lines.length > 1 && <span className="sub">+{r.lines.length - 1}</span>}
          </>
        );
      },
    },
    ...(kind === 'delivery'
      ? [
          {
            key: 'plan',
            label: fieldShort('plannedDate', { record: 'delivery' }),
            // 计划日：没写计划日的按单据日期，和详情、生产页同一个 planDate
            render: (r) => (
              <>
                {planDate(r) || '—'}
                {'plannedTime' in r && r.plannedTime && <span className="sub">{r.plannedTime}</span>}
              </>
            ),
          } satisfies Col<WarehouseRow>,
        ]
      : []),
    { key: 'actual', label: fieldLabel('date', { record: kind === 'arrival' ? 'arrival' : 'delivery' }), render: (r) => actualOf(kind, r) || '—' },
    {
      key: 'status',
      label: '状态',
      render: (r) => {
        const state = statusOf(kind, r);
        return (
          <span className="flow-status">
            <StatusChip tone={businessStatusTone(state)}>{state}</StatusChip>
            {warehouseOverdue(r) && <StatusChip tone="danger">逾期</StatusChip>}
          </span>
        );
      },
    },
  ];
}
