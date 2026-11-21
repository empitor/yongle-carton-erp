import type { Store } from '../../core/index.js';
import { OperationsService, OrderBatchService } from '../../operations/index.js';
import type {
  MovementBaseView,
  MovementFilters,
  MovementView,
  OrderBatchBaseView,
  OrderBatchView,
  PurchaseView,
  StockItemBaseView,
  StockItemView,
} from '../../../shared/business/index.js';
import { quantityString } from '../../../shared/core/index.js';
import { batchArrivals, documentNumbers, purchaseArrivals, referencedStock, reservedUnits } from './stock-facts.js';

/*
 * 采购单、库存品、订货单、流水的完整视图：采购库存的基本视图加上单据的事实（stock-facts.ts）。
 * 接口的回答（stock-router.ts）、业务汇总、助手、数据管理、单据导出要带单据内容的都读这里。
 * 补进去的栏目按原来回答的顺序插（库存品的已安排在结余和在途之间、订货单的到货单在行和进度之间、流水的单号在订单号和修订次数之间），
 * 接口回答的栏目顺序不变。
 */

/** 按编号圈记录：不给是全部，一个编号或一组编号（和采购库存的读法同一个写法） */
type Ids = Parameters<OperationsService['items']>[1];

/** 库存品补上已安排、可用（可用量只用于提示，可能因还没核对的单据超排而为负；实际扣减仍在确认时校验） */
function withReserved(item: StockItemBaseView, reserved: number): StockItemView {
  const { onOrderUnits, onOrder, archived, ...head } = item;
  return {
    ...head,
    reservedUnits: reserved,
    reserved: quantityString(reserved),
    availableUnits: item.balanceUnits - reserved,
    onOrderUnits,
    onOrder,
    archived,
  };
}

/** 订货单补上按它登记的到货单 */
function withArrivals(store: Store, batch: OrderBatchBaseView): OrderBatchView {
  const { progress, ...head } = batch;
  return { ...head, arrivals: batchArrivals(store, batch.id), progress };
}

/** 流水补上来源单据的种类和单号；单号只为这些流水查 */
function withNumbers(store: Store, list: MovementBaseView[]): MovementView[] {
  const isFlow = (m: MovementBaseView) => m.source_kind.startsWith('flow_') && !!m.source_id;
  const flowIds = [...new Set(list.flatMap((m) => (isFlow(m) ? [Number(m.source_id)] : [])))].filter(Number.isSafeInteger);
  const flows = flowIds.length ? documentNumbers(store, flowIds) : new Map<string, { kind: string; number: string }>();
  return list.map((m) => {
    const flow = isFlow(m) ? flows.get(String(m.source_id)) : undefined;
    const { revisionCount, itemSpecification, material, flute, delta, direction, before, after, ...head } = m;
    return {
      ...head,
      flowNumber: flow?.number,
      flowKind: flow?.kind,
      revisionCount,
      itemSpecification,
      material,
      flute,
      delta,
      direction,
      before,
      after,
    };
  });
}

export class StockViews {
  private readonly ops: OperationsService;
  private readonly batches: OrderBatchService;
  constructor(readonly store: Store) {
    this.ops = new OperationsService(store);
    this.batches = new OrderBatchService(store);
  }
  /** 采购单的完整视图：已到货按有效到货单现算，补上到货记录、有效到货金额；列表批量读 */
  purchases(include = false, ids?: Ids, supplierIds?: Ids): PurchaseView[] {
    const loaded: { arrivals?: ReturnType<typeof purchaseArrivals> } = {};
    const rows = this.ops.purchases(include, ids, supplierIds, (purchaseIds) => {
      loaded.arrivals = purchaseArrivals(this.store, purchaseIds);
      return loaded.arrivals.receivedUnits;
    });
    return loaded.arrivals ? loaded.arrivals.apply(rows) : [];
  }
  /** 库存品的完整视图：结余、已安排、可用、在途 */
  items(include = false, ids?: Ids): StockItemView[] {
    if (Array.isArray(ids) && !ids.length) return [];
    const items = this.ops.items(include, ids),
      reserved = reservedUnits(this.store, ids === undefined ? undefined : typeof ids === 'number' ? [ids] : ids);
    return items.map((item) => withReserved(item, reserved.get(item.id) || 0));
  }
  /**
   * 库存品用过没有：有出入库记录是 moved，没有流水但被单据、采购明细引用是 referenced；只返回用过的。
   * 用过的不能改种类、成品不能换产品（采购库存保存时拦，被单据引用这一项由保存入口算好给它）；
   * 编辑窗读一个库存品时带上 used，数据管理的库存品列表也用它，几处是同一个判断。
   */
  usages(ids: readonly number[]) {
    if (!ids.length) return new Map<number, 'moved' | 'referenced'>();
    const unique = [...new Set(ids)];
    const usage = new Map(this.ops.localUsages(unique));
    const rest = unique.filter((id) => !usage.has(id));
    if (rest.length) for (const id of referencedStock(this.store, rest)) usage.set(id, 'referenced');
    return new Map(
      unique.flatMap((id) => {
        const u = usage.get(id);
        return u ? [[id, u] as const] : [];
      }),
    );
  }
  usage(id: number) {
    return this.usages([id]).get(id) ?? null;
  }
  /** 库存流水（带来源单据的单号）；page 只取其中一段 */
  movements(query: MovementFilters = {}, page?: { offset?: number; limit?: number }) {
    return withNumbers(this.store, this.ops.movements(query, page));
  }
  /** 带汇总的一页流水（汇总只要库存品和数量变化，整行只组装这一页） */
  movementPage(query: MovementFilters, page: number, pageSize: number) {
    const found = this.ops.movementPage(query, page, pageSize);
    return { ...found, rows: withNumbers(this.store, found.rows) };
  }
  /** 订货单详情：采购单、合并后的行、按它登记的到货单、进度 */
  batch(id: number) {
    return withArrivals(this.store, this.batches.view(id));
  }
  /** 采购单所在的订货单，不在订货单里是 null */
  batchOfPurchase(purchaseId: number) {
    const id = this.batches.batchIdOf(purchaseId);
    return id === null ? null : this.batch(id);
  }
  /** 还没到齐的订货单（到货页的待到货、今日页、助手） */
  openBatches(filter: Parameters<OrderBatchService['open']>[0] = {}) {
    return this.batches.open(filter).map((b) => withArrivals(this.store, b));
  }
}
