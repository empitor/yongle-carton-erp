import type { ReactNode } from 'react';
import {
  centsText,
  deliverableOrder,
  finishedUnit,
  displayAmount,
  orderDisplayStatus,
  quantityString,
  today,
  type Customer,
  type TrackedOrder,
  type Product,
} from '../../shared/core/index';
import {
  UNPRICED_TEXT,
  productIncomplete,
  purchaseState,
  sizeText,
  type PurchaseView,
  type RecordEntity,
  type StockItemView,
} from '../../shared/business/index';
import { StatusChip } from '../ui/index';
import Chain from './Chain';
import { productPrice, productSize } from './PartyProductDetails';
import { specWithoutMaterial } from './RecordPanel';
import { businessStatusTone } from '../recordkit/record-meta';
import type { RecordRowOf } from './record-rows';

/**
 * 档案、订单、采购单、库存品列表（BusinessRecords）每种记录的列：表头和一行的单元格放在一起，加一列只改这里。
 * col-low / col-mid：右侧详情打开、列表变窄时先后收起的次要列（src/design.css“列表的列优先级”）；
 * m-long：手机卡片里不占行的长字段，点开详情看（src/ui/areas/sales.css）。
 */

/** 表头。sortHead 画能点着排序的那一列（首列或交期列）。 */
export function RecordHead({
  entity,
  sortHead,
}: {
  entity: RecordEntity;
  sortHead: (text: string, column: 'first' | 'due', className?: string) => ReactNode;
}) {
  return (
    <>
      {entity === 'purchases' ? (
        <>
          {/* col-low / col-mid：右侧详情打开、列表变窄时先后收起的次要列（src/design.css“列表的列优先级”） */}
          {sortHead('采购单', 'first')}
          <th>供应商</th>
          <th className="col-mid">纸板</th>
          <th className="num col-low">已到 / 订货</th>
          <th className="num">金额</th>
          {sortHead('预计到货', 'due')}
          <th>状态</th>
          <th className="col-low">关联订单</th>
        </>
      ) : entity === 'stock_items' ? (
        <>
          {sortHead('库存品', 'first')}
          <th>规格</th>
          <th className="col-mid">材质 / 楞型</th>
          <th className="num">现存</th>
          <th className="num col-low" title="待送货的送货单和待入库的完工单将要用掉的数量">
            已安排
          </th>
          <th className="num">可用</th>
          <th className="num col-low" title="已订货还没到齐的数量">
            在途
          </th>
          <th>单位</th>
          <th className="col-low">备注</th>
        </>
      ) : entity === 'orders' ? (
        <>
          {sortHead('单号', 'first')}
          <th>客户</th>
          <th className="col-mid">产品</th>
          <th className="num col-low">数量</th>
          <th className="num">金额</th>
          {sortHead('交期', 'due')}
          <th>状态</th>
          <th className="col-low">进度</th>
        </>
      ) : entity === 'customers' || entity === 'suppliers' ? (
        <>
          {sortHead(entity === 'suppliers' ? '供应商' : '客户', 'first')}
          <th>联系人</th>
          <th>联系方式</th>
          <th className="col-mid">地址</th>
          <th className="col-low">备注</th>
        </>
      ) : (
        <>
          {sortHead('产品', 'first')}
          <th>尺寸</th>
          <th>材质 / 楞型</th>
          <th className="col-low">加工要求</th>
          <th className="num">参考单价</th>
        </>
      )}
    </>
  );
}

/** 一行要用的小件：点开详情的单号/名称、附属关系的连接线和标签、是否已归档。 */
export type RecordCellContext<R> = {
  rowKey: (row: R, text: string) => ReactNode;
  familyMark: (row: R) => ReactNode;
  familyTag: (row: R) => ReactNode;
  isArchived: (row: R) => boolean;
};
export type CellProps<R> = { row: R; cell: RecordCellContext<R> };

const archivedTag = <span className="record-state">已归档</span>;

function PurchaseCells({ row, cell }: CellProps<PurchaseView>) {
  return (
    <>
      <td className="record-no">{cell.rowKey(row, row.number)}</td>
      <td className="cell-wrap">{row.supplierName}</td>
      <td className="cell-wrap col-mid" title={row.lines.map((l) => l.name).join('、')}>
        {row.lines[0]?.name}
        {row.lines.length > 1 && <span className="sub">+{row.lines.length - 1}</span>}
      </td>
      <td className="num col-low">
        {row.lines.length === 1
          ? row.lines[0].receivedQuantity + ' / ' + row.lines[0].quantity + ' ' + row.lines[0].unit
          : row.arrivalSummary
            ? row.arrivalSummary.completedLines + ' / ' + row.arrivalSummary.totalLines + ' 种到齐'
            : '—'}
      </td>
      <td className="num">{row.totalAmount === null ? UNPRICED_TEXT : displayAmount(row.totalAmount)}</td>
      <td
        className={
          row.expectedDate && row.expectedDate < today() && !['全部到货', '已取消'].includes(row.status) ? 'overdue' : ''
        }
      >
        {row.expectedDate || '待定'}
      </td>
      <td>
        <StatusChip tone={businessStatusTone(purchaseState(row))}>{purchaseState(row)}</StatusChip>
        {cell.isArchived(row) && archivedTag}
      </td>
      <td className="col-low">{row.customerOrderNumber || '—'}</td>
    </>
  );
}

