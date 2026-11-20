/**
 * 采购单的空白明细，以及“安排订料”时按订单预填的草稿。
 * 只带系统里有依据的内容：产品的材质、楞型；同一产品上次订过的纸板规格标成“参考上次”。
 * 纸板尺寸和张数没有展开、拼版的计算依据，不推算；单价不猜。
 */
import { FINISHED_UNIT, RAW_UNIT, effectiveOrder, normalizeDimensionUnit, type DimensionUnit, type PriceBasis } from '../../shared/core/index';
import type { StockItemView } from '../../shared/business/index';

/** 库存品档案的内容：新建库存品、采购明细里的纸板都从同一份空白开始 */
export type StockFields = Pick<
  StockItemView,
  'name' | 'kind' | 'unit' | 'specification' | 'length' | 'width' | 'height' | 'dimensionUnit' | 'material' | 'flute' | 'notes' | 'productId'
>;

export function blankStock(kind: StockItemView['kind'] = 'raw'): StockFields {
  return {
    name: kind === 'raw' ? '瓦楞纸板' : '成品纸箱',
    kind,
    unit: kind === 'raw' ? RAW_UNIT : FINISHED_UNIT,
    specification: '',
    length: null,
    width: null,
    height: null,
    dimensionUnit: null,
    material: '',
    flute: '',
    notes: '',
    productId: null,
  };
}

/**
 * 采购单编辑窗里的一行纸板：空白行、按订单预填的行、已存采购单的明细（采购单视图的明细多带到货情况，原样留着）、
 * 选了库存品时带过来的库存品内容都是这个样子。reference 只在编辑窗显示，提交前去掉。
 */
export type PurchaseLineForm = {
  id?: number;
  name: string;
  kind?: string;
  unit: string;
  specification: string;
  length: number | null;
  width: number | null;
  height: number | null;
  dimensionUnit: DimensionUnit | null;
  material: string;
  flute: string;
  notes: string;
  productId?: number | null;
  stockItemId: number | null;
  /** 这一行给哪张订单订的料；没有就跟单头 */
  customerOrderId?: number | null;
  /** 已存明细带着的关联订单号（订单不在下拉里时显示） */
  customerOrderNumber?: string;
  quantity: string;
  unitPrice: string | null;
  priceBasis: PriceBasis;
  /** “参考上次 CG-…” */
  reference?: string;
};

export const blankPurchaseLine = (): PurchaseLineForm => ({
  ...blankStock(),
  stockItemId: null,
  quantity: '',
  unitPrice: null,
  priceBasis: 'area',
});

/** 上次给同一产品订过的纸板规格，只作参考。 */
export type BoardReference = {
  number: string;
  length: number;
  width: number;
  dimensionUnit: string;
  material: string;
  flute: string;
};

/** 找上次订单要看的：订单的状态、订料进度、日期、明细里的产品 */
type SeedOrder = {
  id: number;
  archived?: boolean;
  status?: string;
  materialProgress?: string;
  orderDate?: string;
  lines?: readonly { productId: number; productName?: string }[];
};
/** 取纸板规格要看的采购单：状态、日期、明细的尺寸和配纸 */
type ReferencePurchase = {
  id: number;
  number: string;
  archived?: boolean;
  businessStatus?: string;
  orderDate?: string;
  lines?: readonly {
    length?: number | null;
    width?: number | null;
    dimensionUnit?: string | null;
    material?: string;
    flute?: string;
  }[];
};
/** 新的在前：按日期，同一天按编号 */
const newestFirst = (a: { id: number; orderDate?: string }, b: { id: number; orderDate?: string }) =>
  String(b.orderDate || '').localeCompare(String(a.orderDate || '')) || b.id - a.id;

/**
 * 同一产品最近一张、只有这一种产品、并且关联过采购的订单。
 * 多产品订单的采购明细分不清对应哪种产品，不拿来参考。
 */
