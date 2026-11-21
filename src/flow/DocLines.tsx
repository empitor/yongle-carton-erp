import { sheetArea, purchaseLineAmount } from '../../shared/business/index';
import { amountText, priceText, specLine } from '../../shared/business/index';
import { finishedUnit, type SpecFields, fieldShort } from '../../shared/core/index';
import { Section } from '../ui/index';

/**
 * 到货单、送货单的明细表：到货页 / 送货页的详情和“核对入库”“核对出库”窗口都用这一份，
 * 列名、面积、金额、单价写法、规格行全站一样。
 */

/** 区块名字：全站一个说法 */
export const ARRIVAL_LINES_TITLE = '到货明细';
const DELIVERY_LINES_TITLE = '送货明细';

const qty = (value: unknown, unit?: string) =>
  value == null || value === '' ? '—' : String(value) + (unit ? ' ' + unit : '');

/**
 * 到货明细表的一行：单据里的到货明细，或到货页台账的到货记录行（多了采购单号、订购和到货情况）。
 * 没挂采购单的行采购单号是空的。
 */
type ArrivalLineRow = {
  index?: number;
  item: SpecFields & { name: string; unit?: string | null };
  quantity: string;
  acceptedQuantity?: string | null;
  rejectedQuantity?: string | null;
  stockedQuantity?: string | null;
  amount?: string | null;
  unitPrice?: string | null;
  priceBasis?: string | null;
  purchaseId?: number | null;
  purchaseNumber?: string | null;
  purchaseLineId?: number | null;
  orderedQuantity?: string | null;
  receivedQuantity?: string | null;
  remainingQuantity?: string | null;
  arrivalStatus?: string | null;
  differenceReason?: string;
};
/** 送货明细表的一行：单据里的送货明细，或送货页台账的送货记录行（多了订单号、订购和发货情况） */
type DeliveryLineRow = SpecFields & {
  orderId?: number | null;
  orderLineId?: number | null;
  productName?: string;
  notes?: string;
  orderNumber?: string;
  quantity: string;
  unit?: string | null;
  orderedQuantity?: number | string | null;
  shippedQuantity?: number | string | null;
  remainingQuantity?: number | string | null;
  shippingStatus?: string | null;
};
/** 核对窗口里明细只记着订单明细编号：对上的订单和订单明细，用来补产品名、规格和订单号 */
type OrderLineMatch = {
  order?: { number: string };
  line?: { specification?: string | null; productName?: string; unit?: string | null };
};

/** 按纸板尺寸、数量、单价算面积和金额要的几项（到货明细表和到货单编辑窗共用） */
type PricedArrivalLine = Pick<ArrivalLineRow, 'item' | 'quantity' | 'unitPrice' | 'priceBasis'>;

/** 一行纸板的面积（m²）：尺寸或单位不知道时没有；数量还不是合法的数（正在填、核对前人填的）也没有 */
export function lineArea(l: PricedArrivalLine) {
  try {
    return sheetArea(l.item, l.quantity);
  } catch {
    return null;
  }
}
/** 一行纸板按单价和计价方式算的金额：缺单价、计价方式，或数不合法时没有 */
export function lineAmount(l: PricedArrivalLine) {
  try {
    return purchaseLineAmount({ ...l.item, quantity: l.quantity, unitPrice: l.unitPrice, priceBasis: l.priceBasis });
  } catch {
    return null;
  }
}
/** 金额：服务端算好的优先，没有就按单价和计价方式算；都不行写“待定” */
const amountOf = (l: ArrivalLineRow) => amountText(l.amount != null && l.amount !== '' ? l.amount : lineAmount(l));

/** 采购单的链接：有采购单编号的按编号打开，只有单号的按单号搜；没挂采购单（单号是空的）没有链接 */
function purchaseHref(purchaseId: number | null | undefined, purchaseNumber: string | null | undefined) {
  if (purchaseId) return '#purchases?record=' + purchaseId;
  return purchaseNumber ? '#purchases?q=' + encodeURIComponent(purchaseNumber) : null;
}

