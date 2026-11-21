import type { z } from 'zod';
import type { Customer, Order, Product, customerSchema, orderSchema, pagingSchema, productSchema } from '../core/index.js';
import type { ListResult, orderMetrics, productMetrics } from './business-metrics.js';
import type { customerQuerySchema, orderQuerySchema, productQuerySchema } from './record-queries.js';
import type { RecordStatusAction, recordStatusInputSchema } from './record-status.js';

/*
 * 客户、产品、订单的接口表（服务端 server/business/records-router.ts，前端 src/editors/editor-api.ts、src/recordkit/record-api.ts、
 * src/records/list-api.ts）。表的写法见 shared/core/api-table.ts。查询参数和正文都照服务端的 zod 规则的输入写，服务端照样先校验。
 */

/** 列表里的一行：多带“已归档”标记 */
export type Listed<T> = T & { archived: boolean };

type CustomerQuery = z.input<typeof customerQuerySchema>;
type ProductQuery = z.input<typeof productQuerySchema>;
type OrderQuery = z.input<typeof orderQuerySchema>;
/** 订单列表分页：不给 page 时回全部筛出来的（规则是 shared/core/paging.ts 的 pagingSchema） */
type OrderPageQuery = OrderQuery & z.input<typeof pagingSchema>;

type CustomerBody = z.input<typeof customerSchema>;
/** 新建产品撞上同名、尺寸或材质不同的已有产品时，确认“是另一个产品”才建 */
type ProductBody = z.input<typeof productSchema> & { confirmDistinct?: boolean };
type OrderBody = z.input<typeof orderSchema>;
/** 修改带读到时的版本号 */
type Versioned<T> = T & { version: number };

type StatusActions = {
  [A in RecordStatusAction as `POST /orders/:id/${A}`]: { body: z.input<typeof recordStatusInputSchema>; response: Order };
};

/** 六类档案的批量归档、恢复不在这里，在删除归档的 lifecycle-api.ts */
export type RecordsApi = StatusActions & {
  'GET /customers': { query?: CustomerQuery; response: Listed<Customer>[] };
  'GET /customers?withMetrics=1': { query?: CustomerQuery; response: { rows: Listed<Customer>[]; totalRecords: number; metrics: null } };
  'GET /customers/:id': { response: Customer };
  'POST /customers': { body: CustomerBody; response: Customer };
  'PUT /customers/:id': { body: Versioned<CustomerBody>; response: Customer };
  'GET /products': { query?: ProductQuery; response: Listed<Product>[] };
  'GET /products?withMetrics=1': {
    query?: ProductQuery;
    response: { rows: Listed<Product>[]; totalRecords: number; metrics: ReturnType<typeof productMetrics> };
  };
  'GET /products/:id': { response: Product };
  'POST /products': { body: ProductBody; response: Product };
  'PUT /products/:id': { body: Versioned<ProductBody>; response: Product };
  'GET /orders': { query?: OrderQuery; response: Listed<Order>[] };
  'GET /orders?withMetrics=1': { query?: OrderPageQuery; response: ListResult<Listed<Order>, ReturnType<typeof orderMetrics>> };
  'GET /orders/:id': { response: Order };
  'POST /orders': { body: OrderBody; response: Order };
  'PUT /orders/:id': { body: Versioned<OrderBody>; response: Order };
};
