// 只管：记录汇总的计算——records.summarize 按模块算的统计数字、采购单未到数量合计、
// 按每张产出几只算订单要几张纸（allocation）。记录怎么筛在 records-filter.ts。
import { z } from 'zod';
import { AppError } from '../../core/index.js';
import { orderMetrics, purchaseMetrics, productMetrics, inventoryMetrics, summarizeMovements } from '../../../shared/business/index.js';
import { sumMoney } from '../../../shared/business/index.js';
import { FINISHED_UNIT, effectiveOrder, quantityString } from '../../../shared/core/index.js';
import { positive, type ToolContext } from './context.js';
import { moduleSchema, type Module, type ModuleRows } from './modules.js';
import type { MatchedRows, RecordFilters } from './records-filter.js';

/** 向上取整：先加上“每张产出数 - 1” */
const ROUND_UP = 1n;

type OrderRow = ModuleRows['orders'][number];
type PurchaseRow = ModuleRows['purchases'][number];

/** 采购单没到的数量，按单位合计（不算已取消的） */
function outstandingQuantities(rows: readonly PurchaseRow[]) {
  const groups = new Map<string, bigint>();
  for (const row of rows.filter((r) => r.status !== '已取消'))
    for (const line of row.lines) {
      const remaining = BigInt(line.remainingUnits);
      groups.set(line.unit, (groups.get(line.unit) || 0n) + remaining);
    }
  // 合计可能超出 Number 能精确表示的范围，按 bigint 写成文字
  return [...groups].map(([unit, value]) => ({ unit, quantity: quantityString(value) }));
}

