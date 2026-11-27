import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import type { Customer, Product, ProductInput } from '../../shared/core/index.js';
import { PRODUCT_CUSTOMER_LOCKED, priceToE4, productMovesWithOrder } from '../../shared/core/index.js';
import { AppError, ConflictError, InputError, exists, many, type Store } from '../core/index.js';
import { chosenExact, readBack, type ExistingRecord } from './record-fields.js';

/*
 * 产品保存：参考单价只存一份、这次没给的附加信息沿用原来的、所属客户和附属关系的核对。
 * 连带改成品库存在订单服务（server/orders/service.ts）；用到的 Store 能力从参数传进来，这个文件不引用 db.ts。
 */

/** 存产品要用的：库连接，以及按编号读客户和产品 */
type ProductSaveContext = {
  db: DatabaseSync;
  customer(id: number, includeArchived?: boolean): Customer | undefined;
  product(id: number, includeArchived?: boolean): Product | undefined;
};

/**
 * 参考单价只存一份（万分之一元的整数，没定价是 null）。只给了分：分没变就沿用原来的四位价，分变了按分存，分是 0 就是没定价。
 * 精确价和分都给了：见 chosenExact（对不上又分不清改的是哪一头就拒收）。分是 0 当作没给分：校验对没给的分补的就是 0
 */
function priceE4Of(v: ProductInput, previous: Product | undefined) {
  const given =
    v.priceCents > 0
      ? chosenExact(v.priceExact, v.priceCents, previous?.priceExact, previous?.priceCents, '参考单价')
      : v.priceExact;
  const exact = given ?? (v.priceCents > 0 && previous?.priceCents === v.priceCents ? previous.priceExact : undefined);
  return exact !== undefined ? priceToE4(exact) : v.priceCents > 0 ? v.priceCents * 100 : null;
}

/** 这次没给的客户料号、尺寸单位、单位原文、所属客户、附属关系沿用原来的（都没有就是 null） */
function withPrevious(v: ProductInput, previous: Product | undefined): ProductInput {
  return {
    ...v,
    customerProductCode: v.customerProductCode ?? previous?.customerProductCode,
    dimensionUnit: v.dimensionUnit !== undefined ? v.dimensionUnit : (previous?.dimensionUnit ?? null),
    dimensionUnitRaw: v.dimensionUnitRaw ?? previous?.dimensionUnitRaw,
    customerId: v.customerId !== undefined ? v.customerId : (previous?.customerId ?? null),
    parentProductId: v.parentProductId !== undefined ? v.parentProductId : (previous?.parentProductId ?? null),
  };
}

/** 这个产品有没有下过订单（在订单明细里出现过） */
function hasProductOrders(db: DatabaseSync, productId: number) {
  return exists(db, 'SELECT 1 FROM order_lines WHERE product_id=? LIMIT 1', productId);
}

/** 产品要定给的客户不存在或已归档 */
const CUSTOMER_UNAVAILABLE = '客户不存在或已归档，请先恢复客户或重新选择。';

/**
 * 所属客户核对：
 * - 没下过单的产品随时可以改客户或清空；
 * - 下过单的产品只能从“没定客户”补定给某一家，不能从 A 改给 B 或清空（要给别的客户用得新建一份）；唯一的例外是订单换客户时
 *   只在这张订单里下过单的产品跟着走（moveProductsWithOrder，不经这里）；
 * - 只有原归属本来就是这家归档客户且未变动时才允许沿用；任何新指派（含超管、数据管理、助手）一律拒绝归档客户。
 */
function checkedCustomer(
  ctx: ProductSaveContext,
  customerId: number | null | undefined,
  previous: Product | undefined,
) {
  const next = customerId ?? null;
  if (previous && previous.customerId != null && next !== previous.customerId && hasProductOrders(ctx.db, previous.id))
    throw new InputError(PRODUCT_CUSTOMER_LOCKED);
  if (next === null) return null;
  const keepArchived = previous?.customerId === next;
  if (!ctx.customer(next, keepArchived)) throw new InputError(CUSTOMER_UNAVAILABLE);
  return next;
}

/**
 * 附属于哪个产品（只影响显示）：附属的产品已经永久删掉了（删除前打开的编辑窗带回来的）当成没有附属，不卡保存；
 * 从来没有过的产品编号照样拦下；不能附属自己，也不能绕成一圈。id 是正在存的产品（新建时没有）。
 */
