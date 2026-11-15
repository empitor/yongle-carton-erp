import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { AppError } from '../core/index.js';
import type { PurchaseRowView, PurchaseView, StockItemView } from '../../shared/business/index.js';

/*
 * 采购库存要单据流转配合的地方：采购库存在单据流转下面一层，不能引用它，也不读它的表，
 * 所以在这里定好接口，由单据流转加载时登记实现（server/flow/service.ts 末尾）。没登记就报错，不会悄悄跳过或少给字段。
 */

/**
 * 写：只在本机管理员直接改数据时发生。
 * - 库存品的名称、规格改了，已有到货单里的这个库存品要跟着对齐（已有记录或被引用的库存品不能改种类、不能改成品关联的产品，单位跟着种类，service.ts 的 saveItem 拦）；
 * - 采购单删掉或改了明细，挂在这些明细上的到货单要解除关联。
 */
type AdminCascade = {
  alignStock(store: Store, before: StockItemView, after: StockItemView, actor: Actor): void;
  detachPurchaseLines(store: Store, purchaseId: number, lineIds: number[], actor: Actor): void;
};
let cascade: AdminCascade | null = null;
export function registerAdminCascade(c: AdminCascade) {
  cascade = c;
}
export function adminCascade(): AdminCascade {
  if (!cascade) throw new AppError('管理员直接改库存品、采购明细要连带改单据，但单据流转模块没有加载。', 500);
  return cascade;
}

/**
 * 读：采购单、订货单、库存品、库存流水要显示或核对的单据流转数据（实现见 server/flow/arrival-source.ts）。
 */
export type ArrivalSource = {
  /** 这批采购单每条明细的已到货（千分整数，按有效到货单现算、扣掉没冲销的退货），和把到货记录、待核对差异、有效到货金额补进采购单的函数 */
  purchases(store: Store, purchaseIds: number[]): { receivedUnits: Map<number, number>; apply(purchases: PurchaseRowView[]): PurchaseView[] };
  /** 这张采购单有没有被单据关联（到货单的明细挂在它上面） */
  purchaseReferenced(store: Store, purchaseId: number): boolean;
  /** 按这份订货单登记过的到货单（订货单详情列出来） */
  batchArrivals(store: Store, batchId: number): { id: number; number: string; date: string; status: string; reference: string }[];
  /** 这份订货单有没有登记过到货（有的话订货单空了也留着） */
  batchHasArrivals(store: Store, batchId: number): boolean;
  /** 已安排：待送货的送货单、待入库的完工单将要用掉的数量，按库存品；stockIds 不给就是全部 */
  reservedUnits(store: Store, stockIds?: readonly number[]): Map<number, number>;
  /** 流水来源单据的种类（flow_documents.kind）和单号，按单据编号（文字）取 */
  documentNumbers(store: Store, ids: number[]): Map<string, { kind: string; number: string }>;
  /** 这几个库存品里被单据引用过的 */
  referencedStock(store: Store, stockIds: number[]): Set<number>;
};
let arrivals: ArrivalSource | null = null;
export function registerArrivalSource(source: ArrivalSource) {
  arrivals = source;
}
/** required 传 false 时没登记返回 null（只有供应商的采购历史这样用：只要到货进度，没登记时读明细的缓存列） */
export function arrivalSource(): ArrivalSource;
export function arrivalSource(required: false): ArrivalSource | null;
export function arrivalSource(required = true): ArrivalSource | null {
  if (!arrivals && required) throw new AppError('读到货、单据要用单据流转模块，但它没有加载。', 500);
  return arrivals;
}
