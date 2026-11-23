import type { TrackedOrder } from '../../core/index.js';
import type { MovementView } from '../flow/stock-flow-views.js';
export type UnitBalance = { unit: string; quantity: string; itemCount: number };
type BusinessOverview = {
  workbench?: {
    date: string;
    toOrder: number;
    pendingArrivals: number;
    arrivalsToday: number;
    stockedToday: number;
    activeTasks: number;
    tasksToday: number;
    productionToday: number;
    deliveriesToday: number;
    pendingDeliveries: number;
  };
  range: { start: string | null; end: string | null };
  orders: {
    total: number;
    /** total 里已归档的张数（点进去的订单列表不列已归档的） */
    archived: number;
    pendingInRange: number;
    pendingAll: number;
    overdueAll: number;
    history: number;
  };
  purchases: {
    total: number;
    /** total 里已归档的张数（点进去的采购单列表不列已归档的） */
    archived: number;
    pending: number;
    pendingAll: number;
    unknownPrices: number;
    amount: string;
    /** 区间内有效到货单的金额（分，按到货日期、实际入库数量，按单据上的单价、不另加税），和财务理论支出同一处算 */
    arrivedCents: number;
    /** 算不出金额（缺单价、数量或尺寸）的到货单张数 */
    arrivalUncomputed: number;
    outstanding: UnitBalance[];
    recent: {
      id: number;
      number: string;
      supplierName: string;
      orderDate: string;
      status: string;
      businessStatus: string;
      arrivalProgress: string;
      totalAmount: string | null;
    }[];
  };
  inventory: {
    raw: UnitBalance[];
    finished: UnitBalance[];
    rawCount: number;
    finishedCount: number;
    zeroCount: number;
  };
  products: { total: number; incomplete: number };
  /** 最近出入库：库存流水的视图（服务端 repo.movements） */
  movements: MovementView[];
  activity: {
    id: string;
    date: string;
    title: string;
    detail: string;
    target: string;
    category: string;
  }[];
};

/** 首页（经营概况）一次返回的数据。 */
export type Dashboard = {
  overview: BusinessOverview;
  count: number;
  amountCents: number;
  /** 区间内有效送货单的金额（分，按送货日期，按单据上的单价、不另加税），和财务理论收入同一处算 */
  deliveredCents: number;
  /** 算不出金额（缺单价、数量或尺寸）的送货单张数 */
  deliveryUncomputed: number;
  estimatedCostCents: number;
  estimatedProfitCents: number;
  costedCount: number;
  uncostedCount: number;
  overdueCount: number;
  /** 所选日期的订单按状态分：count 含已归档的，archived 是其中已归档的张数 */
  byStatus: { status: string; count: number; archived: number }[];
  recentOrders: TrackedOrder[];
};
