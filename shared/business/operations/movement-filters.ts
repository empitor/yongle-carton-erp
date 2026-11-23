import { z } from 'zod';
import { dateSchema, stockKinds } from '../../core/index.js';
import { presetRange, type DatePreset } from '../../core/index.js';
import { SEARCH_MAX_LENGTH } from './limits.js';
import type { MaybeText } from './display-text.js';
/**
 * 库存流水的来源编码（stock_movements.source_kind），按名字引用（如 movementSource.reversal）：
 * 编码只写在这里，改编码时别的模块（财务、只读窗口）不用跟着改。
 * manual 是手工出入库和盘点；其余见下面流水类型的说明。
 */
export const movementSource = {
  manual: 'manual',
  arrival: 'flow_arrival',
  production: 'flow_production',
  delivery: 'flow_delivery',
  reversal: 'flow_reversal',
  purchaseReturn: 'purchase_return',
  maintenance: 'database-maintenance',
} as const;
/** 流水来源能存的全部值，和建表里的 CHECK 一致（tests/schema-constraints.test.ts 比对） */
export const movementSourceKinds = [
  movementSource.manual,
  movementSource.arrival,
  movementSource.production,
  movementSource.delivery,
  movementSource.reversal,
  movementSource.purchaseReturn,
  movementSource.maintenance,
] as const;
/**
 * 流水类型。有来源单据的按来源（stock_movements.source_kind）分：
 * - flow_arrival：采购到货
 * - flow_production：出库是生产领料，成品入库是生产完工入库，原材料入库是生产退料
 * - flow_delivery：客户发货
 * - purchase_return：出库是采购退货，入库是撤销采购退货（算单据撤销）
 * - flow_reversal：单据撤销
 * - database-maintenance：系统维护时原单据已删除或核对差额留下的流水
 * 没有来源单据的（manual）才按动作分手动入库、手动出库、盘点调整。
 * 服务端 SQL 里的 movementTypeSql（server/operations/repository.ts）必须与 movementTypeOf 一一对应。
 * 顺序就是筛选下拉的顺序：常用的业务单据在前，手工的在后。
 */
export const movementTypes = [
  'purchase',
  'production_issue',
  'production_return',
  'production_output',
  'delivery',
  'purchase_return',
  'reversal',
  'in',
  'out',
  'adjust',
  'maintenance',
] as const;
export type MovementType = (typeof movementTypes)[number];
export const movementLabels: Record<MovementType, string> = {
  purchase: '采购到货',
  production_issue: '生产领料',
  production_return: '生产退料',
  production_output: '生产完工入库',
  delivery: '客户发货',
  purchase_return: '采购退货',
  reversal: '单据撤销',
  in: '手动入库',
  out: '手动出库',
  adjust: '盘点调整',
  maintenance: '系统维护',
};
/** 一条流水的类型；row 是流水行，kind 是库存品的仓库（raw / finished）。 */
export function movementTypeOf(row: {
  source_kind?: unknown;
  kind?: unknown;
  action?: unknown;
  delta_units?: unknown;
  direction?: unknown;
}): MovementType {
  const out = row.delta_units != null ? Number(row.delta_units) < 0 : row.direction === '-';
  switch (row.source_kind) {
    case movementSource.arrival:
      return 'purchase';
    case movementSource.production:
      return row.kind === 'finished' ? 'production_output' : out ? 'production_issue' : 'production_return';
    case movementSource.delivery:
      return 'delivery';
    case movementSource.purchaseReturn:
      return out ? 'purchase_return' : 'reversal';
    case movementSource.reversal:
      return 'reversal';
    case movementSource.maintenance:
      return 'maintenance';
  }
  return row.action === 'adjust' || row.action === 'purchase' || row.action === 'in' || row.action === 'out'
    ? row.action
    : out
      ? 'out'
      : 'in';
}
/** 流水类型的中文名。 */
export const movementTypeLabel = (row: Parameters<typeof movementTypeOf>[0]) =>
  movementLabels[movementTypeOf(row)];
export const movementFilterSchema = z
  .object({
    itemId: z.coerce.number().int().positive().optional(),
    kind: z.enum(stockKinds).optional(),
    // 筛选参数仍叫 action，取值是流水类型
    action: z.enum(movementTypes).optional(),
    q: z.string().max(SEARCH_MAX_LENGTH).optional(),
    start: dateSchema.optional(),
    end: dateSchema.optional(),
  })
  .refine((v) => !v.start || !v.end || v.start <= v.end, {
    message: '开始日期不能晚于结束日期',
    path: ['start'],
  });
export type MovementFilters = z.infer<typeof movementFilterSchema>;
/** 按条件筛流水要看的字段：流水行（库里的列名）加库存品资料和关联单号；关键字只在给出的文字里找 */
type MovementMatchRow = Parameters<typeof movementTypeOf>[0] & {
  item_id: number | string;
  date: string;
  itemName?: MaybeText;
  itemSpecification?: MaybeText;
  material?: MaybeText;
  flute?: MaybeText;
  notes?: MaybeText;
  purchaseNumber?: MaybeText;
  customerOrderNumber?: MaybeText;
  actor_name?: MaybeText;
};
export function matchesMovement(row: MovementMatchRow, query: MovementFilters) {
  return (
    (!query.itemId || Number(row.item_id) === query.itemId) &&
    (!query.kind || row.kind === query.kind) &&
    (!query.action || movementTypeOf(row) === query.action) &&
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
/** 流水页地址上 range 能给的取值；不给或不认识时看最近两个月 */
const movementRangePresets: readonly DatePreset[] = ['1', '2', '3', 'all', 'custom'];
const DEFAULT_MOVEMENT_RANGE: DatePreset = '2';
export function initialMovementRange(params: URLSearchParams, date?: string) {
  const raw = params.get('range');
  const preset = movementRangePresets.find((p) => p === raw) ?? DEFAULT_MOVEMENT_RANGE;
  const range = presetRange(preset, date);
  return {
    preset,
    start: preset === 'custom' ? params.get('start') || '' : range.start,
    end: preset === 'custom' ? params.get('end') || '' : range.end,
  };
}