function checkedParent(ctx: ProductSaveContext, parentId: number | null | undefined, id: number | undefined) {
  if (!parentId) return parentId;
  if (
    !ctx.product(parentId, true) &&
    exists(ctx.db, "SELECT 1 FROM permanent_record_deletions WHERE entity='products' AND record_id=?", parentId)
  )
    return null;
  if (parentId === id) throw new InputError('产品不能附属于自己。');
  const seen = new Set<number>();
  for (let p: number | null | undefined = parentId; p; p = ctx.product(p, true)?.parentProductId) {
    if (!ctx.product(p, true)) throw new InputError('附属的产品不存在。');
    if (p === id || seen.has(p)) throw new InputError('附属关系不能绕成一圈，请换一个产品。');
    seen.add(p);
  }
  return parentId;
}

/** 改产品：版本对不上（别人先改了）就报冲突 */
function updateProduct(ctx: ProductSaveContext, existing: ExistingRecord, values: SQLInputValue[], now: string) {
  const r = ctx.db
    .prepare(
      'UPDATE products SET name=?,length=?,width=?,height=?,dimension_unit=?,dimension_unit_raw=?,material=?,flute=?,requirements=?,customer_product_code=?,customer_id=?,parent_product_id=?,price_e4=?,updated_at=?,version=version+1 WHERE id=? AND version=?',
    )
    .run(...values, now, existing.id, existing.version);
  if (!r.changes) throw new ConflictError();
  return existing.id;
}

