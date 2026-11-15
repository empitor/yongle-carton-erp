import { FINISHED_UNIT } from '../../shared/core/index';
import { costCents, legacyCents, plainPrice, precisionTotal, priceFromCents, specification, type Order, type OrderInput, type Product } from '../../shared/core/index';

/** 订单编辑窗里的数据：明细行的初始值、合计、提交的内容。只算数据，不碰界面。 */

/** 编辑窗里的一行明细（数量、单价都是输入框里的文字） */
export type OrderLineDraft = {
  /** 只在页面里区分行，不提交 */
  key: string;
  id?: number;
  productId: string;
  productName: string;
  unit: string;
  notes: string;
  specification: string;
  customerProductCode: string;
  taxRate: string;
  taxMode: string;
  deliveryDate: string;
  quantity: string;
  price: string;
};

/** 预估成本（元的文字）和依据 */
export type CostDraft = {
  material: string;
  processing: string;
  waste: string;
  other: string;
  basis: string;
};

/** 订单的附加信息：供应方、税率、含税口径、合同条件、金额结算（编辑窗“更多信息”里改） */
export type OrderExtras = {
  externalPurchaseOrder: string;
  supplierName: string;
  currency: 'CNY';
  taxRate: string;
  taxMode: string;
  terms: string;
  roundingPolicy: NonNullable<OrderInput['roundingPolicy']>;
};

/** 只有分的单价换成元（全站单价写法：100 → “1.00”），整数乘 100 用 BigInt，不经过浮点除法 */
const priceOfCents = (c: number) => plainPrice(priceFromCents(c));
/** 预估成本是金额，照原来的写法（100 → “1”，250 → “2.5”），没填是 0；同样不经过浮点除法 */
/** 产品档案的参考单价：没定过价的留空，不填 0；定了价的按全站单价写法（plainPrice），只有分的按分换成元，不经过浮点。 */
export const productPrice = (p: Product) =>
  p.priceExact != null ? plainPrice(p.priceExact) : p.priceCents ? priceOfCents(p.priceCents) : '';

/** 一行空白明细。key 只在页面里用来记住哪一行展开了，不提交。 */
export const blankLine = (key: string): OrderLineDraft => ({
  key,
  id: undefined,
  productId: '',
  productName: '',
  unit: FINISHED_UNIT,
  notes: '',
  specification: '',
  customerProductCode: '',
  taxRate: '',
  taxMode: '',
  deliveryDate: '',
  // 数量、单价留空让人填，不拿 1 和 0 冒充真值
  quantity: '',
  price: '',
});

/**
 * 打开窗口时的明细：编辑已有订单按它的明细；从产品新建时每种产品一行，带出名称、规格、料号和参考单价，数量留空自己填；
 * 都没有就一行空白。nextKey 每次给一个新的行 key。
 */
export function initialLines(
  value: Order | undefined,
  preset: { productIds?: number[] } | undefined,
  products: Product[],
  nextKey: () => string,
): OrderLineDraft[] {
  if (value)
    return value.lines.map((l) => ({
      key: nextKey(),
      customerProductCode: l.customerProductCode || '',
      taxRate: l.taxRate || '',
      taxMode: l.taxMode || '',
      deliveryDate: l.deliveryDate || '',
      id: l.id,
      productId: String(l.productId),
      productName: l.productName,
      unit: l.unit || FINISHED_UNIT,
      notes: l.notes || '',
      specification: l.specification,
      quantity: String(l.quantity),
      price: l.unitPriceExact != null ? plainPrice(l.unitPriceExact) : priceOfCents(l.unitPriceCents),
    }));
  const fromProducts = preset?.productIds?.length
    ? preset.productIds
        .map((id) => products.find((p) => p.id === id))
        .filter((p): p is Product => !!p)
        .map((p) => ({
          ...blankLine(nextKey()),
          productId: String(p.id),
          productName: p.name,
          customerProductCode: p.customerProductCode || '',
          specification: specification(p),
          price: productPrice(p),
          quantity: '',
        }))
    : null;
  return fromProducts || [blankLine(nextKey())];
}

/** 选了一个产品：这一行带出名称、料号、规格和参考单价 */
export const fillProduct = (l: OrderLineDraft, p: Product | undefined, id: string): OrderLineDraft => ({
  ...l,
  productId: id,
  productName: p?.name || '',
  customerProductCode: p?.customerProductCode || '',
  specification: p ? specification(p) : '',
  price: p ? productPrice(p) : '',
});

/**
 * 合计：total（分）、totalExact（精确金额）、fractional（有不足一分的尾数）、costTotal（预估成本，分）；
 * uncounted 是金额算不出来的行号（单价没填、超上限、数量不是整数），有这样的行就不出合计，免得只算了一部分。
 * 输入过程中的不完整数值由保存校验处理，这里算不出来就留 0。
 */
export function orderTotals(lines: OrderLineDraft[], costs: CostDraft) {
  let total = 0,
    totalExact = '0',
    fractional = false,
    costTotal = 0;
  const uncounted = lines.flatMap((l, i) => {
    try {
      precisionTotal([{ quantity: Number(l.quantity), unitPriceCents: 0, unitPriceExact: l.price }]);
      return [];
    } catch {
      return [i + 1];
    }
  });
  try {
    const calculation = precisionTotal(
      lines.map((l) => ({ quantity: Number(l.quantity), unitPriceCents: legacyCents(l.price), unitPriceExact: l.price })),
    );
    total = calculation.cents;
    totalExact = calculation.exact;
    fractional = calculation.hasFractionalCent;
  } catch {
    /* 合计显示“—” */
  }
  try {
    costTotal = (['material', 'processing', 'waste', 'other'] as const).reduce((s, k) => s + costCents(costs[k]), 0);
  } catch {
    /* 成本显示按 0 */
  }
  return { total, totalExact, fractional, costTotal, uncounted };
}

/** 保存时提交的订单：表头、明细（单价分和精确值都带上）、预估成本（没录就是 null） */
export function orderPayload(o: {
  value?: Order;
  extras: Record<string, unknown>;
  customerId: string;
  orderDate: string;
  deliveryDate: string;
  status: OrderInput['status'];
  notes: string;
  lines: OrderLineDraft[];
  costed: boolean;
  costs: CostDraft;
}): OrderInput & { version?: number } {
  const { value, costs } = o;
  return {
    ...value,
    ...o.extras,
    customerId: Number(o.customerId),
    orderDate: o.orderDate,
    deliveryDate: o.deliveryDate,
    status: o.status,
    notes: o.notes,
    version: value?.version,
    lines: o.lines.map((l) => ({
      id: l.id,
      productId: Number(l.productId),
      productName: l.productName,
      notes: l.notes,
      specification: l.specification,
      quantity: Number(l.quantity),
      unitPriceCents: legacyCents(l.price),
      unitPriceExact: l.price,
      customerProductCode: l.customerProductCode,
      taxRate: l.taxRate,
      taxMode: l.taxMode,
      deliveryDate: l.deliveryDate || undefined,
      unit: l.unit,
    })),
    costs: o.costed
      ? {
          material: costCents(costs.material),
          processing: costCents(costs.processing),
          waste: costCents(costs.waste),
          other: costCents(costs.other),
          basis: costs.basis,
        }
      : null,
  };
}
