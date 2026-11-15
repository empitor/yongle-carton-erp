import { z } from 'zod';
import { recordSorts } from './record-sort.js';

/** 列表一页最多几条（业务列表、财务列表同一个上限） */
export const MAX_PAGE_SIZE = 200;
/** 不给页大小时一页几条 */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * 列表分页的三个参数（服务端 server/core/paging.ts 按它校验，接口表照它的输入 z.input 写类型）：
 * page 不给时回全部筛出来的；pageSize 1～200，默认 50；sort 是 recordSorts 之一。地址上给的是文字，页面传进来的是数字。
 */
export const pagingSchema = z.object({
  page: z.coerce.number<number | string>().int().positive().optional(),
  pageSize: z.coerce.number<number | string>().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sort: z.enum(recordSorts).optional(),
});