/** 纸板下面一行：对应的采购单和到货进度；没挂采购单的写“无采购单” */
function PurchaseNote({ l, purchase }: { l: ArrivalLineRow; purchase: { id: number; number: string } | undefined }) {
  const purchaseNumber = l.purchaseNumber || purchase?.number,
    href = purchaseHref(l.purchaseId ?? purchase?.id, purchaseNumber);
  if (!href) return <>无采购单</>;
  return (
    <>
      采购单{' '}
      <a className="nowrap" href={href}>
        {purchaseNumber || '采购单'}
      </a>
      {l.orderedQuantity != null &&
        ' · 订 ' +
          qty(l.orderedQuantity) +
          ' · 已到 ' +
          qty(l.receivedQuantity) +
          ' · 还差 ' +
          qty(l.remainingQuantity) +
          (l.arrivalStatus ? ' · ' + l.arrivalStatus : '')}
    </>
  );
}

/**
 * 到货明细：纸板（下面一行是对应采购单和到货进度）、实收和面积、合格 / 不合格 / 入库、金额和单价。
 * confirmed 是已经过了核对这一步（已入库、已取消、已撤销），没有入库数时写“—”；还待入库的写“核对时算”。
 * purchaseOf 用来补采购单号和链接（核对窗口里明细只记着采购明细编号）。
 */
export function ArrivalLines({
  lines,
  confirmed,
  purchaseOf,
}: {
  lines: readonly ArrivalLineRow[];
  confirmed: boolean;
  purchaseOf?: (l: ArrivalLineRow) => { id: number; number: string } | undefined;
}) {
  return (
    <Section title={ARRIVAL_LINES_TITLE}>
      <div className="table-wrap">
        <table className="wh-linked">
          <thead>
            <tr>
              <th>纸板</th>
              <th className="num">{fieldShort('quantity', { record: 'arrival', parent: 'lines' })}</th>
              <th className="num">合格 / 拒收 / 入库</th>
              <th className="num">金额</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const unit = l.item.unit ?? undefined,
                area = lineArea(l) || '';
              return (
                <tr key={l.index ?? i}>
                  {/* 对应的采购单和到货进度放在纸板下面一行（不单占一列）：详情面板窄时表格不横向撑出去 */}
                  <td>
                    {l.item.name}
                    <small>{specLine(l.item) || '规格待补充'}</small>
                    <small>
                      <PurchaseNote l={l} purchase={purchaseOf?.(l)} />
                    </small>
                    {l.differenceReason && <small>{l.differenceReason}</small>}
                  </td>
                  <td className="num">
                    {qty(l.quantity, unit)}
                    {area && <small>{area} m²</small>}
                  </td>
                  <td className="num">
                    {qty(l.acceptedQuantity)} / {qty(l.rejectedQuantity)} /{' '}
                    {l.stockedQuantity != null ? qty(l.stockedQuantity) : confirmed ? '—' : '核对时算'}
                  </td>
                  <td className="num">
                    {amountOf(l)}
                    <small>{priceText(l.unitPrice, l.priceBasis, unit)}</small>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/**
 * 送货明细：产品（规格行、备注）、对应订单（订了多少、已送、还差）、本次送货数量。
 * orderLineOf 用来补产品名、规格和订单号（核对窗口里明细只记着订单明细编号）。
 */
export function DeliveryLines({
  lines,
  orderLineOf,
}: {
  lines: readonly DeliveryLineRow[];
  orderLineOf?: (l: DeliveryLineRow) => OrderLineMatch;
}) {
  return (
    <Section title={DELIVERY_LINES_TITLE}>
      <div className="table-wrap">
        <table className="wh-linked">
          <thead>
            <tr>
              <th>产品</th>
              <th>订单</th>
              <th className="num">本次送货</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const { order, line }: OrderLineMatch = orderLineOf?.(l) || {},
                spec = [specLine({ ...l, specification: l.specification || line?.specification }), l.notes]
                  .filter(Boolean)
                  .join(' · '),
                orderNumber = l.orderNumber || order?.number;
              return (
                <tr key={i}>
                  <td>
                    {l.productName || line?.productName}
                    {spec && <small>{spec}</small>}
                  </td>
                  <td>
                    {orderNumber ? (
                      <a href={l.orderId ? '#orders?order=' + l.orderId : '#orders?q=' + encodeURIComponent(orderNumber)}>
                        {orderNumber}
                      </a>
                    ) : (
                      '—'
                    )}
                    {l.orderedQuantity != null && (
                      <small>
                        订 {qty(l.orderedQuantity)} · 已送 {qty(l.shippedQuantity)} · 还差 {qty(l.remainingQuantity)}
                        {l.shippingStatus ? ' · ' + l.shippingStatus : ''}
                      </small>
                    )}
                  </td>
                  <td className="num">{qty(l.quantity, finishedUnit(l.unit || line?.unit))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
