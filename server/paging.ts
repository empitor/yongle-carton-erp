import { z } from 'zod';
import { compareRecords, recordSorts } from '../shared/record-sort.js';

const pagingSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.enum(recordSorts).optional(),
});

/**
 * 列表接口的可选分页。不带 page 时原样返回全部行，AI 工具和下拉选项依赖这种行为。
 * 统计必须在调用前用完整筛选结果计算，这里只决定返回哪一页。
 * 页码超出范围时落到最后一页，并在结果里返回实际页码。
 */
export function pageRows<T>(rows: T[], query: unknown) {
  const q = pagingSchema.parse(query);
  if (!q.page) return { rows, filteredRecords: rows.length };
  const sorted = q.sort ? [...rows].sort(compareRecords(q.sort) as (a: T, b: T) => number) : rows;
  const page = Math.min(q.page, Math.max(1, Math.ceil(sorted.length / q.pageSize)));
  return {
    rows: sorted.slice((page - 1) * q.pageSize, page * q.pageSize),
    filteredRecords: sorted.length,
    page,
    pageSize: q.pageSize,
  };
}
