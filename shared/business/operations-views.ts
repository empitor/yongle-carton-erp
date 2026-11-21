import { z } from 'zod';
import type { arrivalLineStatus } from '../core/index.js';
import {
  arrivalItemSchema,
  arrivalPriceBasisSchema,
  arrivalProgresses,
  purchaseBusinessStatuses,
  purchaseLineDocumentSchema,
  purchaseStatuses,
  stockKinds,
} from './operations.js';
import { movementColumnsSchema, stockDocumentSchema, storedScheduleEntrySchema } from './operations-stored.js';
import type { batchProgress, batchRows } from './order-batch.js';

/*
 * 采购库存读出来交给别处的样子：库存品、采购单、供应商、订货单、库存流水（接口表 operations-api.ts 的回答；服务端 server/operations
 * 按这些类型组装，单据流转、业务汇总、助手也按它们用）。库存品、采购单、订货单写成 zod 结构，因为它们会跟着写接口的结果存进防重复记录，
 * 同一请求号重发时按结构读回来（手工出入库、采购单状态动作、登记到货）。
 */

/**
 * 库存品：库里的内容（规格、尺寸、材质、楞型、备注）加上结余、已安排（待送货、待入库的单据要用掉的）、
 * 可用（结余减已安排，只作提示，可能为负）、在途（已订货还没到齐的）；数量都有千分整数和文字两种。
 */
export const stockItemViewSchema = z.object({
  ...stockDocumentSchema.shape,
  id: z.number(),
  name: z.string(),
  kind: z.enum(stockKinds),
  unit: z.string(),
  productId: z.number().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  quantity: z.string(),
  balanceUnits: z.number(),
  reservedUnits: z.number(),
  reserved: z.string(),
  availableUnits: z.number(),
  onOrderUnits: z.number(),
  onOrder: z.string(),
  archived: z.boolean(),
});
export type StockItemView = z.output<typeof stockItemViewSchema>;

/** 采购明细的到货情况：取值照 shared/core 的 arrivalLineStatus（那边多了取值这里编译不过） */
const arrivalLineStates = ['已到齐', '部分到货', '未到货'] as const satisfies readonly ReturnType<typeof arrivalLineStatus>[];

/** 采购明细：库里的明细内容加上列里的库存品、数量、已到货、关联订单，和由它们算出的剩余、到货情况、金额 */
const purchaseLineViewSchema = purchaseLineDocumentSchema.extend({
  id: z.number(),
  stockItemId: z.number().nullable(),
  /** 这一行自己关联的订单；null 跟单头走 */
  customerOrderId: z.number().nullable(),
  quantity: z.string(),
  receivedQuantity: z.string(),
  remainingQuantity: z.string(),
  remainingUnits: z.number(),
  arrivalStatus: z.enum(arrivalLineStates),
  quantityUnits: z.number(),
  receivedUnits: z.number(),
  customerOrderNumber: z.string(),
  amount: z.string().nullable(),
});
export type PurchaseLineView = z.output<typeof purchaseLineViewSchema>;

