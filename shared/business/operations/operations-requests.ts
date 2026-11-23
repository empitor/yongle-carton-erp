import { stockKinds } from '../../core/index.js';
import { z } from 'zod';
import { SEARCH_MAX_LENGTH } from './limits.js';
import { purchaseStatuses } from './operations.js';

/*
 * 采购库存的接口收的查询参数和正文（服务端 server/operations/router.ts 先按这里校验，接口表 operations-api.ts 照它的输入写）。
 * 采购单、流水列表的筛选条件在 purchase-filters.ts、movement-filters.ts；withMetrics 写在接口表的键里，分页参数是 shared/core 的 pagingSchema。
 */

/** 一份订货单最多合几张采购单：订货单预览、导出订货单（shared/documents/business-export.ts）都按它 */
export const MAX_BATCH_PURCHASES = 50;

/** 地址上给的编号是文字，页面传进来的是数字 */
const recordId = z.coerce.number<number | string>().int().positive();

/** 带不带已归档的：服务端按权限判断（includeArchivedFor），不认识的取值当没给，和那里的判断一样 */
export const archivedQuerySchema = z.object({ archived: z.enum(['1', 'all']).optional().catch(undefined) });

/**
 * 供应商、库存品列表的筛选：两种列表同一套参数，各用各的那几项（关键字和客户、产品、订单列表同一条规则）。
 * 记录上没有的那一项按“没有”比，带了这项筛选的就筛不出来（server/operations/router.ts 的 supplierList、stockList）。
 */
export const operationsListQuerySchema = archivedQuerySchema.extend({
  q: z.string().max(SEARCH_MAX_LENGTH).optional(),
  supplierId: recordId.optional(),
  customerId: recordId.optional(),
  status: z.enum(purchaseStatuses).optional(),
  kind: z.enum(stockKinds).optional(),
  zero: z.enum(['1', '0']).optional(),
  history: z.enum(['with', 'without']).optional(),
});

/** 导出订货单前的预览：按哪几张采购单排 */
export const orderBatchDraftSchema = z.strictObject({
  purchaseIds: z.array(z.number().int().positive()).min(1).max(MAX_BATCH_PURCHASES),
});
