import { compareRecords, pagingSchema, type Sortable } from '../../../shared/core/index.js';

/** 列表分页的三个参数（规则在 shared/core/paging.ts，前后端共用一份） */
export function parsePaging(query: unknown) {
  return pagingSchema.parse(query);
}

export function clampPage(page: number, pageSize: number, total: number) {
  return Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
}

/**
 * 列表接口的可选分页。不带 page 时原样返回全部行，AI 工具和下拉选项依赖这种行为。
 * 统计必须在调用前用完整筛选结果计算，这里只决定返回哪一页。
 * 页码超出范围时落到最后一页，并在结果里返回实际页码。
 */
export function pageRows<T extends Sortable>(rows: T[], query: unknown) {
  const q = parsePaging(query);
  if (!q.page) return { rows, filteredRecords: rows.length };
  const sorted = q.sort ? [...rows].sort(compareRecords(q.sort)) : rows;
  const page = clampPage(q.page, q.pageSize, sorted.length);
  return {
    rows: sorted.slice((page - 1) * q.pageSize, page * q.pageSize),
    filteredRecords: sorted.length,
    page,
    pageSize: q.pageSize,
  };
}
