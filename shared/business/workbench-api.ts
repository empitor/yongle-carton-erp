import type { z } from 'zod';
import type { ApiJson, Order } from '../core/index.js';
import type { HistoryRefs } from './history-fields.js';
import type { FlowDocView } from './flow-document.js';
import type { ProductMark } from './mark-api.js';
import type { NextStep } from './order-next-step.js';
import type { Dashboard } from './overview.js';
import type { ArrivalDaily } from './flow-views.js';
import type { PurchaseView, StockItemView } from './stock-flow-views.js';
import type { orderQuerySchema } from './record-queries.js';

/*
 * 今日、经营概况、订单和采购单的关联业务、任一记录的关联记录与修改历史的接口表（服务端 server/business/workbench-router.ts，
 * 挂在 /api 下；前端 src/records/list-api.ts、src/recordkit/record-api.ts）。表的写法见 shared/core/api-table.ts。
 */

/** 今日页列订单的样子 */
type TodayOrder = {
  id: number;
  number: string;
  customerName: string;
  deliveryDate: string;
  status: string;
  shippingProgress: Order['shippingProgress'];
  materialProgress: Order['materialProgress'];
  summary: string;
};
type LateOrder = TodayOrder & { lateDays: number };
/** 今日的订单待办：分在哪一组、该办的那一步（界面按这一步直接打开窗口） */
type TodoOrder = LateOrder & {
  group: 'ship' | 'schedule' | 'complete';
  mismatches: string[];
  step: { kind: NextStep['kind']; title: string; label?: string; params: Record<string, string> };
};
type TodayPurchase = { id: number; number: string; supplierName: string; expectedDate: string | null; summary: string };
type Labeled<Id> = { id: Id; label: string };

/** 今日页（服务端 server/business/workbench.ts 的 buildToday，另加自动备份失败的时间） */
type Today = {
  date: string;
  summary: { monthOrderCents: number; monthShippedAmount: string };
  overdue: LateOrder[];
  todo: TodoOrder[];
  unscheduled: TodayOrder[];
  ready: TodayOrder[];
  specMismatch: (TodayOrder & { mismatches: string[] })[];
  toOrder: TodayPurchase[];
  arrivalsDue: (TodayPurchase & { expectedDate: string })[];
  draftDeliveries: { id: number; number: string; customerName: string; plannedDate: string }[];
  schedule: {
    arrivals: (Labeled<string> & { batchId: number; overdue: boolean; dueDate: string | null })[];
    tasks: Labeled<number>[];
    deliveries: Labeled<number>[];
  };
  zeroStock: { id: number; name: string; onOrder: string }[];
  /** 自动备份最近一次失败的时间；只读账号处理不了，给 null */
  backupFailedAt: string | null;
};

type Task = FlowDocView<'task'>;
/** 订单详情里的关联业务 */
type OrderRelated = {
  marks: ProductMark[];
  tasks: Task[];
  productions: FlowDocView<'production'>[];
  deliveries: FlowDocView<'delivery'>[];
  purchases: PurchaseView[];
  /** 订单产品的成品库存品 */
  stocks: StockItemView[];
  /** 还在做的生产任务的进度 */
  production: (Pick<Task, 'id' | 'productId' | 'unit' | 'completed' | 'progress' | 'number'> & { planned: Task['quantity'] })[];
};
/** 采购单详情里的关联业务：到货记录（仓库台账的到货单，server/flow/daily.ts 的 recordsFor）、库存品、关联订单 */
type PurchaseRelated = { arrivals: ArrivalDaily[]; stocks: StockItemView[]; orders: Order[] };

/** “关联记录”里的一条；view 只给界面算显示状态用 */
type RelatedRecord = {
  module: string;
  id: number;
  version: number;
  name?: string;
  status?: string;
  archived: boolean;
  direction: string;
  view: {
    shippingProgress?: string;
    businessStatus?: string;
    effective?: boolean;
    shippedAt?: string | null;
    deliveredAt?: string | null;
    quantity?: string;
    completed?: string;
  };
};
/** 修改历史的一条：审计内容原样交出（数据管理记的 origin 不给） */
type HistoryEntry = { at: string; actorName: string; action: string; sourceLabel: string; detail: ApiJson };
/** 记录详情“更多”里的“关联记录与修改历史” */
type RecordContext = {
  module: string;
  id: number;
  version: number;
  related: RelatedRecord[];
  history: HistoryEntry[];
  historyRefs: HistoryRefs;
  archiveEffect: string;
  /** 关联的单据怎么撤：已核对的冲销，其余归档 */
  alternatives: (Omit<RelatedRecord, 'view'> & { action: string })[];
};

export type WorkbenchApi = {
  'GET /business/:entity/:id/related': { response: OrderRelated | PurchaseRelated };
  'GET /business/:module/:id/context': { response: RecordContext };
  'GET /business/today': { response: Today };
  'GET /dashboard': { query?: z.input<typeof orderQuerySchema>; response: Dashboard };
};
