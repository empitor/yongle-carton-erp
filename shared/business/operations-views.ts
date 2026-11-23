import { z } from 'zod';
import { type arrivalLineStatus, stockKinds } from '../core/index.js';
import { arrivalProgresses, purchaseBusinessStatuses, purchaseLineDocumentSchema, purchaseStatuses, type Supplier } from './operations.js';
import { movementColumnsSchema, stockDocumentSchema, storedScheduleEntrySchema } from './operations-stored.js';
import type { batchProgress, batchRows } from './order-batch.js';

/*
 * 采购库存自己读出来的样子（基本视图）：库存品、采购单、供应商、订货单、库存流水，只有采购库存自己的数据，不带单据的内容。
 * 单据流转在这上面补已安排、到货记录、按单据现算的已到货、到货单、单号，拼成完整视图（stock-flow-views.ts，接口的回答）。
 * 完整视图要在基本视图的栏目中间插几项，所以库存品、订货单的栏目分前后两段定义，两边按同一个顺序拼，回答的栏目顺序不变。
 */

/** 库存品的前半段：库里的内容（规格、尺寸、材质、楞型、备注）、种类、单位、版本、结余（千分整数和文字） */
export const stockItemHead = {
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
};
/** 库存品的后半段：在途（已订货还没到齐的，按采购明细的已到货缓存算）、是否归档 */
export const stockItemTail = {
  onOrderUnits: z.number(),
  onOrder: z.string(),
  archived: z.boolean(),
};
const stockItemBaseViewSchema = z.object({ ...stockItemHead, ...stockItemTail });
/** 库存品的基本视图：没有已安排、可用（那是单据的内容） */
export type StockItemBaseView = z.output<typeof stockItemBaseViewSchema>;

/** 采购明细的到货情况：取值照 shared/core 的 arrivalLineStatus（那边多了取值这里编译不过） */
const arrivalLineStates = ['已到齐', '部分到货', '未到货'] as const satisfies readonly ReturnType<typeof arrivalLineStatus>[];

/** 采购明细：库里的明细内容加上列里的库存品、数量、已到货、关联订单，和由它们算出的剩余、到货情况、金额 */
export const purchaseLineViewSchema = purchaseLineDocumentSchema.extend({
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
export const purchaseHead = {
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

/** 供应商：档案加上它的采购历史（只带单号、日期和状态；到货进度按采购明细的已到货缓存算） */
export type SupplierView = Supplier & {
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
/** 订货单的前半段：单头、到货安排、里面的采购单、合成的行（行里的已到货按采购明细的缓存算） */
export const orderBatchHead = {
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
};
/** 订货单的后半段：到货进度 */
export const orderBatchTail = {
  progress: z.object({ state: z.enum(batchProgressStates), overdue: z.boolean(), nextDue: z.string().nullable() }),
};
const orderBatchBaseViewSchema = z.object({ ...orderBatchHead, ...orderBatchTail });
/** 订货单的基本视图：没有按它登记的到货单 */
export type OrderBatchBaseView = z.output<typeof orderBatchBaseViewSchema>;

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
 * 库存流水列表的一行（基本视图）：stock_movements 那一行（列名是库里的）加上库存品的名称、种类、单位、规格、材质、楞型，
 * 关联的采购单号、订单号、改写过几次，数量的文字（大小、方向、前后结余）；来源单据的单号由单据流转补（stock-flow-views.ts）
 */
export type MovementBaseView = {
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
