import { FINISHED_UNIT, RAW_UNIT, isFlowKind } from '../core/index.js';
import { centsText, isRecord, orderDisplayStatus, plainPrice } from '../core/index.js';
import { dataManagementFieldName } from './data-management-modules.js';
import { UNPRICED_TEXT, priceText, sizeText } from './display-text.js';
import { purchaseState } from './labels.js';
import { flowStatusText } from './physical-flow.js';
import {
  codeNames,
  historyFieldLabel,
  quantityFields,
  refTables,
  snapshotNames,
  type HistoryRefs,
} from './history-fields.js';

/*
 * 修改历史和确认卡片里一个值怎么写（record-changes.ts、record-history.ts 共用）：引用的名称、数量的单位、状态叫法、
 * 金额和单价、明细的一句话。审计存的内容是服务端写的 JSON，这里按字段逐个认，认不出的不显示。
 */

/** 审计里存的一条记录（或明细、嵌套对象）：字段名 → 原样的值 */
export type Row = Record<string, unknown>;
/**
 * editable：确认卡片用（cardChanges）。人能改的字段（参数结构里的）一个都不能漏：
 * 没有中文名的照字段名列出来（测试会拦，补叫法）、名称快照在编号没变而名称变了时也列、明细里只在一边有的也列。
 */
export type Editable = { top: ReadonlySet<string>; lines: ReadonlySet<string> };
export type Ctx = { module: string; refs: HistoryRefs; recordId?: number; editable?: Editable };

export const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && !v.trim());
export const EMPTY = '未填写';
const textOf = (v: unknown) => (typeof v === 'string' ? v : undefined);
const sizeNumber = (v: unknown) => (typeof v === 'number' ? v : null);

/** 字段中文名；没有中文名的照数据管理的写法（多半就是字段名），给确认卡片“人能改的不能漏”用 */
export const labelOf = (key: string, parent = '', module = '') =>
  historyFieldLabel(key, parent, module) ?? dataManagementFieldName(key, parent, module);

/** 尺寸几项（长宽高、尺寸单位）写成一句；不是数的当没填 */
export const rowSize = (row: Row) =>
  sizeText({
    length: sizeNumber(row.length),
    width: sizeNumber(row.width),
    height: sizeNumber(row.height),
    dimensionUnit: textOf(row.dimensionUnit) ?? null,
  });

/** 引用编号（不是空的）的名称：接口查好的名称，查不到用记录里的名称快照，再不行写“已删除的记录” */
function refLabel(ctx: Ctx, key: string, id: unknown, row?: Row) {
  const table = refTables[key];
  const found = table ? ctx.refs[table]?.[String(id)]?.name : undefined;
  if (found) return found;
  const snapshot = snapshotNames[key] && row?.[snapshotNames[key]];
  return typeof snapshot === 'string' && snapshot.trim() ? snapshot : '已删除的记录';
}
/** 引用编号的名称；编号是空的返回 null */
const refName = (ctx: Ctx, key: string, id: unknown, row?: Row) => (blank(id) ? null : refLabel(ctx, key, id, row));
/** 一笔出入库关联的订单名称（编号一定有） */
export const orderRefName = (ctx: Ctx, orderId: number) => refLabel(ctx, 'orderId', orderId);

/** 数量的单位：产品、成品是“只”，纸板是“张”（shared/core/units.ts）；记录自己写了单位的按它 */
export function unitOf(ctx: Ctx, row: Row | undefined, parent: string): string {
  if (typeof row?.unit === 'string' && row.unit.trim()) return row.unit;
  const item = row?.item;
  if (isRecord(item) && typeof item.unit === 'string' && item.unit.trim()) return item.unit;
  if (parent === 'materials' || ['arrival', 'purchases'].includes(ctx.module)) return RAW_UNIT;
  if (ctx.module === 'stock_items' && ctx.recordId) return ctx.refs.stock_items?.[String(ctx.recordId)]?.unit || '';
  return FINISHED_UNIT;
}

/** 单据状态叫法要看的几项：审计里存的单据内容按字段取 */
const flowStatusRow = (kind: string, row: Row): Parameters<typeof flowStatusText>[0] => ({
  kind,
  status: textOf(row.status),
  pending: !!row.pending,
  cancelled: !!row.cancelled,
  effective: typeof row.effective === 'boolean' ? row.effective : undefined,
  replacedBy: row.replacedBy,
  quantity: textOf(row.quantity),
  completed: textOf(row.completed),
  pendingCompleted: textOf(row.pendingCompleted),
  deliveredAt: textOf(row.deliveredAt) ?? null,
});

