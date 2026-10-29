import { z } from 'zod';
import { dateSchema } from './domain.js';
import { purchaseStatuses, purchaseBusinessStatuses, arrivalProgresses } from './operations.js';
import { pendingPurchase } from './business-metrics.js';
export const purchaseFilterSchema = z
  .object({
    q: z.string().max(200).optional(),
    supplierId: z.coerce.number().int().positive().optional(),
    supplierName: z.string().max(200).optional(),
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
export function matchesPurchase(row: any, query: z.infer<typeof purchaseFilterSchema>) {
  return (
    (!query.q ||
      [
        row.number,
        row.supplierName,
        row.notes,
        ...row.lines.map((l: any) => [l.name, l.specification, l.material, l.flute].join(' ')),
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