/** 采购单的单头、到货进度和状态（明细另算） */
const purchaseHead = {
  id: z.number(),
  number: z.string(),
  supplierId: z.number(),
  supplierName: z.string(),
  customerOrderId: z.number().nullable(),
  orderDate: z.string(),
  expectedDate: z.string().nullable(),
  /** 库里存的状态（待订货、已订货、已取消）；status 是按到货进度显示的 */
  baseStatus: z.enum(purchaseBusinessStatuses),
  notes: z.string(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  businessStatus: z.enum(purchaseBusinessStatuses),
  arrivalProgress: z.enum(arrivalProgresses),
  arrivalSummary: z.strictObject({ progress: z.enum(arrivalProgresses), completedLines: z.number(), totalLines: z.number() }),
  status: z.enum(purchaseStatuses),
  customerOrderNumber: z.string(),
  /** 这张采购给哪些订单订的料：单头关联的订单加上各行关联的订单 */
  orderIds: z.array(z.number()),
  customerOrders: z.array(z.strictObject({ id: z.number(), number: z.string() })),
  totalAmount: z.string().nullable(),
  archived: z.boolean(),
};
/** 采购单本身（单头、明细、已到货和到货进度），不含到货单的信息 */
const purchaseRowViewSchema = z.strictObject({ ...purchaseHead, lines: z.array(purchaseLineViewSchema) });
export type PurchaseRowView = z.output<typeof purchaseRowViewSchema>;

/** 单据被撤销的记录（原因、谁、什么时候、冲掉的流水）：单据内容（flow-document.ts 的 lifecycle）和下面的到货事件都按它 */
export const reversalRecordSchema = z.strictObject({
  reason: z.string(),
  by: z.string(),
  at: z.string(),
  requestId: z.string().optional(),
  movements: z.array(z.string()),
});

/** 到货单的一行按采购单读到的样子：lineId、purchaseId 是它现在挂的采购明细和采购单，验收数没写是 null，金额按单价和计价方式算 */
export const receiptLineSchema = z.strictObject({
  index: z.number(),
  lineId: z.number().nullable(),
  purchaseId: z.number().nullable(),
  stockId: z.number().nullable(),
  quantity: z.string(),
  acceptedQuantity: z.string().nullable(),
  rejectedQuantity: z.string().nullable(),
  stockedQuantity: z.string().nullable(),
  item: z.strictObject(arrivalItemSchema.shape),
  unitPrice: z.string().nullable(),
  priceBasis: arrivalPriceBasisSchema,
  amount: z.string().nullable(),
});

/**
 * 到货事件的单头（不含明细和原单内容）：一张到货单读成采购单、到货记录、到货更正能用的样子，
 * 整个到货事件（加上明细和原单）见 flow-views.ts 的 receiptEventSchema。
 * id 是“flow-编号”，correctionOf、replacedBy 也按这个写。
 */
export const receiptHeadSchema = z.strictObject({
  id: z.string(),
  flowId: z.number(),
  version: z.number(),
  reference: z.string(),
  date: z.string(),
  status: z.string(),
  effective: z.boolean(),
  supplierId: z.number(),
  actorName: z.string(),
  createdAt: z.string(),
  correctionOf: z.string().nullable(),
  replacedBy: z.string().nullable(),
  reversal: reversalRecordSchema.nullable(),
});

/**
 * 采购单的一条到货记录（一张到货单）：到货事件的单头加上原件、原因、撤销没有，
 * items 是挂在这张采购单上的行，correctionLines 是整张到货单的行（更正要用），amount 是整张的金额
 */
const purchaseReceiptSchema = receiptHeadSchema.extend({
  sourceId: z.string().nullable(),
  reason: z.string(),
  reversed: z.boolean(),
  items: z.array(receiptLineSchema),
  correctionLines: z.array(receiptLineSchema),
  amount: z.string().nullable(),
});
/** 采购单的完整样子：采购单本身，加上单据流转补的到货记录、有效到货金额（整张和每行） */
export const purchaseViewSchema = z.strictObject({
  ...purchaseHead,
  lines: z.array(purchaseLineViewSchema.extend({ receivedAmount: z.string().nullable() })),
  receivedAmount: z.string().nullable(),
  receipts: z.array(purchaseReceiptSchema),
});
export type PurchaseView = z.output<typeof purchaseViewSchema>;

/** 供应商：档案加上它的采购历史（只带单号、日期和状态） */
export type SupplierView = {
  id: number;
  name: string;
  contact: string;
  phone: string;
  address: string;
  notes: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  purchaseHistory: Pick<PurchaseRowView, 'id' | 'number' | 'orderDate' | 'status' | 'businessStatus' | 'arrivalProgress'>[];
};

type BatchRow = ReturnType<typeof batchRows>[number];
/** 到货安排一段的状态、订货单的到货进度：取值照 order-batch.ts 的 scheduleView、batchProgress（那边多了取值这里编译不过） */
const scheduleStates = ['done', 'overdue', 'due', 'undated'] as const satisfies readonly BatchRow['schedule'][number]['state'][];
const batchProgressStates = ['已到齐', '部分到货', '待到货'] as const satisfies readonly ReturnType<typeof batchProgress>['state'][];

/** 订货单上合成的一行：数量、到货安排每段还差多少，这一行是哪种纸板，来自哪几张采购单、每张还差多少 */
const orderBatchRowSchema = z.object({
  key: z.string(),
  name: z.string(),
  specification: z.string(),
  unit: z.string(),
  priceBasis: z.string().nullable(),
  unitPrice: z.string().nullable(),
  orderedUnits: z.number(),
  receivedUnits: z.number(),
  remainingUnits: z.number(),
  amount: z.string().nullable(),
  notes: z.string(),
  schedule: z.array(
    storedScheduleEntrySchema.extend({
      receivedUnits: z.number(),
      remainingUnits: z.number(),
      state: z.enum(scheduleStates),
      implicit: z.boolean().optional(),
    }),
  ),
  board: z.object({
    name: z.string(),
    specification: z.string(),
    length: z.number().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    dimensionUnit: z.string().nullable(),
    material: z.string(),
    flute: z.string(),
  }),
  purchaseNumbers: z.array(z.string()),
  parts: z.array(z.object({ purchaseNumber: z.string(), remainingUnits: z.number() })),
});
/** 订货单详情：单头、到货安排、里面的采购单、合成的行、按它登记的到货单、到货进度 */
export const orderBatchViewSchema = z.object({
  id: z.number(),
  number: z.string(),
  supplierId: z.number(),
  supplierName: z.string(),
  orderDate: z.string(),
  notes: z.string(),
  version: z.number(),
  schedule: z.array(storedScheduleEntrySchema),
  purchases: z.array(
    z.object({ id: z.number(), number: z.string(), status: z.enum(purchaseStatuses), customerOrderNumber: z.string() }),
  ),
  rows: z.array(orderBatchRowSchema),
  arrivals: z.array(
    z.object({ id: z.number(), number: z.string(), date: z.string(), status: z.string(), reference: z.string() }),
  ),
  progress: z.object({ state: z.enum(batchProgressStates), overdue: z.boolean(), nextDue: z.string().nullable() }),
});
export type OrderBatchView = z.output<typeof orderBatchViewSchema>;

/** 导出订货单前按几张采购单排的预览：合成的行（已订过货的按原订货单的到货安排），带着原订货单 */
export type OrderBatchDraft = {
  supplierId: number;
  supplierName: string;
  purchases: {
    id: number;
    number: string;
    version: number;
    status: (typeof purchaseBusinessStatuses)[number];
    customerOrderNumber: string;
    expectedDate: string | null;
  }[];
  rows: Omit<BatchRow, 'lines'>[];
  batch: { id: number; number: string; version: number } | null;
};

/**
 * 库存流水列表的一行：stock_movements 那一行（列名是库里的）加上库存品的名称、种类、单位、规格、材质、楞型，
 * 关联的采购单号、订单号，来源单据的种类和单号（不是单据来的没有）、改写过几次，数量的文字（大小、方向、前后结余）
 */
export type MovementView = {
  seq: number;
  id: string;
  item_id: number;
  action: string;
  delta_units: number;
  before_units: number;
  after_units: number;
  source_kind: string;
  source_id: string | null;
  purchase_line_id: number | null;
  customer_order_id: number | null;
  date: string;
  notes: string;
  actor_id: string;
  actor_name: string;
  created_at: string;
  itemName: string;
  kind: (typeof stockKinds)[number];
  unit: string;
  purchaseNumber: string | null;
  customerOrderNumber: string | null;
  flowNumber?: string;
  flowKind?: string;
  revisionCount: number;
  itemSpecification: string;
  material: string;
  flute: string;
  delta: string;
  direction: '-' | '+';
  before: string;
  after: string;
};

/** 流水改写前后的内容：stock_movements 那一行的列和值（operations-stored.ts） */
type MovementColumns = z.output<typeof movementColumnsSchema>;
/** 一条流水被管理员改写、删除的修订记录（删除时 after 是 null） */
export type MovementRevision = { at: string; actorName: string; reason: string; before: MovementColumns; after: MovementColumns | null };