/** 记录的状态，用列表、详情一样的叫法 */
export function statusOf(module: string, row: Row | undefined) {
  if (!row || blank(row.status)) return null;
  if (module === 'orders') return orderDisplayStatus({ status: String(row.status), shippingProgress: textOf(row.shippingProgress) });
  if (module === 'purchases') return purchaseState({ businessStatus: textOf(row.businessStatus), status: textOf(row.status) });
  if (isFlowKind(module)) return flowStatusText(flowStatusRow(module, row));
  return null;
}

function money(cents: unknown) {
  return typeof cents === 'number' && Number.isFinite(cents) ? centsText(cents) + ' 元' : null;
}
/** 元的十进制字符串按全站单价写法（plainPrice：至少两位、最多四位，1.5000 → 1.50）；不是数的返回 null */
function plainYuan(v: unknown) {
  return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? plainPrice(v.trim()) : null;
}
function exactPrice(v: unknown) {
  const plain = plainYuan(v);
  return plain === null ? null : plain + ' 元';
}
export const withUnit = (q: unknown, unit: string) => String(q) + (unit ? ' ' + unit : '');

export function lineName(ctx: Ctx, line: Row) {
  const named = [line.productName, line.name, isRecord(line.item) ? line.item.name : undefined].find(
    (v): v is string => typeof v === 'string' && !!v.trim(),
  );
  return (
    named ||
    (line.stockId != null && refName(ctx, 'stockId', line.stockId)) ||
    (line.stockItemId != null && refName(ctx, 'stockItemId', line.stockItemId)) ||
    (line.productId != null && refName(ctx, 'productId', line.productId)) ||
    '明细'
  );
}

/** 一行明细的说法：“名称 数量 单位 × 单价”；领料是“名称 领 N 张，退 M 张” */
function lineText(ctx: Ctx, line: unknown, parent: string) {
  if (!isRecord(line)) return '';
  const name = lineName(ctx, line),
    unit = unitOf(ctx, line, parent);
  if (parent === 'materials')
    return (
      name +
      ' 领 ' +
      withUnit(line.issued ?? '—', unit) +
      (!blank(line.returned) && Number(line.returned) !== 0 ? '，退 ' + withUnit(line.returned, unit) : '')
    );
  const yuan = plainYuan(line.unitPrice);
  const price =
    exactPrice(line.unitPriceExact) ??
    money(line.unitPriceCents) ??
    (yuan === null ? null : priceText(yuan, textOf(line.priceBasis), unit));
  return (line.quantity == null ? name : name + ' ' + withUnit(line.quantity, unit)) + (price ? ' × ' + price : '');
}
export function linesText(ctx: Ctx, lines: unknown, parent: string) {
  if (!Array.isArray(lines)) return EMPTY;
  return lines.length ? lines.map((l) => lineText(ctx, l, parent)).join('；') : '没有明细';
}

/** 引用编号（一个或几个）写成名称 */
function refValueText(ctx: Ctx, key: string, value: unknown, row: Row | undefined) {
  if (Array.isArray(value)) return value.length ? value.map((id) => refName(ctx, key, id, row)).join('、') : '无';
  if (blank(value)) return key === 'parentProductId' ? '无' : EMPTY;
  return typeof value === 'number' ? refName(ctx, key, value, row) : null;
}
/** 存代码的字段、税率和普通的文字、数、是否 */
function plainValueText(key: string, value: unknown) {
  if (Object.hasOwn(codeNames, key)) return codeNames[key][String(value)] ?? null;
  if (key === 'taxRate') return /^\d+(\.\d+)?$/.test(String(value)) ? String(value) + '%' : String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return null;
}
/** 有值的字段：单价、以分存的金额、精确单价、带单位的数量，其余按 plainValueText */
function filledValueText(ctx: Ctx, key: string, value: unknown, row: Row | undefined, parent: string) {
  if (key === 'unitPrice') {
    const plain = plainYuan(value);
    return plain === null ? null : priceText(plain, textOf(row?.priceBasis), unitOf(ctx, row, parent));
  }
  // 以分存的：单价（分）、预估成本的几项；元的十进制字符串：精确单价
  if (key === 'unitPriceCents' || (parent === 'costs' && key !== 'basis')) return money(value);
  if (key === 'unitPriceExact') return exactPrice(value);
  if (quantityFields.has(key)) return withUnit(value, unitOf(ctx, row, parent));
  return plainValueText(key, value);
}

/** 一个字段的值怎么写；返回 null 表示这个字段不显示 */
export function valueText(ctx: Ctx, key: string, value: unknown, row: Row | undefined, parent: string): string | null {
  if (refTables[key]) return refValueText(ctx, key, value, row);
  if (key === 'priceCents' || key === 'priceExact') {
    if (key === 'priceCents' ? !value : blank(value)) return UNPRICED_TEXT;
    return key === 'priceCents' ? money(value) : exactPrice(value);
  }
  if (blank(value)) return EMPTY;
  return filledValueText(ctx, key, value, row, parent);
}
