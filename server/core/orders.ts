import type { DatabaseSync } from 'node:sqlite';
import type { Customer, Order, OrderInput, Product } from '../../shared/core/index.js';
import { FINISHED_UNIT, UNITS_PER_QUANTITY, finishedUnit, finishedUnitMessage, fulfillmentSummary, legacyCents, orderSchema, precisionTotal, priceFromE4, priceToE4, quantityString, shippingLineStatus, statuses, totalCost } from '../../shared/core/index.js';
import { z } from 'zod';
import { ConflictError, InputError } from './errors.js';
import { nextAutoId } from './ids.js';
import { inSavepoint } from './savepoint.js';
import { orderRules, type OrderEditGuard } from './order-hooks.js';
import { chosenExact, given, readBack, type ExistingRecord } from './record-fields.js';
import { rows } from './schema/rows.js';
import { many, parseStoredJson } from './sql.js';

/*
 * 订单的读和存（表归基础）：组装订单视图（明细、发货进度、订料进度），保存订单和明细。
 * 发货、订料进度和改已有订单前的核对由单据流转按单据提供（order-hooks.ts）。
 * 用到的 Store 能力从参数传进来（Store 在 db.ts 里把自己传进来），这个文件不引用 db.ts。
 */

/** 读订单要用的：库连接和归档标记 */
export type OrderContext = {
  db: DatabaseSync;
  archived(entity: string, id: number): boolean;
  archivedIds(entity: string): Set<number>;
};
/** 存订单还要读客户、产品和原来的订单 */
export type OrderSaveContext = OrderContext & {
  customer(id: number, includeArchived?: boolean): Customer | undefined;
  product(id: number, includeArchived?: boolean): Product | undefined;
  order(id: number, includeArchived?: boolean): Order | undefined;
};

/** 订单头的一行：状态、金额规则、币种按订单录入规则的同一个取值校验（建表也有同样的 CHECK） */
const orderRow = rows.orders.extend({
  status: z.enum(statuses),
  rounding_policy: orderSchema.shape.roundingPolicy.unwrap().nullable(),
  currency: orderSchema.shape.currency,
});
type StoredOrder = z.output<typeof orderRow>;
/** 明细的一行：unit_price_cents 是由 unit_price_e4（必填）算出来的列，不会是空 */
const lineRow = rows.order_lines.extend({ unit_price_cents: z.number() });
type StoredLine = z.output<typeof lineRow>;
/** 成本估算存成 JSON（没估算是 NULL），按订单录入时的同一个结构读回 */
const storedCosts = orderSchema.shape.costs;

/** 一条明细的视图：发货进度按千分整数相减，再转成最多三位小数的数量（浮点直接相减会得到 1-0.9=0.09999999999999998） */
function lineView(l: StoredLine, shipped: Map<number, number>) {
  const shippedUnits = shipped.get(l.id) || 0,
    plannedUnits = Math.round(l.quantity * UNITS_PER_QUANTITY);
  return {
    id: l.id,
    productId: l.product_id,
    productName: l.product_name,
    specification: l.specification,
    quantity: l.quantity,
    unit: l.unit,
    unitPriceCents: l.unit_price_cents,
    // 库里只存万分之一元的整数；接口里的精确单价是元的字符串，固定四位小数
    unitPriceExact: priceFromE4(l.unit_price_e4),
    ...given('customerProductCode', l.customer_product_code),
    ...given('notes', l.notes),
    ...given('taxRate', l.tax_rate),
    ...given('taxMode', l.tax_mode),
    ...given('deliveryDate', l.delivery_date),
    shippedQuantity: Number(quantityString(shippedUnits)),
    remainingQuantity: Number(quantityString(Math.max(0, plannedUnits - shippedUnits))),
    shippingStatus: shippingLineStatus(plannedUnits, shippedUnits),
  };
}

