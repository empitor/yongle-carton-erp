import { planDate } from '../../shared/business/index';
import { StatusChip } from '../ui/index';
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

type Props = {
  kind: WarehouseKind;
  /** 这一页的记录 */
  rows: readonly WarehouseRow[];
  /** 记录里这一行对应的采购单（到货要写采购单号） */
  purchaseOf: PurchaseLookup;
  /** 对方的名字（单据里没存名字的从档案补；档案里也查不到时没有） */
  partyName: (r: WarehouseRow) => string | undefined;
  selected: (r: WarehouseRow) => boolean;
  open: (r: WarehouseRow) => void;
};

/** 表头和列优先级（见下面组件的说明） */
const headings = (kind: WarehouseKind): (readonly [string, string?])[] => [
  ['单号'],
  [kind === 'arrival' ? '供应商' : '客户'],
  [kind === 'arrival' ? '采购单' : '订单', 'col-low'],
  [kind === 'arrival' ? '到货内容' : '送货内容', 'col-low'],
  ...(kind === 'delivery' ? [['计划送货'] as const] : []),
  [kind === 'arrival' ? '实际到货' : '实际发货'],
  ['状态'],
];

/**
 * 到货、送货列表的表格：单号、对方、采购单或订单、内容、计划（只有送货，到货的安排在订货单上）、实际、状态。点行（或单号）打开详情。
 * 第二个是列优先级：右侧详情打开、列表变窄时采购单 / 订单和内容一起收，只留单号、对方、计划、实际、状态（src/design.css“列表的列优先级”）。
 */
export default function WarehouseTable({ kind, rows, purchaseOf, partyName, selected, open }: Props) {
  return (
    <table className="flow-table arrival-table">
      <thead>
        <tr>
          {headings(kind).map(([h, priority]) => (
            <th key={h} className={priority}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const numbers = lineRefs(kind, r, purchaseOf),
            first = firstLine(r),
            state = statusOf(kind, r),
            on = selected(r);
          return (
            <tr
              key={String(r.id)}
              tabIndex={0}
              className={'record-row' + (on ? ' selected' : '')}
              onClick={(e) => {
                if (!(e.target instanceof Element && e.target.closest('input,button,a'))) open(r);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.target === e.currentTarget) open(r);
              }}
            >
              <td className="record-no">
                <button className="row-key" aria-label={'查看 ' + r.number} onClick={() => open(r)}>
                  {r.number}
                </button>
              </td>
              <td className="cell-wrap">{partyName(r)}</td>
              <td className="col-low">
                {numbers[0] || '—'}
                {numbers.length > 1 && <span className="sub">+{numbers.length - 1}</span>}
              </td>
              <td className="cell-wrap col-low">
                {first && (
                  <>
                    {first.name && first.name + '：'}
                    {first.quantity} {first.unit}
                  </>
                )}
                {r.lines.length > 1 && <span className="sub">+{r.lines.length - 1}</span>}
              </td>
              {kind === 'delivery' && (
                <td>
                  {/* 计划日：没写计划日的按单据日期，和详情、生产页同一个 planDate */}
                  {planDate(r) || '—'}
                  {'plannedTime' in r && r.plannedTime && <span className="sub">{r.plannedTime}</span>}
                </td>
              )}
              <td>{actualOf(kind, r) || '—'}</td>
              <td>
                <span className="flow-status">
                  <StatusChip tone={businessStatusTone(state)}>{state}</StatusChip>
                  {warehouseOverdue(r) && <StatusChip tone="danger">逾期</StatusChip>}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
