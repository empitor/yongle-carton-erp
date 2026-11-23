import type { z } from 'zod';
import type { markRemoveSchema, markSourceKinds, markUpdateSchema } from './mark-inputs.js';

/*
 * 产品唛头资料的接口表（服务端 server/overview/mark-router.ts，挂在 /api 下；前端 src/marks/mark-api.ts）。
 * 表的写法见 shared/core/api-table.ts。上传（收原始字节）和看原件（回文件）不是 JSON，不在表里，照旧用 express 注册。
 */

/** 挂在产品下的一份唛头文件（product_marks 一行，带文件名） */
export type ProductMark = {
  id: number;
  productId: number;
  fileSha256: string;
  page: number;
  title: string;
  sourceKind: (typeof markSourceKinds)[number];
  sourceRef: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  fileName: string;
};

export type MarksApi = {
  'GET /products/:id/marks': { response: ProductMark[] };
  'PUT /marks/:id': { body: z.input<typeof markUpdateSchema>; response: ProductMark };
  'DELETE /marks/:id': { body: z.input<typeof markRemoveSchema>; response: { id: number; removed: true } };
};
