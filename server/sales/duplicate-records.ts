import { AppError, many, rows, type Store } from '../core/index.js';
import { duplicateKey, normalizeDimensionUnit, normalizedDimensions, specification, type SpecFields } from '../../shared/core/index.js';

/**
 * 新建客户、产品前查重（人工新建、识别导入、助手都用这一处）。
 * 比名字用最严的 duplicateKey（全角半角、大小写、空白、分隔符号都不算区别），连已归档的一起查。
 * 产品三条：客户料号相同一律不建；名称相同、尺寸材质也相同不建（选已有的或先恢复）；
 * 名称相同但尺寸或材质不同可以建——纸箱厂同名不同尺寸很常见——但要人看过已有的同名产品、确认“是另一个产品”才建。
 * 尺寸、材质有一边没写全，说不上“相同”，按第三条让人确认。
 */
const registered = new WeakSet<object>();
function withKey(store: Store) {
  if (!registered.has(store.db)) {
    store.db.function('record_duplicate_key', { deterministic: true }, (v) =>
      v === null || v === undefined ? null : duplicateKey(v),
    );
    registered.add(store.db);
  }
  return store.db;
}

export type DuplicateRecord = { id: number; name: string; archived: boolean };
const customerMatch = rows.customers.pick({ id: true, name: true });
/** 查到的记录补上归档标记（Store 的归档读法，只读查到的这几条） */
function withArchived<R extends { id: number }>(store: Store, entity: 'customers' | 'products', found: R[]) {
  const archived = store.archivedAmong(entity, found.map((r) => r.id));
  return found.map((r) => ({ ...r, archived: archived.has(r.id) }));
}
const productMatch = rows.products
  .pick({ id: true, name: true, length: true, width: true, height: true, material: true, flute: true })
  .extend({
    customerProductCode: rows.products.shape.customer_product_code,
    dimensionUnit: rows.products.shape.dimension_unit,
  });

/** 名字查重键相同的已有客户（含归档） */
export function duplicateCustomers(store: Store, name: string): DuplicateRecord[] {
  const key = duplicateKey(name);
  if (!key) return [];
  const found = many(
    withKey(store),
    customerMatch,
    'SELECT c.id,c.name FROM customers c WHERE record_duplicate_key(c.name)=? ORDER BY c.id LIMIT 50',
    key,
  );
  return withArchived(store, 'customers', found);
}

/** 产品查重要用的资料：名称、料号、所属客户（只在同一个客户里查，两边都空算同一组），以及尺寸和材质 */
export type ProductLike = Omit<SpecFields, 'specification'> & {
  name: string;
  customerId?: number | null;
  customerProductCode?: string | null;
};
export type ProductRecord = DuplicateRecord & Omit<ProductLike, 'name'>;
export type ProductDuplicates = {
  /** 客户料号相同：一律不建 */
  sameCode: ProductRecord[];
  /** 名称相同、尺寸材质也相同：不建，选已有的或先恢复 */
  sameProduct: ProductRecord[];
  /** 名称相同、尺寸或材质不同：确认是另一个产品才建 */
  sameName: ProductRecord[];
};

/** 尺寸（换成毫米）和材质：名称相同时用它分“同一个”和“同名的另一个”；长宽高、单位、材质没写全的是 null */
export const sizeMaterialKey = (p: Omit<ProductLike, 'name'>) => {
  const size = normalizedDimensions(p),
    material = duplicateKey(p.material);
  if (!normalizeDimensionUnit(p.dimensionUnit) || size.some((n) => n === null) || !material) return null;
  return JSON.stringify([...size, material]);
};

export function productDuplicates(store: Store, input: ProductLike, exceptId?: number): ProductDuplicates {
  const name = duplicateKey(input.name),
    code = duplicateKey(input.customerProductCode);
  const empty: ProductDuplicates = { sameCode: [], sameProduct: [], sameName: [] };
  if (!name && !code) return empty;
  const customerId = input.customerId ?? null;
  const matched = many(
    withKey(store),
    productMatch,
    `SELECT p.id,p.name,p.customer_product_code AS customerProductCode,p.length,p.width,p.height,
      p.dimension_unit AS dimensionUnit,p.material,p.flute
    FROM products p
    WHERE p.customer_id IS ?
      AND (? IS NULL OR p.id<>?)
      AND ((?<>'' AND record_duplicate_key(p.name)=?) OR (?<>'' AND record_duplicate_key(p.customer_product_code)=?))
    ORDER BY p.id`,
    customerId,
    exceptId ?? null,
    exceptId ?? null,
    name,
    name,
    code,
    code,
  );
  const found: ProductRecord[] = withArchived(store, 'products', matched);
  const same = sizeMaterialKey(input);
  for (const r of found)
    if (code && duplicateKey(r.customerProductCode) === code) empty.sameCode.push(r);
    else if (same !== null && sizeMaterialKey(r) === same) empty.sameProduct.push(r);
    else empty.sameName.push(r);
  return empty;
}