/** 新建产品，返回编号：编号由数据库分配（AUTOINCREMENT，删掉的也不复用） */
function insertProduct(ctx: ProductSaveContext, values: SQLInputValue[], now: string) {
  return Number(
    ctx.db
      .prepare(
        'INSERT INTO products(name,length,width,height,dimension_unit,dimension_unit_raw,material,flute,requirements,customer_product_code,customer_id,parent_product_id,price_e4,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(...values, now, now).lastInsertRowid,
  );
}

/** 存一个产品（新建或改 existing 那一条），返回按 includeArchived 的范围读回来的产品 */
export function saveProductRecord(
  ctx: ProductSaveContext,
  input: ProductInput,
  target: { existing: ExistingRecord | undefined; includeArchived: boolean },
): Product {
  const { existing, includeArchived } = target;
  const previous = existing ? ctx.product(existing.id, includeArchived) : undefined;
  const priceE4 = priceE4Of(input, previous);
  const filled = withPrevious(input, previous);
  const v = {
    ...filled,
    customerId: checkedCustomer(ctx, filled.customerId, previous),
    parentProductId: checkedParent(ctx, filled.parentProductId, existing?.id),
  };
  const now = new Date().toISOString();
  // price_cents 是由 price_e4 算出来的列，不写；没给的客户料号、单位原文、所属客户、附属关系存 NULL（给了空串的存空串）
  const values: SQLInputValue[] = [
    v.name,
    v.length,
    v.width,
    v.height,
    v.dimensionUnit ?? null,
    v.dimensionUnitRaw ?? null,
    v.material,
    v.flute,
    v.requirements,
    v.customerProductCode ?? null,
    v.customerId,
    v.parentProductId ?? null,
    priceE4,
  ];
  const id = existing ? updateProduct(ctx, existing, values, now) : insertProduct(ctx, values, now);
  return readBack(ctx.product(id, includeArchived), '产品');
}

const idRow = z.object({ id: z.number() });

/** 这几个产品里订单明细全在 orderId 这张订单里的：别的订单一行都没有（不管状态、归没归档）；一行明细都没有的不算 */
export function productsOnlyInOrder(db: DatabaseSync, orderId: number, productIds: readonly number[]): Set<number> {
  if (!productIds.length) return new Set();
  const rows = many(
    db,
    idRow,
    'SELECT product_id AS id FROM order_lines WHERE product_id IN (SELECT value FROM json_each(?)) GROUP BY product_id HAVING SUM(order_id<>?)=0',
    JSON.stringify(productIds),
    orderId,
  );
  return new Set(rows.map((r) => r.id));
}

/** 订单换客户带过去的产品：改前、改后 */
export type MovedProduct = { before: Product; after: Product };
/** 带产品过去时要用的：读客户、产品，和按新客户查重（撞上抛错） */
type ProductMoveContext = Pick<ProductSaveContext, 'db' | 'customer' | 'product'> & {
  assertUnique(product: Product, customerId: number): void;
};

/**
 * 订单换客户（order 是改之前的，next 是这次要存的）：明细里属原客户、订单明细只在这张订单里的产品（productMovesWithOrder）
 * 改归新客户。这是“下过单不能改所属客户”（checkedCustomer）唯一的例外，所以按库里的明细再核一遍，不信调用方。
 * 新客户不存在的不管（订单保存会拒），已归档的拒（任何新指派都拒归档客户）；改过去撞查重的拒，前面说清是哪个产品。
 * 版本号加一、更新时间跟着改；成品库存不用同步（客户名是读的时候带出来的）。由订单服务在订单保存的同一个保存点里调。
 */
export function moveProductsWithOrder(
  ctx: ProductMoveContext,
  order: { id: number; customerId: number },
  next: { customerId: number; lines: readonly { productId: number }[] },
  includeArchived: boolean,
): MovedProduct[] {
  const change = { from: order.customerId, to: next.customerId };
  if (change.from === change.to || !ctx.customer(change.to, true)) return [];
  const ids = [...new Set(next.lines.map((l) => l.productId))],
    sole = productsOnlyInOrder(ctx.db, order.id, ids);
  const moving = ids.flatMap((id) => {
    const p = ctx.product(id, includeArchived);
    return p && productMovesWithOrder(p, change, sole.has(id)) ? [p] : [];
  });
  if (!moving.length) return [];
  const customer = ctx.customer(change.to, false);
  if (!customer) throw new InputError(CUSTOMER_UNAVAILABLE);
  return moving.map((before) => {
    try {
      ctx.assertUnique(before, customer.id);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      throw new AppError('产品“' + before.name + '”只在这张订单里下过单，要跟着订单改归 ' + customer.name + '：' + e.message, e.status, e.code);
    }
    const r = ctx.db
      .prepare('UPDATE products SET customer_id=?,updated_at=?,version=version+1 WHERE id=? AND version=?')
      .run(customer.id, new Date().toISOString(), before.id, before.version);
    if (!r.changes) throw new ConflictError();
    return { before, after: readBack(ctx.product(before.id, includeArchived), '产品') };
  });
}
const productCustomerRow = z.object({ productId: z.number(), customerName: z.string() });
const unassignedRow = z.object({ id: z.number(), name: z.string() });

/** 这个产品有没有下过单 */
export function productHasOrders(store: Store, productId: number): boolean {
  return hasProductOrders(store.db, productId);
}

/** 批量查这批产品里哪些下过单（数据管理判断哪些产品的客户栏要锁住用） */
export function orderedProductIds(store: Store, productIds: readonly number[]): Set<number> {
  if (!productIds.length) return new Set();
  const rows = many(
    store.db,
    idRow,
    'SELECT DISTINCT product_id AS id FROM order_lines WHERE product_id IN (SELECT value FROM json_each(?))',
    JSON.stringify(productIds),
  );
  return new Set(rows.map((r) => r.id));
}

/** 批量查这批产品分别给哪些客户下过单（按产品编号分组，去重） */
export function orderedCustomersByProduct(store: Store, productIds: readonly number[]): Map<number, string[]> {
  const result = new Map<number, string[]>();
  if (!productIds.length) return result;
  const rows = many(
    store.db,
    productCustomerRow,
    `SELECT DISTINCT l.product_id AS productId, c.name AS customerName
     FROM order_lines l
     JOIN orders o ON o.id=l.order_id
     JOIN customers c ON c.id=o.customer_id
     WHERE l.product_id IN (SELECT value FROM json_each(?))
     ORDER BY l.product_id, c.id`,
    JSON.stringify(productIds),
  );
  for (const r of rows) {
    const names = result.get(r.productId);
    if (names) names.push(r.customerName);
    else result.set(r.productId, [r.customerName]);
  }
  return result;
}

/** 还没定所属客户的在用产品（系统体检用）：给两家以上客户下过单的排在前面，标出是哪几家 */
export function unassignedProducts(store: Store, limit: number) {
  const archived = store.archivedIds('products');
  const active = many(store.db, unassignedRow, 'SELECT id,name FROM products WHERE customer_id IS NULL ORDER BY id DESC').filter(
    (r) => !archived.has(r.id),
  );
  const byProduct = orderedCustomersByProduct(
    store,
    active.map((r) => r.id),
  );
  const list = active
    .map((r) => ({ id: r.id, name: r.name, orderedCustomers: byProduct.get(r.id) ?? [] }))
    .sort((a, b) => b.orderedCustomers.length - a.orderedCustomers.length || b.id - a.id);
  return { total: list.length, shown: list.slice(0, limit) };
}
