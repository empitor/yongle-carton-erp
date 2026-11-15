import { plainPrice, precisionTotal, priceFromCents, type Order } from '../../shared/core/index';
import { taxText } from '../../shared/business/index';
import { displayAmount } from '../../shared/core/index';
import { finishedUnit } from '../../shared/core/index';
import { nestByFamily } from '../../shared/business/index';

/** 订单明细在详情、编辑窗、导出里都叫这个名字。 */
export const ORDER_LINES_TITLE = '订单明细';

type OrderLine = Order['lines'][number];
/** 产品名下面那行小字要的几项（订单明细、导入核对的明细都有，可能空着） */
type LineExtra = {
  specification?: string | null;
  customerProductCode?: string | null;
  notes?: string | null;
  deliveryDate?: string | null;
  taxRate?: string | null;
  taxMode?: string | null;
};
/** 只看的一行明细：产品名和数量一定有，别的按订单读出来的明细，可能没有（没算发货的、只带分的单价） */
type ShownLine = Partial<OrderLine> & Pick<OrderLine, 'productName' | 'quantity'>;

/** 一行明细的金额：按精确单价算，再去掉多余的尾零；算不出来写“—”。 */
export function orderLineAmount(l: { quantity: number | string; unitPriceExact?: string | null; unitPriceCents?: number }) {
  try {
    return displayAmount(
      precisionTotal([
        { quantity: Number(l.quantity), unitPriceCents: l.unitPriceCents ?? 0, unitPriceExact: l.unitPriceExact ?? undefined },
      ]).exact,
    );
  } catch {
    return '—';
  }
}

/** 产品名下面那行小字：规格、客户料号、备注、分项交期、税费。 */
export function orderLineExtra(l: LineExtra) {
  return [
    l.specification,
    l.customerProductCode && '料号 ' + l.customerProductCode,
    l.notes,
    l.deliveryDate && '交期 ' + l.deliveryDate,
    (l.taxRate || l.taxMode) && taxText(l.taxRate, l.taxMode),
  ].filter((text): text is string => !!text);
}

/**
 * 订单明细（只看）：每个产品一行，订了多少、单价和金额，没关掉的订单再加已发 / 待发和库存、生产进度。
 * progress 是“下一步”算出来的每行库存可用和生产进度，没有就不写。已发、待发由服务端按有效送货单算好。
 */
export default function OrderLinesView({
  row,
  progress,
  family,
}: {
  row: { status: string; lines: readonly ShownLine[] };
  progress?: Map<number, { available: string; production: string }>;
  /** 产品附属关系（useProductFamily）：订单里同时有大箱和小箱时，小箱那行挂在大箱下面 */
  family?: { parentOf: (id: number) => number | null; nameOf: (id: number) => string };
}) {
  const closed = ['待确认', '已取消'].includes(row.status);
  const lines = nestByFamily(row.lines, (l) => l.productId, (id) => family?.parentOf(id) ?? null);
  // 用列表不用表格：手机上表格会被拆成“表头：内容”的卡片，表头的小字说明会混进去
  return (
    <div className={'sales-progress-list' + (closed ? ' is-closed' : '')} role="table" aria-label={ORDER_LINES_TITLE}>
      <div className="sales-progress-head" role="row">
        <span role="columnheader">产品</span>
        <span role="columnheader" className="num">
          数量
        </span>
        {!closed && (
          <span role="columnheader" className="num">
            已发 / 待发
          </span>
        )}
      </div>
      {lines.map(({ row: l, depth, last, parentOutside }, i) => {
        const extra = [
            ...(parentOutside && family ? ['附属于 ' + family.nameOf(parentOutside)] : []),
            ...orderLineExtra(l),
          ],
          unit = finishedUnit(l.unit),
          p = l.id === undefined ? undefined : progress?.get(l.id),
          stock = p
            ? ['库存可用 ' + p.available, p.production === 'none' ? '未排产' : '完工 ' + p.production].join(' · ')
            : '';
        return (
          <div className="sales-progress-row" role="row" key={l.id || i}>
            <div role="cell" className="sales-progress-name">
              <strong>
                {depth > 0 && (
                  <span
                    className={'record-tree-branch' + (last ? ' is-last' : '')}
                    style={{ marginLeft: (depth - 1) * 18 }}
                    aria-hidden="true"
                  />
                )}
                {l.productName}
              </strong>
              {extra.length > 0 && <small>{extra.join(' · ')}</small>}
            </div>
            <div role="cell" className="num">
              <span>
                {l.quantity} {unit}
              </span>
              <small>
                {plainPrice(l.unitPriceExact ?? priceFromCents(l.unitPriceCents ?? 0))} 元 · ¥
                {orderLineAmount(l)}
              </small>
            </div>
            {!closed && (
              <div role="cell" className="num">
                <span>
                  {(l.shippedQuantity ?? '—') + ' / ' + (l.remainingQuantity ?? '—')}
                  <em className="sales-progress-unit"> {unit}</em>
                </span>
                <small>{stock || l.shippingStatus || ''}</small>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