export function previousSingleProductOrder<O extends SeedOrder>(orders: readonly O[], current: { id: number }, productId: number) {
  return orders
    .filter(
      (o) =>
        o.id !== current.id &&
        !o.archived &&
        effectiveOrder({ status: o.status ?? '' }) &&
        o.materialProgress &&
        o.materialProgress !== 'none' &&
        o.lines?.length &&
        o.lines.every((l) => l.productId === productId),
    )
    .sort(newestFirst)
    .at(0);
}

/** 从一张订单关联的采购里取纸板规格：只认有效、只有一行、尺寸和单位齐全的采购。 */
export function boardReference(purchases: readonly ReferencePurchase[] | undefined): BoardReference | null {
  const usable = (purchases || [])
    .filter((p) => !p.archived && p.businessStatus !== '已取消' && p.lines?.length === 1)
    .sort(newestFirst);
  for (const p of usable) {
    const l = p.lines?.at(0);
    if (l && l.length != null && l.width != null && l.dimensionUnit)
      return {
        number: p.number,
        length: l.length,
        width: l.width,
        dimensionUnit: l.dimensionUnit,
        material: l.material || '',
        flute: l.flute || '',
      };
  }
  return null;
}

/** 按订单产品预填的新采购单：一产品一行，张数、单价留空。 */
export function purchaseSeedFromOrder(
  order: { id: number; lines?: readonly { productId: number; productName?: string }[] },
  products: readonly { id: number; name?: string; material?: string; flute?: string }[],
  productIds: number[],
  references: Record<number, BoardReference> = {},
) {
  const ids = productIds.length ? productIds : [...new Set<number>((order.lines || []).map((l) => l.productId))];
  const byId = new Map(products.map((p) => [p.id, p]));
  return {
    customerOrderId: order.id,
    lines: ids.map((id): PurchaseLineForm => {
      const product = byId.get(id),
        name = product?.name || order.lines?.find((l) => l.productId === id)?.productName || '',
        ref: BoardReference | undefined = references[id];
      return {
        ...blankPurchaseLine(),
        name: name ? (name + ' 纸板').slice(0, 100) : '瓦楞纸板',
        material: product?.material || ref?.material || '',
        flute: product?.flute || ref?.flute || '',
        ...(ref
          ? {
              length: ref.length,
              width: ref.width,
              // 采购明细的尺寸单位只有 mm、cm，按同一个认法换成编辑窗的取值
              dimensionUnit: normalizeDimensionUnit(ref.dimensionUnit),
              reference: '参考上次 ' + ref.number,
            }
          : {}),
      };
    }),
  };
}

/** 编辑窗里只用于显示的字段，提交前去掉，保证请求内容不变。 */
export function withoutEditorFields<L extends { reference?: string }>(lines: readonly L[]) {
  return lines.map(({ reference: _reference, ...line }) => line);
}

/** 把一种原材料变成采购明细：沿用库存品里的名称、规格、尺寸、材质、楞型，到货入这个库存品；张数和单价自己填。 */
function purchaseLineFromStock(stock: StockItemView): PurchaseLineForm {
  return {
    ...blankPurchaseLine(),
    name: stock.name,
    specification: stock.specification || '',
    length: stock.length ?? null,
    width: stock.width ?? null,
    height: stock.height ?? null,
    dimensionUnit: stock.dimensionUnit ?? null,
    material: stock.material || '',
    flute: stock.flute || '',
    notes: '',
    unit: stock.unit || RAW_UNIT,
    stockItemId: stock.id,
  };
}

/** 从供应商或选中的原材料新建采购单时的预填内容；什么都没带就是空白单。 */
export function purchaseSeedFrom(seed: { supplierId?: number; stockIds?: number[] } | undefined, items: readonly StockItemView[]) {
  if (!seed) return undefined;
  const stocks = (seed.stockIds || [])
    .map((id) => items.find((i) => i.id === id && i.kind === 'raw'))
    .filter((s) => s !== undefined);
  return {
    ...(seed.supplierId ? { supplierId: String(seed.supplierId) } : {}),
    ...(stocks.length ? { lines: stocks.map(purchaseLineFromStock) } : {}),
  };
}
