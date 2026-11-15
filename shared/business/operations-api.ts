import type { z } from 'zod';
import type { Empty, pagingSchema } from '../core/index.js';
import type { ListResult, MovementSummary, inventoryMetrics, purchaseMetrics } from './business-metrics.js';
import type { movementFilterSchema } from './movement-filters.js';
import type { movementSchema, purchaseSchema, stockItemSchema, supplierSchema } from './operations.js';
import type { archivedQuerySchema, operationsListQuerySchema, orderBatchDraftSchema } from './operations-requests.js';
import type {
  MovementRevision,
  MovementView,
  OrderBatchDraft,
  OrderBatchView,
  PurchaseView,
  StockItemView,
  SupplierView,
} from './operations-views.js';
import type { batchScheduleSchema } from './order-batch.js';
import type { purchaseFilterSchema } from './purchase-filters.js';
import type { RecordStatusAction, recordStatusInputSchema } from './record-status.js';

/*
 * 采购库存的接口表（服务端 server/operations/router.ts 挂在 /api 下，用 route() 注册）：供应商、采购单、库存品、库存流水、订货单。
 * 表的写法见 shared/core/api-table.ts。查询参数和正文照服务端的 zod 规则的输入写（operations-requests.ts 等），服务端照样先校验；
 * 回答是 operations-views.ts 的视图。登记到货挂在订货单下，在单据流转的表里（flow-api.ts）。
 */

/**
 * 地址上的查询参数：流水列表的筛选（movement-filters.ts）里 itemId 用的 z.coerce.number() 推出来的输入是 unknown，
 * 地址上给的是文字或数字（已求业务共用写成 z.coerce.number<number | string>()，写好后去掉这一层）
 */
type UrlQuery<T> = { [K in keyof T]: unknown extends T[K] ? number | string | undefined : T[K] };

/** 修改带打开时读到的版本号 */
type Versioned<T> = T & { version: number };
/** 带不带已归档的：'1' 只看已归档，'all' 连同已归档的（要超级管理员模式） */
type ArchivedQuery = z.input<typeof archivedQuerySchema>;
/** 分页：不给 page 时回全部筛出来的（shared/core/paging.ts） */
type PageQuery = z.input<typeof pagingSchema>;
/** 供应商、库存品列表的筛选（两种列表同一套） */
type ListQuery = z.input<typeof operationsListQuerySchema>;
type PurchaseQuery = z.input<typeof purchaseFilterSchema> & ArchivedQuery;
type MovementQuery = UrlQuery<z.input<typeof movementFilterSchema>>;
type InventoryMetrics = ReturnType<typeof inventoryMetrics>;

type PurchaseInput = z.input<typeof purchaseSchema>;
type SupplierInput = z.input<typeof supplierSchema>;
type StockInput = z.input<typeof stockItemSchema>;

/** 采购单的状态动作：改成待到货、退回待订货、取消（要原因）、恢复，各一个地址，回改完的整张采购单 */
type PurchaseStatusActions = {
  [A in RecordStatusAction as `POST /purchases/:id/${A}`]: { body: z.input<typeof recordStatusInputSchema>; response: PurchaseView };
};

/** 供应商、采购单 */
type PurchasingApi = PurchaseStatusActions & {
  'GET /suppliers': { query?: ListQuery; response: SupplierView[] };
  'GET /suppliers?withMetrics=1': { query?: ListQuery; response: { rows: SupplierView[]; totalRecords: number; metrics: null } };
  'POST /suppliers': { body: SupplierInput; response: SupplierView };
  'PUT /suppliers/:id': { body: Versioned<SupplierInput>; response: SupplierView };
  'GET /purchases': { query?: PurchaseQuery; response: PurchaseView[] };
  /** 分页并带统计；suppliers 是筛选范围里的全部供应商（筛选下拉用，当前页不一定都有） */
  'GET /purchases?withMetrics=1': {
    query?: PurchaseQuery & PageQuery;
    response: ListResult<PurchaseView, ReturnType<typeof purchaseMetrics>> & { suppliers: { id: number; name: string }[] };
  };
  'GET /purchases/:id': { query?: ArchivedQuery; response: PurchaseView };
  'POST /purchases': { body: PurchaseInput; response: PurchaseView };
  /** 整张保存不改状态（改状态走状态动作） */
  'PUT /purchases/:id': { body: Versioned<PurchaseInput>; response: PurchaseView };
};

/** 库存品和库存流水 */
type StockApi = {
  'GET /warehouse/items': { query?: ListQuery; response: StockItemView[] };
  /** 带统计：原材料、成品分开算 */
  'GET /warehouse/items?withMetrics=1': {
    query?: ListQuery;
    response: { rows: StockItemView[]; totalRecords: number; metrics: { raw: InventoryMetrics; finished: InventoryMetrics } };
  };
  /** 一个库存品（归档的也能看），带 used：有没有出入库记录或被单据、采购明细引用 */
  'GET /warehouse/items/:id': { response: StockItemView & { used: boolean } };
  'POST /warehouse/items': { body: StockInput; response: StockItemView };
  'PUT /warehouse/items/:id': { body: Versioned<StockInput>; response: StockItemView };
  /** 手工入库、出库、盘点调整：一笔流水 */
  'POST /warehouse/items/:id/move': { body: z.input<typeof movementSchema>; response: { movementId: string; item: StockItemView } };
  /** 这个产品的成品库存品（一个产品只有一个，归档的也算），没有是 null */
  'GET /warehouse/product-stock/:id': { response: { id: number; name: string; archived: boolean } | null };
  'GET /warehouse/movements': { query?: MovementQuery; response: MovementView[] };
  /** 带统计，给了页码就分页（流水只按业务日期倒序，没有排序参数） */
  'GET /warehouse/movements?withMetrics=1': {
    query?: MovementQuery & Omit<PageQuery, 'sort'>;
    response: ListResult<MovementView, MovementSummary>;
  };
  'GET /warehouse/movements/:id/revisions': { response: MovementRevision[] };
};

/** 订货单 */
type BatchApi = {
  'POST /order-batches/draft': { body: z.input<typeof orderBatchDraftSchema>; response: OrderBatchDraft };
  /** 还没到齐的订货单 */
  'GET /order-batches': { response: OrderBatchView[] };
  /** 采购单所在的订货单，不在订货单里是 null */
  'GET /order-batches/by-purchase/:id': { response: OrderBatchView | null };
  /** 登记到货用：采购单所在的订货单，已订货还没有订货单的补建一份 */
  'POST /order-batches/for-purchase/:id': { body: Empty; response: OrderBatchView };
  'GET /order-batches/:id': { response: OrderBatchView };
  'PUT /order-batches/:id/schedule': { body: z.input<typeof batchScheduleSchema>; response: OrderBatchView };
};

export type OperationsApi = PurchasingApi & StockApi & BatchApi;
