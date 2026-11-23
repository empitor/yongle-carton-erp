import type { z } from 'zod';
import type { operationsListQuerySchema } from './operations-requests.js';
import type { supplierSchema } from './operations.js';
import type { SupplierView } from './operations-views.js';

/*
 * 采购库存的接口表（服务端 server/operations/router.ts 挂在 /api 下，用 route() 注册）：供应商。
 * 采购单、库存品和流水、订货单（要带单据的内容）在单据流转的表里（stock-flow-api.ts）。
 * 表的写法见 shared/core/api-table.ts。查询参数和正文照服务端的 zod 规则的输入写，服务端照样先校验。
 */

/** 供应商列表的筛选（和库存品列表同一套） */
type ListQuery = z.input<typeof operationsListQuerySchema>;
type SupplierInput = z.input<typeof supplierSchema>;

export type OperationsApi = {
  'GET /suppliers': { query?: ListQuery; response: SupplierView[] };
  'GET /suppliers?withMetrics=1': { query?: ListQuery; response: { rows: SupplierView[]; totalRecords: number; metrics: null } };
  'POST /suppliers': { body: SupplierInput; response: SupplierView };
  /** 修改带打开时读到的版本号 */
  'PUT /suppliers/:id': { body: SupplierInput & { version: number }; response: SupplierView };
};
