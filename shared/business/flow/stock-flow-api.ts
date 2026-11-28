import type { z } from 'zod';
import type { Empty, pagingSchema } from '../../core/index.js';
import type { ListResult, MovementSummary, inventoryMetrics, purchaseMetrics } from '../operations/business-metrics.js';
import type { FlowDocView } from './flow-document.js';
import type { movementFilterSchema } from '../operations/movement-filters.js';
import type { movementSchema, purchaseSchema, stockItemSchema } from '../operations/operations.js';
import type { archivedQuerySchema, operationsListQuerySchema, orderBatchDraftSchema } from '../operations/operations-requests.js';
import type { MovementRevision, OrderBatchDraft } from '../operations/operations-views.js';
import type { batchReceiveSchema, batchScheduleSchema } from '../operations/order-batch.js';
import type { purchaseFilterSchema } from '../operations/purchase-filters.js';
import type { RecordStatusAction, recordStatusInputSchema } from '../operations/record-status.js';
import type { MovementView, OrderBatchView, PurchaseView, StockItemView } from './stock-flow-views.js';

/*
 * 采购单、库存品和流水、订货单的接口表（服务端 server/flow/stock-router.ts 挂在 /api 下，用 route() 注册）：
 * 回答带单据的内容（到货记录、已安排、到货单、单号），所以归单据流转；供应商在采购库存的表里（operations-api.ts）。
 * 表的写法见 shared/core/api-table.ts。查询参数和正文照服务端的 zod 规则的输入写，服务端照样先校验；回答是 stock-flow-views.ts 的完整视图。
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
/** 库存品列表的筛选（和供应商列表同一套） */
type ListQuery = z.input<typeof operationsListQuerySchema>;
type PurchaseQuery = z.input<typeof purchaseFilterSchema> & ArchivedQuery;
type MovementQuery = UrlQuery<z.input<typeof movementFilterSchema>>;
type InventoryMetrics = ReturnType<typeof inventoryMetrics>;

type PurchaseInput = z.input<typeof purchaseSchema>;
type StockInput = z.input<typeof stockItemSchema>;

/** 采购单的状态动作：改成待到货、退回待订货、取消（要原因）、恢复，各一个地址，回改完的整张采购单 */
type PurchaseStatusActions = {
  [A in RecordStatusAction as `POST /purchases/:id/${A}`]: { body: z.input<typeof recordStatusInputSchema>; response: PurchaseView };
};

/** 采购单 */
type PurchaseApi = PurchaseStatusActions & {
  'GET /purchases': { query?: PurchaseQuery; response: PurchaseView[] };
  /** 分页并带统计；suppliers 是筛选范围里的全部供应商（筛选下拉用，当前页不一定都有） */
  'GET /purchases?withMetrics=1': {
    query?: PurchaseQuery & PageQuery;
    response: ListResult<PurchaseView, ReturnType<typeof purchaseMetrics>> & { suppliers: { id: number; name: string }[] };
  };
  'GET /purchases/:id': { response: PurchaseView };
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

/** 订货单和挂在它下面的登记到货 */
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
  /** 登记到货（server/flow/register-arrival.ts） */
  'POST /order-batches/:id/receive': {
    body: z.input<typeof batchReceiveSchema>;
    response: { arrival: FlowDocView<'arrival'>; batch: OrderBatchView; verified: true; summary: string };
  };
};

export type StockFlowApi = PurchaseApi & StockApi & BatchApi;
