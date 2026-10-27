import { z } from 'zod';
import { dateSchema } from './domain.js';
import { stockKinds } from './operations.js';
import { presetRange, type DatePreset } from './date-ranges.js';
export const movementActions = ['in', 'out', 'adjust', 'purchase'] as const;
export const movementLabels = {
  in: '手动入库',
  out: '手动出库',
  adjust: '盘点调整',
  purchase: '采购到货',
};
export const movementFilterSchema = z
  .object({
    itemId: z.coerce.number().int().positive().optional(),
    kind: z.enum(stockKinds).optional(),
    action: z.enum(movementActions).optional(),
    q: z.string().max(200).optional(),
    start: dateSchema.optional(),
    end: dateSchema.optional(),
  })
  .refine((v) => !v.start || !v.end || v.start <= v.end, {
    message: '开始日期不能晚于结束日期',
    path: ['start'],
  });
export type MovementFilters = z.infer<typeof movementFilterSchema>;
export function matchesMovement(row: any, query: MovementFilters) {
  return (
    (!query.itemId || Number(row.item_id) === query.itemId) &&
    (!query.kind || row.kind === query.kind) &&
    (!query.action || row.action === query.action) &&
    (!query.start || row.date >= query.start) &&
    (!query.end || row.date <= query.end) &&
    (!query.q ||
      [
        row.itemName,
        row.itemSpecification,
        row.material,
        row.flute,
        row.notes,
        row.purchaseNumber,
        row.customerOrderNumber,
        row.actor_name,
      ]
        .join(' ')
        .toLowerCase()
        .includes(query.q.toLowerCase()))
  );
}
export function initialMovementRange(params: URLSearchParams, date?: string) {
  const raw = params.get('range');
  const preset: DatePreset =
    raw && ['1', '2', '3', 'all', 'custom'].includes(raw) ? (raw as DatePreset) : '2';
  const range = presetRange(preset, date);
  return {
    preset,
    start: preset === 'custom' ? params.get('start') || '' : range.start,
    end: preset === 'custom' ? params.get('end') || '' : range.end,
  };
}