/** 给人看的一份产品：名称（规格，料号，已归档） */
export function describeProduct(p: ProductRecord | (ProductLike & { archived?: boolean })) {
  const parts = [specification({ ...p, flute: p.flute || '', requirements: '' }) || '没写尺寸材质'];
  if (p.customerProductCode) parts.push('料号 ' + p.customerProductCode);
  if (p.archived) parts.push('已归档');
  return p.name + '（' + parts.join('，') + '）';
}
/** 提示里最多列几个撞上的产品 */
const LISTED_PRODUCTS = 5;
export const describeProducts = (rows: ProductRecord[]) => rows.slice(0, LISTED_PRODUCTS).map(describeProduct).join('；');

/** 改产品时所属客户或查重字段（名称、客户料号、尺寸材质）有没有变 */
export function productIdentityChanged(before: ProductLike, after: ProductLike) {
  return (
    (before.customerId ?? null) !== (after.customerId ?? null) ||
    duplicateKey(before.name) !== duplicateKey(after.name) ||
    duplicateKey(before.customerProductCode) !== duplicateKey(after.customerProductCode) ||
    sizeMaterialKey(before) !== sizeMaterialKey(after)
  );
}

/** 同一批计划新建的多个不同产品（key 不同）之间按同一查重规则核对：同客户下料号相同、同名同尺寸材质拦下 */
export function assertPlannedProductsUnique(items: readonly { key: string; line: number; input: ProductLike }[]) {
  const unique: { key: string; line: number; input: ProductLike }[] = [];
  for (const item of items) {
    if (unique.some((u) => u.key === item.key)) continue;
    const code = duplicateKey(item.input.customerProductCode);
    const name = duplicateKey(item.input.name);
    const sm = sizeMaterialKey(item.input);
    for (const other of unique) {
      if (code && duplicateKey(other.input.customerProductCode) === code)
        throw new AppError(
          '本单第 ' + item.line + ' 行和第 ' + other.line + ' 行客户料号“' + item.input.customerProductCode + '”相同，不能同时新建两个产品：' + describeProduct(other.input) + '。',
          409,
          'duplicate-product',
        );
      if (name && duplicateKey(other.input.name) === name && sm !== null && sizeMaterialKey(other.input) === sm)
        throw new AppError(
          '本单第 ' + item.line + ' 行和第 ' + other.line + ' 行“' + item.input.name + '”尺寸、材质相同，不能同时新建两个产品：' + describeProduct(other.input) + '。',
          409,
          'duplicate-product',
        );
    }
    unique.push(item);
  }
}

/**
 * 新建或改产品查重，三个入口同一套：料号相同、同名同尺寸材质的直接拦；
 * 同名不同尺寸材质的，confirmed（人确认过“是另一个产品”）才放行，否则拦下并列出已有的同名产品。
 */
export function assertNewProductAllowed(store: Store, input: ProductLike, confirmed: boolean, exceptId?: number) {
  const found = productDuplicates(store, input, exceptId);
  if (found.sameCode.length)
    throw new AppError('客户料号“' + input.customerProductCode + '”已经用在：' + describeProducts(found.sameCode) + '。不能再新建一份，请选择已有档案或先恢复。', 409, 'duplicate-product');
  if (found.sameProduct.length)
    throw new AppError('“' + input.name + '”已有尺寸、材质都相同的产品：' + describeProducts(found.sameProduct) + '。请选择已有档案或先恢复，不能再新建一份。', 409, 'duplicate-product');
  if (found.sameName.length && !confirmed)
    throw new AppError('已有同名产品：' + describeProducts(found.sameName) + '。尺寸或材质不一样（或没写全），确认是另一个产品才新建。', 409, 'same-name-product');
  return found;
}
