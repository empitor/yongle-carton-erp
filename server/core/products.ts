import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Product, ProductInput } from '../../shared/core/index.js';
import { priceToE4 } from '../../shared/core/index.js';
import { ConflictError, InputError } from './errors.js';
import { chosenExact, readBack, type ExistingRecord } from './record-fields.js';
import { exists } from './sql.js';

/*
 * 产品的保存（表归基础）：参考单价只存一份、这次没给的附加信息沿用原来的、附属关系的核对。
 * 连带改成品库存在 Store.saveProduct（db.ts）；用到的 Store 能力从参数传进来，这个文件不引用 db.ts。
 */

/** 存产品要用的：库连接和按编号读产品 */
export type ProductSaveContext = { db: DatabaseSync; product(id: number, includeArchived?: boolean): Product | undefined };

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

/** 这次没给的客户料号、尺寸单位、单位原文、附属关系沿用原来的（都没有就是 null） */
function withPrevious(v: ProductInput, previous: Product | undefined): ProductInput {
  return {
    ...v,
    customerProductCode: v.customerProductCode ?? previous?.customerProductCode,
    dimensionUnit: v.dimensionUnit !== undefined ? v.dimensionUnit : (previous?.dimensionUnit ?? null),
    dimensionUnitRaw: v.dimensionUnitRaw ?? previous?.dimensionUnitRaw,
    parentProductId: v.parentProductId !== undefined ? v.parentProductId : (previous?.parentProductId ?? null),
  };
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
      'UPDATE products SET name=?,length=?,width=?,height=?,dimension_unit=?,dimension_unit_raw=?,material=?,flute=?,requirements=?,customer_product_code=?,parent_product_id=?,price_e4=?,updated_at=?,version=version+1 WHERE id=? AND version=?',
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
        'INSERT INTO products(name,length,width,height,dimension_unit,dimension_unit_raw,material,flute,requirements,customer_product_code,parent_product_id,price_e4,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
  const v = { ...filled, parentProductId: checkedParent(ctx, filled.parentProductId, existing?.id) };
  const now = new Date().toISOString();
  // price_cents 是由 price_e4 算出来的列，不写；没给的客户料号、单位原文、附属关系存 NULL（给了空串的存空串）
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
    v.parentProductId ?? null,
    priceE4,
  ];
  const id = existing ? updateProduct(ctx, existing, values, now) : insertProduct(ctx, values, now);
  return readBack(ctx.product(id, includeArchived), '产品');
}
