import type { StockFlowApi } from '../../shared/business/index';
import { call } from '../ui/index';

/**
 * 订货单（一次向供应商订货的批次）的请求：仓库页、采购单详情、导出订货单、登记到货和 AI 导入的到货单都走这里。
 * 放在仓库这一层：仓库页要用，采购（operations）在它上面。地址和登记到货都在单据流转的接口表（shared/business/flow/stock-flow-api.ts）。
 */

const stock = call<StockFlowApi>();

/** 订货单详情 */
export type OrderBatch = StockFlowApi['GET /order-batches/:id']['response'];
/** 改到货安排交上去的那几段 */
type ScheduleInput = StockFlowApi['PUT /order-batches/:id/schedule']['body']['schedule'];
/** 登记到货：每行实到、不合格、实际入库，和请求号、到货日期这些 */
type ReceiveBody = StockFlowApi['POST /order-batches/:id/receive']['body'];

/** 待到货的订货单 */
export const readOrderBatches = () => stock('GET /order-batches');
export const readOrderBatch = (id: number) => stock('GET /order-batches/:id', { params: { id } });
/** 采购单所在的订货单（没有时服务端回 null） */
export const batchOfPurchase = (purchaseId: number) =>
  stock('GET /order-batches/by-purchase/:id', { params: { id: purchaseId } });
/** 登记到货用：采购单所在的订货单，还没订过货的按这张采购单现排一份 */
export const batchForPurchase = (purchaseId: number) =>
  stock('POST /order-batches/for-purchase/:id', { params: { id: purchaseId }, body: {} });
/** 导出订货单前按几张采购单排一份（已订过货的带着原批次） */
export const draftOrderBatch = (purchaseIds: number[]) => stock('POST /order-batches/draft', { body: { purchaseIds } });

/** 改到货安排（分几次到、各到多少） */
export const scheduleOrderBatch = (batch: { id: number; version: number }, schedule: ScheduleInput) =>
  stock('PUT /order-batches/:id/schedule', { params: { id: batch.id }, body: { expectedVersion: batch.version, schedule } });

/** 按订货单登记到货（服务端按下单先后分到各张采购单） */
export const receiveOrderBatch = (batch: { id: number }, body: ReceiveBody) =>
  stock('POST /order-batches/:id/receive', { params: { id: batch.id }, body });
