import { productFitsCustomer, productMovesWithOrder, type Order, type Product } from '../../shared/core/index';
import { fillProduct, type OrderLineDraft } from './order-draft';

/**
 * 订单编辑窗换客户时哪些行留着原产品：只算数据，不碰界面。判断“产品能不能给这家用、跟不跟着订单改归新客户”
 * 都在 shared/core/product-details.ts，这里只按它决定留行、清空和提示。
 * sole 是服务端读的“订单明细只在这张订单里”的产品（GET /orders/:id/sole-products）；没读到之前不让换客户（customerChangeBlocked）。
 */

/**
 * 编辑已有订单时能不能换客户：还在读、读失败都不能换（换了客户，只在这张订单里下过单的产品会一起改归新客户，
 * 要先看清是哪几个，不猜），返回给人看的原因和怎么办；能换是空串。新建订单没有这一步。
 */
export function customerChangeBlocked(editing: boolean, sole: { loading: boolean; error: string }) {
  if (!editing) return '';
  if (sole.error)
    return (
      '没读到这张订单里哪些产品只在这张订单里下过单（' +
      sole.error.replace(/。$/, '') +
      '），先不能换客户：换了客户这些产品会一起改归新客户，要先看清是哪几个。请点“重试”。'
    );
  return sole.loading ? '正在读这张订单的产品，读完才能换客户。' : '';
}

/** 读失败那句旁边的“重试”按钮：重读还没回来时不可点、写“正在重试…”，人看得出点上了（再失败一次那句红字不会变） */
export function soleRetryButton(retrying: boolean) {
  return { disabled: retrying, label: retrying ? '正在重试…' : '重试' };
}

/**
 * 留着原产品的明细：行编号 → 原产品编号。没换客户全留（老订单没动的明细不拦）；换了客户只留跟着改归新客户的
 * （productMovesWithOrder）。
 */
export function keptLineProducts(value: Order | undefined, customerId: string, products: Product[], sole: ReadonlySet<number>) {
  const map = new Map<number, number>();
  if (!value) return map;
  const to = customerId ? Number(customerId) : null;
  for (const l of value.lines) {
    const p = products.find((x) => x.id === l.productId);
    if (to === value.customerId || (p && productMovesWithOrder(p, { from: value.customerId, to }, sole.has(l.productId))))
      map.set(l.id, l.productId);
  }
  return map;
}

/** 这一行当前选的产品对目标客户是否冲突（留着原产品的行除外） */
export function crossCustomerLine(
  line: OrderLineDraft,
  nextCustomerId: number | null,
  products: Product[],
  kept: ReadonlyMap<number, number>,
) {
  if (!nextCustomerId || !line.productId) return false;
  const pid = Number(line.productId);
  if (line.id != null && kept.get(line.id) === pid) return false;
  const p = products.find((x) => x.id === pid);
  return Boolean(p && !productFitsCustomer(p, nextCustomerId));
}

/** 换客户：属于别家客户的产品行清空（留着原产品的行除外），返回更新后的明细和清空了的行（行 key，提示由 clearedNotice 现算） */
export function pruneLinesForCustomer(
  rows: OrderLineDraft[],
  nextCustomerId: number | null,
  products: Product[],
  kept: ReadonlyMap<number, number>,
) {
  const cleared: string[] = [];
  const nextRows = rows.map((l) => {
    if (!crossCustomerLine(l, nextCustomerId, products, kept)) return l;
    cleared.push(l.key);
    return fillProduct(l, undefined, '');
  });
  return { nextRows, cleared };
}

/**
 * 换客户时清空了的行还空着的，按现在的行号提示（删了前面的行号跟着变；删掉了或重新选了产品就不再提）。
 * cleared 是 pruneLinesForCustomer 给的行 key。
 */
export function clearedNotice(rows: OrderLineDraft[], cleared: readonly string[]) {
  const lines = rows.flatMap((l, i) => (cleared.includes(l.key) && !l.productId ? [i + 1] : []));
  return lines.length ? `切换客户后已清空第 ${lines.join('、')} 行（原产品属于其他客户），请重新选择产品。` : '';
}

/**
 * 保存后会一起改归新客户的产品：按现在的明细算（每次渲染都算，选别的行、删行以后跟着变），保存前一直显示。
 * 没换客户、没有跟着走的行都是空串。
 */
export function movingNotice(
  rows: OrderLineDraft[],
  value: Order | undefined,
  customer: { id: number; name: string } | undefined,
  products: Product[],
  sole: ReadonlySet<number>,
) {
  if (!value || !customer || customer.id === value.customerId) return '';
  const kept = keptLineProducts(value, String(customer.id), products, sole);
  const names = new Set(
    rows.flatMap((l) =>
      l.id != null && l.productId && kept.get(l.id) === Number(l.productId)
        ? [products.find((p) => p.id === Number(l.productId))?.name ?? l.productName]
        : [],
    ),
  );
  return names.size ? `保存后，${[...names].join('、')} 的所属客户会一起改成 ${customer.name}（这些产品只在这张订单里下过单）。` : '';
}