function StockCells({ row, cell }: CellProps<StockItemView>) {
  return (
    <>
      <td className="cell-wrap record-tree-cell">
        {cell.familyMark(row)}
        {cell.rowKey(row, row.name)}
        {cell.familyTag(row)}
        {cell.isArchived(row) && archivedTag}
      </td>
      {/* 成品的规格说明里带着材质、楞型，旁边一栏已经写了，这里去掉不重复 */}
      <td>{specWithoutMaterial(row) || sizeText(row) || '—'}</td>
      <td className="col-mid">
        {/* 两项都没填只写一个“—”，不写“— / —” */}
        {row.material || row.flute ? (row.material || '—') + ' / ' + (row.flute || '—') : '—'}
      </td>
      <td className="num op-quantity">{row.quantity}</td>
      <td className="num col-low">{row.reservedUnits ? row.reserved : '—'}</td>
      <td className={'num' + (row.availableUnits < 0 ? ' overdue' : '')}>
        {row.availableUnits < 0 ? '-' : ''}
        {quantityString(Math.abs(row.availableUnits ?? row.balanceUnits ?? 0))}
      </td>
      <td className="num col-low">{row.onOrderUnits ? row.onOrder : '—'}</td>
      <td>{row.unit}</td>
      <td className="cell-wrap col-low m-long">{row.notes || '—'}</td>
    </>
  );
}

/** 订单各单位的合计数量（产品只有“只”，按单位分开写是为了不把不同单位加在一起） */
function unitTotals(lines: TrackedOrder['lines']) {
  const groups = new Map<string, number>();
  for (const l of lines) groups.set(finishedUnit(l.unit), (groups.get(finishedUnit(l.unit)) || 0) + l.quantity);
  return [...groups];
}

function OrderCells({ row, cell }: CellProps<TrackedOrder>) {
  return (
    <>
      <td className="record-no">{cell.rowKey(row, row.number)}</td>
      <td className="cell-wrap">{row.customerName}</td>
      <td className="cell-wrap col-mid" title={row.lines.map((l) => l.productName).join('、')}>
        {row.lines[0]?.productName}
        {row.lines.length > 1 && <span className="sub">+{row.lines.length - 1}</span>}
      </td>
      <td className="num col-low">
        {unitTotals(row.lines).map(([unit, quantity]) => (
          <span className="order-unit-total" key={unit}>
            {quantity.toLocaleString('zh-CN')} <small>{unit}</small>
          </span>
        ))}
      </td>
      <td className="num">{row.totalAmountExact ? displayAmount(row.totalAmountExact) : centsText(row.totalCents)}</td>
      <td className={row.deliveryDate < today() && deliverableOrder(row) ? 'overdue' : ''}>
        {row.deliveryDate}
      </td>
      <td>
        <StatusChip tone={businessStatusTone(orderDisplayStatus(row))}>{orderDisplayStatus(row)}</StatusChip>
        {cell.isArchived(row) && archivedTag}
      </td>
      <td className="col-low">
        <Chain order={row} />
      </td>
    </>
  );
}

/** 客户和供应商的档案同一个样子 */
type PartyRow = Pick<Customer, 'name' | 'contact' | 'phone' | 'address' | 'notes'>;

function PartyCells<R extends PartyRow>({ row, cell }: CellProps<R>) {
  return (
    <>
      <td className="cell-wrap">
        {cell.rowKey(row, row.name)}
        {cell.isArchived(row) && archivedTag}
      </td>
      <td>{row.contact || '—'}</td>
      <td>{row.phone || '—'}</td>
      {/* m-long：手机卡片里不占行的长字段，点开详情看（src/ui/areas/sales.css） */}
      <td className="cell-wrap col-mid m-long">{row.address || '—'}</td>
      <td className="cell-wrap col-low m-long">{row.notes || '—'}</td>
    </>
  );
}

function ProductCells({ row, cell }: CellProps<Product>) {
  return (
    <>
      <td className="cell-wrap record-tree-cell">
        {cell.familyMark(row)}
        {cell.rowKey(row, row.name)}
        {cell.familyTag(row)}
        {cell.isArchived(row) ? archivedTag : productIncomplete(row) && <span className="record-state">资料不全</span>}
      </td>
      <td>{productSize(row) || '—'}</td>
      <td>
        {row.material || '—'} / {row.flute || '—'}
      </td>
      <td className="cell-wrap col-low m-long">{row.requirements || '—'}</td>
      <td className="num">{productPrice(row) || '—'}</td>
    </>
  );
}

/** 每种记录的单元格（客户和供应商同一个样子） */
const cellsOf: { [E in RecordEntity]: (props: CellProps<RecordRowOf[E]>) => ReactNode } = {
  purchases: PurchaseCells,
  stock_items: StockCells,
  orders: OrderCells,
  customers: PartyCells,
  suppliers: PartyCells,
  products: ProductCells,
};

/** 一行的单元格（勾选框之后的那些）：按记录种类画 */
export function RecordCells<E extends RecordEntity>({ entity, row, cell }: { entity: E } & CellProps<RecordRowOf[E]>) {
  // 这几个单元格组件不用 hook，直接按种类调用（JSX 认不出“种类和行对得上”的泛型）
  return cellsOf[entity]({ row, cell });
}
