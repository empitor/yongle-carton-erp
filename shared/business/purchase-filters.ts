import { z } from 'zod';
import { dateSchema } from '../core/index.js';
import { purchaseStatuses, purchaseBusinessStatuses, arrivalProgresses } from './operations.js';
import { pendingPurchase } from './business-metrics.js';
import { SEARCH_MAX_LENGTH } from './limits.js';
import type { MaybeText } from './display-text.js';
export const purchaseFilterSchema = z
  .object({
    q: z.string().max(SEARCH_MAX_LENGTH).optional(),
    // 地址上给的是文字：输入写成数字或文字（接口表的查询参数照它写）
    supplierId: z.coerce.number<number | string>().int().positive().optional(),
    supplierName: z.string().max(SEARCH_MAX_LENGTH).optional(),
    status: z.enum(purchaseStatuses).optional(),
    businessStatus: z.enum(purchaseBusinessStatuses).optional(),
    arrivalProgress: z.enum(arrivalProgresses).optional(),
    start: dateSchema.optional(),
    end: dateSchema.optional(),
    pending: z.enum(['1', '0']).optional(),
  })
  .refine((v) => !v.start || !v.end || v.start <= v.end, {
    message: '开始日期不能晚于结束日期',
    path: ['start'],
  });
type PurchaseProgress = Parameters<typeof pendingPurchase>[0];
/** 按条件筛采购单要看的字段：采购单视图的单号、供应商、状态、日期，明细的名称规格和到货进度 */
type PurchaseMatchRow = Omit<PurchaseProgress, 'lines'> & {
  number: MaybeText;
  supplierId: number;
  supplierName: string;
  notes?: MaybeText;
  arrivalProgress?: string;
  orderDate: string;
  lines: (PurchaseProgress['lines'][number] & {
    name: MaybeText;
    specification?: MaybeText;
    material?: MaybeText;
    flute?: MaybeText;
  })[];
};
export function matchesPurchase(row: PurchaseMatchRow, query: z.infer<typeof purchaseFilterSchema>) {
  return (
    (!query.q ||
      [
        row.number,
        row.supplierName,
        row.notes,
        ...row.lines.map((l) => [l.name, l.specification, l.material, l.flute].join(' ')),
      ]
        .join(' ')
        .toLowerCase()
        .includes(query.q.toLowerCase())) &&
    (!query.supplierId || row.supplierId === query.supplierId) &&
    (!query.supplierName ||
      row.supplierName.toLowerCase().includes(query.supplierName.toLowerCase())) &&
    (!query.status || row.status === query.status) &&
    (!query.businessStatus || row.businessStatus === query.businessStatus) &&
    (!query.arrivalProgress || row.arrivalProgress === query.arrivalProgress) &&
    (!query.start || row.orderDate >= query.start) &&
    (!query.end || row.orderDate <= query.end) &&
    (query.pending !== '1' || pendingPurchase(row))
  );
}
