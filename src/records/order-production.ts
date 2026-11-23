import { finishedUnit, quantityString, safeUnits, type TrackedOrder } from '../../shared/core/index';
import { activeDoc, specificationMismatch, specificationMismatchText, stockByProduct } from '../../shared/business/index';

/**
 * 订单还是“生产中”、它的生产任务却都做完了时，用大白话说清楚还差什么。
 * 判断口径和服务端派生订单状态一致：未发完的每个产品都要做够才算生产完毕；
 * 只算已确认的生产任务（任务和订单明细的单位都只有“只”，数据库约束）。没有依据的不说。
 */
type ProductionReason = {
  /**
   * unscheduled：没排产；short：做少了；shared：任务和别的订单共用；
   * mismatch：明细规格和产品现在的对不上，再排产做出来的还是产品现在的规格，要先核对订单明细
   */
  kind: 'unscheduled' | 'short' | 'shared' | 'mismatch';
  text: string;
};

/** 关联业务里的生产任务：只读状态、完工和计划数量、做的哪个产品、给哪几张订单做 */
type ReasonTask = {
  status?: string;
  archived?: boolean;
  completed: string;
  quantity: string;
  productId?: number | null;
  orderIds: readonly number[];
};
/** 关联业务里的成品库存品：按产品取，比规格（采购库存的视图进共用以前，只写这里读的几项） */
type ReasonStock = { productId?: number | null } & Parameters<typeof specificationMismatch>[0];
/** 订单和明细只读这几项（状态只比“生产中”） */
type ReasonLine = Pick<TrackedOrder['lines'][number], 'id' | 'productId' | 'productName' | 'specification' | 'quantity' | 'remainingQuantity' | 'unit'>;
type ReasonOrder = { id: number; status: string; archived?: boolean; lines: readonly ReasonLine[] };
/** 按产品合起来的明细（规格对不上的那一行单独一组）：要做多少、还有没有没发完的 */
type LineGroup = { productId: number; name: string; unit: string; need: number; open: boolean; mismatch: string };

/** 规格和产品现在的对不上时的那句话（送货、订单“下一步”、今日页同一个判断 specificationMismatch）；对得上是空的 */
function mismatchText(stocks: Map<number, ReasonStock>, l: ReasonLine) {
  const own = stocks.get(l.productId),
    stock = own && specificationMismatch(own, l) ? own : undefined;
  return stock ? l.productName + '：' + specificationMismatchText(stock, l) + '，核对好之前送不了货' : '';
}

/** 明细按产品合起来；规格对不上的明细单独成组，说法和订单详情“下一步”的黄色提示同一句，不说“还没排产” */
function lineGroups(lines: readonly ReasonLine[], stocks: Map<number, ReasonStock>) {
  const groups = new Map<string, LineGroup>();
  for (const l of lines) {
    const unit = finishedUnit(l.unit),
      mismatch = mismatchText(stocks, l),
      key = String(l.productId) + (mismatch ? '|mismatch-' + l.id : ''),
      g = groups.get(key) || { productId: l.productId, name: l.productName, unit, need: 0, open: false, mismatch };
    g.need += safeUnits(l.quantity);
    if (safeUnits(l.remainingQuantity) > 0) g.open = true;
    groups.set(key, g);
  }
  return groups.values();
}

/** 一组明细还差什么：没有就是 null */
function groupReason(g: LineGroup, confirmed: readonly ReasonTask[], orderId: number): ProductionReason | null {
  const unit = g.unit,
    own = confirmed.filter((t) => t.productId === g.productId);
  const done = own.reduce((n, t) => n + safeUnits(t.completed), 0);
  // 对不上的明细缺产量时：再排产也送不了，说去核对订单明细
  if (g.mismatch && (!own.length || done < g.need)) return { kind: 'mismatch', text: g.mismatch };
  if (!own.length) return { kind: 'unscheduled', text: g.name + ' 还没排产' };
  if (done < g.need)
    return {
      kind: 'short',
      text:
        g.name + ' 已完工 ' + quantityString(done) + ' / ' + quantityString(g.need) + ' ' + unit +
        '，还差 ' + quantityString(g.need - done) + ' ' + unit,
    };
  // 一张任务同时给几张订单做时，完工数要够这几张订单合计才算做完。
  const others = new Set(own.flatMap((t) => t.orderIds).filter((id) => id !== orderId));
  if (!others.size) return null;
  return {
    kind: 'shared',
    text: g.name + ' 的生产任务同时给另外 ' + others.size + ' 张订单做，完工数量要够这几张订单合计才算做完',
  };
}

export function productionReasons(
  order: ReasonOrder | null | undefined,
  related: { tasks?: readonly ReasonTask[]; stocks?: readonly ReasonStock[] } | null | undefined,
): ProductionReason[] {
  if (!order || order.status !== '生产中' || order.archived || !related) return [];
  const confirmed = (related.tasks || []).filter(activeDoc).filter((t) => t.status === 'confirmed');
  if (!confirmed.length) return [];
  // 还有没做完的任务时原因一目了然（下一步里就是“登记完工”），这里不重复。
  if (confirmed.some((t) => safeUnits(t.completed) < safeUnits(t.quantity))) return [];
  // 关联的库存品就是这几个产品的成品库存品，一个产品一个：按产品取，再看规格对不对得上
  const stocks = stockByProduct(related.stocks || []);
  const reasons: ProductionReason[] = [];
  for (const g of lineGroups(order.lines, stocks)) {
    const reason = g.open ? groupReason(g, confirmed, order.id) : null;
    if (reason) reasons.push(reason);
  }
  return reasons;
}

/**
 * 详情里那一句提示：说明为什么订单还没做齐。
 * 不写“订单还是‘生产中’”：部分发了货的订单页面上显示的是“部分发货”，引用存的状态会和标签对不上。
 */
export function productionHint(reasons: ProductionReason[]) {
  if (!reasons.length) return '';
  return '生产任务都已完工，订单还没做齐：' + reasons.map((r) => r.text).join('；') + '。';
}