/** records.summarize 带 allocation：按订单明细和每张产出几只，算各型号独立取整和共用时最少要几张。 */
export function allocateSheets(ctx: ToolContext, raw: unknown) {
  const v = z
    .strictObject({
      module: moduleSchema,
      allocation: z.strictObject({
        orderId: positive,
        unitsPerSheet: positive,
        mode: z.enum(['per-product', 'shared']),
      }),
      filters: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(raw);
  const order = ctx.store.order(v.allocation.orderId);
  if (!order) throw new AppError('客户订单不存在。', 404);
  // 订单明细单位只有“只”（数据库约束），按每张产出几只换算张数
  const rate = BigInt(v.allocation.unitsPerSheet),
    ceil = (n: bigint) => (n + rate - ROUND_UP) / rate;
  const lines = order.lines.map((l) => ({
    orderLineId: l.id,
    productId: l.productId,
    quantity: l.quantity,
    sheets: Number(ceil(BigInt(l.quantity))),
    exactShare:
      String(BigInt(l.quantity) / rate) +
      (BigInt(l.quantity) % rate ? ` + ${BigInt(l.quantity) % rate}/${rate}` : ''),
  }));
  const total = order.lines.reduce((n, l) => n + BigInt(l.quantity), 0n),
    independent = lines.reduce((n, l) => n + l.sheets, 0);
  return {
    orderId: order.id,
    orderVersion: order.version,
    mode: v.allocation.mode,
    unitsPerSheet: v.allocation.unitsPerSheet,
    totalPieces: Number(total),
    perProductSheets: independent,
    sharedMinimumSheets: Number(ceil(total)),
    requiredSheets: v.allocation.mode === 'per-product' ? independent : Number(ceil(total)),
    lines,
    requiresDistribution: v.allocation.mode === 'shared',
    message:
      v.allocation.mode === 'shared'
        ? '共享是总需求下界；具体共用型号、领料归属与余料处理仍须有明确业务规则，不能随意把总张数摊给型号。'
        : '各型号独立向上取整，可按各行实际领料量执行。',
  };
}

/** 订单的精确金额；没有的算没定价（合计就是 null） */
const exactAmount = (r: OrderRow) => r.totalAmountExact ?? null;
/** 订单明细只数合计：明细单位只有“只”（数据库约束），整数直接相加。 */
const orderQuantity = (rows: readonly OrderRow[]) => rows.reduce((n, r) => n + r.lines.reduce((m, l) => m + Number(l.quantity), 0), 0);
/** 每个值出现几条 */
const countBy = <R>(rows: readonly R[], key: (r: R) => unknown) =>
  Object.fromEntries([...new Set(rows.map(key))].map((s) => [String(s), rows.filter((r) => key(r) === s).length]));
/** 订单的总只数和按客户分：只数、单数、金额都只算有效订单（和总金额同一口径）。问“一共多少只、按客户分”时模型直接读，不用翻页自己加。 */
function orderTotals(rows: readonly OrderRow[]) {
  const counted = rows.filter(effectiveOrder);
  const customers = new Map<number, OrderRow[]>();
  for (const r of counted) customers.set(r.customerId, [...(customers.get(r.customerId) ?? []), r]);
  return {
    quantity: orderQuantity(counted),
    unit: FINISHED_UNIT,
    byCustomer: [...customers].map(([customerId, list]) => ({
      customerId,
      customerName: list[0].customerName,
      orders: list.length,
      quantity: orderQuantity(list),
      amount: sumMoney(list.map(exactAmount)),
    })),
    quantityDefinition: '筛出来的有效订单（不含待确认、已取消）的明细只数合计',
  };
}
function orderSummary(rows: readonly OrderRow[]) {
  return {
    ...orderMetrics([...rows]),
    byShippingProgress: countBy(rows, (r) => r.shippingProgress),
    // 订单金额的口径：有效订单，不含待确认、取消
    amount: sumMoney(rows.filter(effectiveOrder).map(exactAmount)),
    amountDefinition: '有效订单精确金额，不含待确认、取消',
    ...orderTotals(rows),
  };
}
function purchaseSummary(rows: readonly PurchaseRow[]) {
  const priced = rows.filter((r) => r.status !== '已取消');
  return {
    ...purchaseMetrics([...rows]),
    receivedAmount: sumMoney(rows.map((r) => r.receivedAmount)),
    byArrivalProgress: countBy(rows, (r) => r.arrivalProgress),
    amount: sumMoney(priced.filter((r) => r.totalAmount !== null).map((r) => r.totalAmount)),
    unpriced: priced.filter((r) => r.totalAmount === null).length,
    outstanding: outstandingQuantities(rows),
  };
}
type MovementFilters = Pick<RecordFilters, 'kind' | 'stockId' | 'productId' | 'q' | 'customerId' | 'supplierId'>;
/** 流水按库存品汇总；库存品按同样的筛选条件挑（按名称规格找的，流水里出现过的也算） */
function movementSummary(ctx: ToolContext, rows: ModuleRows['movements'], f: MovementFilters, page: { offset: number; limit: number }) {
  const ids = new Set(rows.map((r) => Number(r.item_id)));
  const items = ctx.flow.views.items(true).filter(
    (i) =>
      (!f.kind || i.kind === f.kind) &&
      (!f.stockId || i.id === f.stockId) &&
      (!f.productId || i.productId === f.productId) &&
      (!f.q || [i.name, i.specification, i.material, i.flute].join(' ').toLowerCase().includes(f.q.toLowerCase()) || ids.has(i.id)) &&
      ((!f.customerId && !f.supplierId) || ids.has(i.id)),
  );
  const all = summarizeMovements(rows, items);
  return {
    totalGroups: all.length,
    groups: all.slice(page.offset, page.offset + page.limit),
    hasMore: page.offset + page.limit < all.length,
    balanceDefinition: '入出数量受筛选影响；currentQuantity为实时余额，不受日期筛选影响',
  };
}
/** 别的模块：条数和按状态分（有的模块没有状态） */
function statusSummary(rows: readonly Readonly<Record<string, unknown>>[]) {
  return {
    total: rows.length,
    byStatus: Object.fromEntries(
      [...new Set(rows.map((r) => r.status).filter(Boolean))].map((s) => [String(s), rows.filter((r) => r.status === s).length]),
    ),
  };
}
function metricsOf(ctx: ToolContext, matched: MatchedRows, f: RecordFilters, page: { offset: number; limit: number }) {
  switch (matched.module) {
    case 'orders':
      return orderSummary(matched.rows);
    case 'purchases':
      return purchaseSummary(matched.rows);
    case 'products':
      return productMetrics(matched.rows);
    case 'raw_inventory':
      return inventoryMetrics(matched.rows, 'raw');
    case 'finished_inventory':
      return inventoryMetrics(matched.rows, 'finished');
    case 'movements':
      return movementSummary(ctx, matched.rows, f, page);
    case 'customers':
    case 'suppliers':
    case 'arrivals':
    case 'production_tasks':
    case 'production_records':
    case 'deliveries':
      return statusSummary(matched.rows);
  }
}

/** records.summarize：对已经筛好的记录按模块算统计数字。v、f 是 records-read.ts 解析好的参数和筛选条件。 */
export function summarizeRecords(ctx: ToolContext, v: { module: Module; offset: number; limit: number }, f: RecordFilters, matched: MatchedRows) {
  return { module: v.module, filters: f, total: matched.rows.length, metrics: metricsOf(ctx, matched, f, v) };
}
