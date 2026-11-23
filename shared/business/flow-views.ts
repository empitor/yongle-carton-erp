import { z } from 'zod';
import type { arrivalLineStatus, TrackedOrder } from '../core/index.js';
import { flowContentSchema, type FlowDocuments, type FlowDocView } from './flow-document.js';
import { receiptHeadSchema, receiptLineSchema } from './stock-flow-views.js';

/*
 * 单据流转只读接口的回答（接口表 flow-api.ts）：到货事件和到货记录、仓库台账、核对窗口。服务端（server/flow）的类型都由这里推出。
 * 到货记录、台账里原样带着库存流水（库里 stock_movements 的一行）：那一行的结构是服务端按建表生成的（server/core 的 rows），
 * shared 拿不到，这里按类型参数 M 留着；服务端填那一行的结构，接口表用 MovementJson（只认是一行列值）。
 */

/** 接口里的一笔库存流水：stock_movements 的一行原样交出去（列名是库里的） */
type MovementJson = { readonly [column: string]: string | number | null };

const arrivalContent = flowContentSchema('arrival');

type ReceiptLine = z.output<typeof receiptLineSchema>;

/**
 * 到货事件：一张到货单读成采购单、到货记录、到货更正能用的样子（server/flow/receipt-events.ts 组装）。
 * 单头和明细的结构在 stock-flow-views.ts（采购单视图里的到货记录也用）；document 是库里的原单内容（带种类）。
 */
export const receiptEventSchema = receiptHeadSchema.extend({
  lines: z.array(receiptLineSchema),
  document: arrivalContent,
});
export type ReceiptEvent = z.output<typeof receiptEventSchema>;

/** 到货记录的一行：到货事件的行加上按流水配上的实际入库数、对不对得上、采购单号、采购明细的订购和到货情况、配给这一行的流水 */
type ArrivalRecordLine<M> = ReceiptLine & {
  inventoryMismatch: boolean;
  purchaseNumber: string;
  orderedQuantity: string | null;
  receivedQuantity: string | null;
  remainingQuantity: string | null;
  arrivalStatus: ReturnType<typeof arrivalLineStatus> | null;
  movements: M[];
};
/**
 * 到货记录（GET /flow/arrival-records，台账里的到货单也是它）：到货事件加上单号、供应商名、到货时间、每行的入库情况、
 * 整张的入库和冲销流水、验收情况和入库情况（server/flow/arrivals.ts）
 */
export type ArrivalRecord<M = MovementJson> = Omit<ReceiptEvent, 'lines'> & {
  number?: string;
  supplierName: string;
  actualTime: string | null;
  lines: ArrivalRecordLine<M>[];
  movements: M[];
  inspectionStatus: '待验收' | '未验收' | '含不合格品' | '全部合格';
  inventoryStatus: '尚未入库' | '原单已失效' | '入库待核对' | '未入库' | '部分入库' | '已入库';
};

/** 台账里的到货单：到货记录加上台账的日期和状态（到货没有计划日，到货安排在订货单上） */
export type ArrivalDaily<M = MovementJson> = ArrivalRecord<M> & {
  actualDate: string | null;
  plannedDate: null;
  completed: boolean;
  cancelled: boolean;
  pending: boolean;
};

type OrderLine = TrackedOrder['lines'][number];
type DeliveryLine = FlowDocuments['delivery']['lines'][number];
/** 台账送货单一行另带的：订单号、品名、规格、单位（单据里没快照的取订单明细或库存品）、订单明细的订购和发货、配给这一行的流水 */
type DeliveryLineExtra<M> = Partial<Pick<DeliveryLine, 'orderNumber' | 'productName' | 'specification' | 'unit'>> &
  Partial<Pick<OrderLine, 'shippedQuantity' | 'remainingQuantity' | 'shippingStatus'>> & {
    orderedQuantity?: OrderLine['quantity'];
    movements: M[];
  };
/** 台账里送货单的一行：挂的订单明细的字段（查不到时没有）、被送货明细盖住的、再被另带的几项盖住的 */
type DeliveryDailyLine<M> = Partial<Omit<OrderLine, keyof DeliveryLine | keyof DeliveryLineExtra<M>>> &
  Omit<DeliveryLine, keyof DeliveryLineExtra<M>> &
  DeliveryLineExtra<M>;
/** 台账里的送货单：单据视图加上客户名、状态、每行的订单明细和流水（server/flow/daily-deliveries.ts） */
export type DeliveryDaily<M = MovementJson> = Omit<FlowDocView<'delivery'>, 'lines'> & {
  customerName: string;
  completed: boolean;
  pending: boolean;
  cancelled: boolean;
  lines: DeliveryDailyLine<M>[];
};

/** 日历上一天的计划、实际完成、待执行和合计 */
export type DayCount = { planned: number; completed: number; pending: number; total: number };
/** 台账查询的一种结果：按天看的带当天合计（summary）和日历计数（counts），“最近”带起始日（from）和总条数（total） */
export type DailyResult<K extends string, R> = {
  kind: K;
  date: string;
  records: R[];
  summary?: Omit<DayCount, 'total'>;
  counts?: Record<string, DayCount>;
  scope?: 'recent';
  days?: number;
  from?: string;
  total?: number;
};
/** 仓库台账（GET /flow/daily）：生产任务、到货、送货按种类的结果（server/flow/daily.ts） */
export type WarehouseDailyResult<M = MovementJson> =
  | DailyResult<'task', FlowDocView<'task'>>
  | DailyResult<'arrival', ArrivalDaily<M>>
  | DailyResult<'delivery', DeliveryDaily<M>>;

type ArrivalLine = FlowDocuments['arrival']['lines'][number];
/** 一笔库存变化（单据核对算出来的）：到货新加的行还没有库存品时 stockId 是 null、带 newItem（要新建的原材料内容） */
type StockChange = {
  stockId: number | null;
  name: string;
  unit: string;
  deltaUnits: number;
  reason: string;
  purchaseLineId?: number | null;
  orderId?: number | null;
  newItem?: (ArrivalLine['item'] & { kind: 'raw'; productId: null }) | null;
  /** 核对窗口补的：入到已有的哪个、和第几行入同一个新建的、现在和核对后（千分整数） */
  target?: { id: number; name: string; archived: boolean };
  sameNewAs?: number;
  currentUnits?: number;
  afterUnits?: number;
};
/**
 * 核对窗口（POST /flow/:id/preview，server/flow/preview.ts）：库存会怎么变、提示、补全后的明细（到货、送货才有，别的单据是空的）、
 * 明细补全后的单据视图、预览摘要（确认时带回）、来源原件的哈希
 */
export type FlowPreview = {
  changes: StockChange[];
  warnings: string[];
  lines: FlowDocuments['arrival']['lines'] | FlowDocuments['delivery']['lines'];
  document: FlowDocView;
  previewDigest: string;
  sourceHash: string | null;
};
