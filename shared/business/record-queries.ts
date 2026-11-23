import { z } from 'zod';
import { dateSchema, displayOrderStatuses, orderViews } from '../core/index.js';
import { SEARCH_MAX_LENGTH } from './limits.js';

/*
 * 客户、产品、订单列表的查询参数（GET /customers、/products、/orders）：服务端 server/orders/record-lists.ts 按它校验，
 * 接口表 records-api.ts 照它的输入（z.input）写类型。withMetrics 写在接口表的键里；分页参数是 shared/core/paging.ts 的 pagingSchema。
 */

/** 地址上给的是文字，页面传进来的是数字 */
const recordId = z.coerce.number<number | string>().int().positive();
const flag = z.enum(['1', '0']);
const listQuery = {
  q: z.string().max(SEARCH_MAX_LENGTH).optional(),
  // 带不带已归档的由服务端按权限判断（includeArchivedFor），不认识的取值当没给，和那里的判断一样
  archived: z.enum(['1', 'all']).optional().catch(undefined),
};

export const customerQuerySchema = z.object(listQuery);
/** 产品：只看资料不全的、按所属客户筛、或只看没定客户的 */
export const productQuerySchema = z.object({
  ...listQuery,
  incomplete: flag.optional(),
  customerId: recordId.optional(),
  unassigned: flag.optional(),
});
/** 订单：客户、产品、下单日期、显示状态、关键字、全部/待处理/历史，历史里是否留着没办完的 */
export const orderQuerySchema = z.object({
  ...listQuery,
  customerId: recordId.optional(),
  productId: recordId.optional(),
  start: dateSchema.optional(),
  end: dateSchema.optional(),
  status: z.enum(displayOrderStatuses).optional(),
  view: z.enum(orderViews).optional(),
  retainPending: flag.optional(),
});