/** 订单头的视图（不含明细和进度） */
function orderHead(r: StoredOrder) {
  return {
    id: r.id,
    number: r.number,
    customerId: r.customer_id,
    customerName: r.customer_name,
    orderDate: r.order_date,
    deliveryDate: r.delivery_date,
    status: r.status,
    notes: r.notes,
    totalCents: r.total_cents,
    ...given('externalPurchaseOrder', r.external_purchase_order),
    ...given('supplierName', r.supplier_name),
    currency: r.currency,
    ...given('taxRate', r.tax_rate),
    ...given('taxMode', r.tax_mode),
    ...given('terms', r.terms),
    ...given('roundingPolicy', r.rounding_policy),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 订单号末尾序号的位数（ZX-日期-0001） */
const ORDER_SEQUENCE_DIGITS = 4;
/** 订单上可以不填的附加信息，顺序和保存订单时的列一一对应 */
const orderExtraKeys = ['externalPurchaseOrder', 'supplierName', 'currency', 'taxRate', 'taxMode', 'terms', 'roundingPolicy'] as const;
/** 批量组装订单视图：明细、送货、订料各读取一次，查询量不随订单数增长。 */
export function orderViews(ctx: OrderContext, id: number | readonly number[] | undefined, includeArchived: boolean): Order[] {
  const single = typeof id === 'number',
    predicate = single ? '= ?' : id === undefined ? '' : 'IN (SELECT value FROM json_each(?))',
    params = single ? [id] : id === undefined ? [] : [JSON.stringify(id)];
  if (single && !includeArchived && ctx.archived('orders', id)) return [];
  const archived = single || includeArchived ? null : ctx.archivedIds('orders');
  const heads = many(
    ctx.db,
    orderRow,
    'SELECT * FROM orders' + (predicate ? ' WHERE id ' + predicate : '') + ' ORDER BY order_date DESC,id DESC',
    ...params,
  ).filter((r) => !archived?.has(r.id));
  if (!heads.length) return [];
  const linesByOrder = new Map<number, StoredLine[]>();
  for (const l of many(ctx.db, lineRow, 'SELECT * FROM order_lines' + (predicate ? ' WHERE order_id ' + predicate : '') + ' ORDER BY id', ...params)) {
    const group = linesByOrder.get(l.order_id);
    if (group) group.push(l);
    else linesByOrder.set(l.order_id, [l]);
  }
  // 发货进度、订料进度由单据流转按有效单据算（见 order-hooks.ts）
  const scope = single ? [id] : id,
    shipped = orderRules().shipped(ctx.db, scope),
    material = orderRules().material(ctx.db, scope);
  return heads.map((r): Order => {
    const costs =
      r.cost_estimate === null ? null : parseStoredJson(storedCosts, r.cost_estimate, `orders.cost_estimate（订单 ${r.id}）`);
    const orderLines = (linesByOrder.get(r.id) || []).map((l) => lineView(l, shipped));
    const shippingSummary = fulfillmentSummary(
      orderLines.map((l) => l.shippingStatus),
      '已发完',
      '部分发货',
      '未发货',
    );
    return {
      ...orderHead(r),
      // 精确合计不存：数量 × 四位单价，按明细现算
      totalAmountExact: precisionTotal(orderLines).exact,
      costs,
      shippingProgress: shippingSummary.progress,
      shippingSummary,
      materialProgress: material.get(r.id) || 'none',
      costCents: totalCost(costs),
      lines: orderLines,
    };
  });
}
/** 保存订单的目标：改哪张（不给是新建）、能不能用已归档的客户产品和订单、是不是本机管理员的数据维护 */
export type OrderSaveTarget = { existing?: ExistingRecord; includeArchived?: boolean; databaseMaintenance?: boolean };
/**
 * 保存订单。改已有订单时，已关联生产、送货记录的订单能不能这样改、明细是原地改还是整批重写，
 * 由单据流转按单据判断（server/flow/order-edit-guard.ts）。
 */
export function saveOrder(ctx: OrderSaveContext, v: OrderInput, target: OrderSaveTarget = {}): Order {
  const { existing, includeArchived = false, databaseMaintenance = false } = target;
  const customer = ctx.customer(v.customerId, includeArchived);
  if (!customer) throw new InputError('客户不存在或已归档，请先恢复客户或重新选择');
  const previous = existing ? ctx.order(existing.id, includeArchived) : undefined;
  const lines = savedLines(ctx, v, previous, includeArchived);
  const precise = precisionTotal(lines);
  // 已有生产、送货记录的订单哪些能改由单据流转判断（不允许的在这里就抛错）
  const edit: ReturnType<OrderEditGuard> = existing
    ? orderRules().editGuard(ctx.db, databaseMaintenance)(existing.id, previous, { customerId: v.customerId, status: v.status, lines })
    : { linked: false };
  // 订单上的附加信息：这次没给的沿用原来的，都没有就是 NULL（币种只有人民币）
  const extras = orderExtraKeys.map((k) => v[k] ?? previous?.[k] ?? (k === 'currency' ? 'CNY' : null));
  return inSavepoint(ctx.db, () => {
    const row = { v, total: precise.cents, extras, now: new Date().toISOString() };
    let id: number;
    if (existing) {
      id = existing.id;
      updateOrderRow(ctx, existing, { ...row, customerName: previous?.customerId === v.customerId ? previous.customerName : customer.name });
      removeDroppedLines(ctx, id, previous, lines, edit);
    } else id = insertOrderRow(ctx, { ...row, customerName: customer.name });
    writeOrderLines(ctx, id, lines, edit.linked);
    return readBack(ctx.order(id, includeArchived), '订单');
  });
}

type LineInput = OrderInput['lines'][number];
type StoredLineView = Order['lines'][number];

/**
 * 明细的名称：这一行换了产品，名称跟着新产品的档案走，不收带过来的旧名称，免得编号和名称指的不是一个东西；
 * 没换的用这次给的，没给沿用原来的，再没有用产品名称
 */
function lineName(l: LineInput, previous: Order | undefined, old: StoredLineView | undefined, productName: string) {
  const switched = !!previous?.lines.some((x) => x.id === l.id && x.productId !== l.productId);
  return switched ? productName : (l.productName ?? old?.productName ?? productName);
}

/**
 * 单价只存一份（万分之一元的整数），这里定下四位小数的精确价。只给了分：分没变就沿用原来的四位价，分变了按分存。
 * 精确价和分都给了：见 chosenExact（对不上又分不清改的是哪一头就拒收）
 */
function lineExact(l: LineInput, old: StoredLineView | undefined, productName: string) {
  const given = chosenExact(l.unitPriceExact, l.unitPriceCents, old?.unitPriceExact, old?.unitPriceCents, '“' + productName + '”的单价');
  return (
    given ??
    (old?.unitPriceCents === l.unitPriceCents ? old.unitPriceExact : undefined) ??
    priceFromE4(l.unitPriceCents * 100)
  );
}

/** 这次没给的料号、备注、税率、含税口径、交期沿用原来的 */
function carriedLineFields(l: LineInput, old: StoredLineView | undefined) {
  return {
    customerProductCode: l.customerProductCode ?? old?.customerProductCode,
    notes: l.notes ?? old?.notes,
    taxRate: l.taxRate ?? old?.taxRate,
    taxMode: l.taxMode ?? old?.taxMode,
    deliveryDate: l.deliveryDate ?? old?.deliveryDate,
  };
}

/** 这次要存的明细：产品、名称、单位、单价按规则定下来（产品不存在、单位不对、单价对不上就拒收） */
function savedLines(ctx: OrderSaveContext, v: OrderInput, previous: Order | undefined, includeArchived: boolean) {
  return v.lines.map((l) => {
    const p = ctx.product(l.productId, includeArchived);
    if (!p) throw new InputError('产品不存在或已归档，请先恢复产品或重新选择');
    const old = previous?.lines.find((x) => x.id === l.id && x.productId === l.productId);
    const productName = lineName(l, previous, old, p.name);
    // 产品数量单位只有“只”：“个”、没写、pcs 都存成“只”，别的一律拒收
    const unit = finishedUnit(l.unit ?? old?.unit);
    if (unit !== FINISHED_UNIT) throw new InputError(finishedUnitMessage);
    const exact = lineExact(l, old, productName);
    return { ...l, unitPriceExact: exact, unitPriceCents: legacyCents(exact), ...carriedLineFields(l, old), unit, productName };
  });
}
type SavedLine = ReturnType<typeof savedLines>[number];
/** 订单头要写的值（customerName：改订单没换客户时沿用原来存的名字） */
type OrderRow = { v: OrderInput; customerName: string; total: number; extras: (string | number | null)[]; now: string };

/** 改订单头：版本对不上（别人先改了）就报冲突 */
function updateOrderRow(ctx: OrderSaveContext, existing: ExistingRecord, { v, customerName, total, extras, now }: OrderRow) {
  const r = ctx.db
    .prepare(
      'UPDATE orders SET customer_id=?,customer_name=?,order_date=?,delivery_date=?,status=?,notes=?,cost_estimate=?,total_cents=?,' +
        'external_purchase_order=?,supplier_name=?,currency=?,tax_rate=?,tax_mode=?,terms=?,rounding_policy=?,updated_at=?,version=version+1 WHERE id=? AND version=?',
    )
    .run(
      v.customerId,
      customerName,
      v.orderDate,
      v.deliveryDate,
      v.status,
      v.notes,
      v.costs === null ? null : JSON.stringify(v.costs),
      total,
      ...extras,
      now,
      existing.id,
      existing.version,
    );
  if (!r.changes) throw new ConflictError();
}

/** 改订单时去掉旧明细：没关联单据的整批重写；有关联的按单据流转的判断，只删这次没有的行 */
function removeDroppedLines(ctx: OrderSaveContext, id: number, previous: Order | undefined, lines: SavedLine[], edit: ReturnType<OrderEditGuard>) {
  if (!edit.linked) ctx.db.prepare('DELETE FROM order_lines WHERE order_id=?').run(id);
  else if (edit.removeMissingLines && previous)
    for (const old of previous.lines)
      if (!lines.some((l) => l.id === old.id))
        ctx.db.prepare('DELETE FROM order_lines WHERE id=? AND order_id=?').run(old.id, id);
}

/** 新建订单头，返回编号：订单号里的序号就是真正分到的编号，删掉的订单编号也不复用 */
function insertOrderRow(ctx: OrderSaveContext, { v, customerName, total, extras, now }: OrderRow) {
  const next = nextAutoId(ctx.db, 'orders');
  const number = `ZX-${v.orderDate.replaceAll('-', '')}-${String(next).padStart(ORDER_SEQUENCE_DIGITS, '0')}`;
  return Number(
    ctx.db
      .prepare(
        'INSERT INTO orders(id,number,customer_id,customer_name,order_date,delivery_date,status,notes,cost_estimate,total_cents,' +
          'external_purchase_order,supplier_name,currency,tax_rate,tax_mode,terms,rounding_policy,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        next,
        number,
        v.customerId,
        customerName,
        v.orderDate,
        v.deliveryDate,
        v.status,
        v.notes,
        v.costs === null ? null : JSON.stringify(v.costs),
        total,
        ...extras,
        now,
        now,
      ).lastInsertRowid,
  );
}

/** 写明细：已有生产、送货记录的订单，原有明细保留编号原地改；别的明细都是新插入 */
function writeOrderLines(ctx: OrderSaveContext, id: number, lines: SavedLine[], linked: boolean) {
  // unit_price_cents 是由 unit_price_e4 算出来的列，不写；没给的料号、备注、税率、含税口径、交期存 NULL（给了空串的存空串）
  const lineValues = (l: (typeof lines)[number]) => [
    l.productId,
    l.productName,
    l.specification,
    l.quantity,
    l.unit,
    priceToE4(l.unitPriceExact),
    l.customerProductCode ?? null,
    l.notes ?? null,
    l.taxRate ?? null,
    l.taxMode ?? null,
    l.deliveryDate ?? null,
  ];
  const insert = ctx.db.prepare(
      'INSERT INTO order_lines(order_id,product_id,product_name,specification,quantity,unit,unit_price_e4,customer_product_code,notes,tax_rate,tax_mode,delivery_date) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ),
    update = ctx.db.prepare(
      'UPDATE order_lines SET product_id=?,product_name=?,specification=?,quantity=?,unit=?,unit_price_e4=?,customer_product_code=?,notes=?,tax_rate=?,tax_mode=?,delivery_date=? WHERE id=? AND order_id=?',
    );
  for (const l of lines) {
    if (linked && l.id) update.run(...lineValues(l), l.id, id);
    else insert.run(id, ...lineValues(l));
  }
}
