import type { z } from 'zod';
import { priceFromE4, productSchema, type Customer, type CustomerInput, type CustomerSite, type Order, type OrderInput, type Product, type ProductInput } from '../../shared/core/index.js';
import { ConflictError, inSavepoint, many, one, rows, type Rows, type Store } from '../core/index.js';
import { customerSites, initialCustomerSites, replaceCustomerSites } from './customer-sites.js';
import { orderViews, saveOrder, type OrderEditCheck } from './orders.js';
import { assertNewProductAllowed } from './duplicate-records.js';
import { moveProductsWithOrder, productsOnlyInOrder, saveProductRecord } from './products.js';
import { existingRecord, given, readBack } from './record-fields.js';

/** 客户：库里的一行 → 接口里的客户档案 */
const customerView = (r: Rows['customers'], sites: CustomerSite[] = []): Customer => ({
  id: r.id, name: r.name, contact: r.contact, phone: r.phone, address: r.address,
  notes: r.notes, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
  sites,
});

/** 产品的一行：尺寸单位只有 mm、cm（建表有 CHECK），按产品录入规则的同一个取值校验，附带所属客户名称 */
const productRow = rows.products.extend({
  dimension_unit: productSchema.shape.dimensionUnit.unwrap(),
  customer_name: rows.customers.shape.name.nullable(),
});
/**
 * 产品：库里的一行 → 接口里的产品。参考单价库里只存一份 price_e4（万分之一元的整数，没定价是 NULL），
 * price_cents 是由它算出来的列。没给过的单位原文、客户料号、所属客户、附属关系库里是 NULL，读出来不带这个键。
 */
function productView(r: z.output<typeof productRow>): Product {
  return {
    id: r.id,
    name: r.name,
    length: r.length,
    width: r.width,
    height: r.height,
    dimensionUnit: r.dimension_unit,
    ...given('dimensionUnitRaw', r.dimension_unit_raw),
    material: r.material,
    flute: r.flute,
    requirements: r.requirements,
    ...given('customerProductCode', r.customer_product_code),
    ...given('customerId', r.customer_id),
    ...given('customerName', r.customer_name),
    ...given('parentProductId', r.parent_product_id),
    // 没定价：分给 0，不带 priceExact；0 元是 priceExact='0.0000'
    priceCents: r.price_cents ?? 0,
    ...(r.price_e4 === null ? {} : { priceExact: priceFromE4(r.price_e4) }),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
/** 按编号筛（ids 给了才筛）：编号作为 JSON 数组绑定 */
const idFilter = (ids: readonly number[] | undefined, column = 'id') =>
  ids ? ` WHERE ${column} IN (SELECT value FROM json_each(?))` : '';
const idParams = (ids: readonly number[] | undefined) => (ids ? [JSON.stringify(ids)] : []);
class SalesRecords {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }
  customers(includeArchived = false, ids?: readonly number[]): Customer[] {
    const archived = includeArchived ? null : this.store.archivedIds('customers');
    const records = many(this.db, rows.customers, 'SELECT * FROM customers' + idFilter(ids) + ' ORDER BY id DESC', ...idParams(ids))
      .filter((r) => !archived?.has(r.id));
    const sites = customerSites(this.store, records.map((r) => r.id));
    return records.map((r) => customerView(r, sites.get(r.id)));
  }
  products(includeArchived = false, ids?: readonly number[]): Product[] {
    const archived = includeArchived ? null : this.store.archivedIds('products');
    return many(
      this.db,
      productRow,
      'SELECT p.*,c.name AS customer_name FROM products p LEFT JOIN customers c ON c.id=p.customer_id' +
        idFilter(ids, 'p.id') +
        ' ORDER BY p.id DESC',
      ...idParams(ids),
    )
      .filter((r) => !archived?.has(r.id))
      .map(productView);
  }
  customer(id: number, includeArchived = false): Customer | undefined {
    if (!includeArchived && this.store.archived('customers', id)) return undefined;
    const row = one(this.db, rows.customers, 'SELECT * FROM customers WHERE id=?', id);
    return row && customerView(row, customerSites(this.store, [id]).get(id));
  }
  product(id: number, includeArchived = false): Product | undefined {
    if (!includeArchived && this.store.archived('products', id)) return undefined;
    const row = one(
      this.db,
      productRow,
      'SELECT p.*,c.name AS customer_name FROM products p LEFT JOIN customers c ON c.id=p.customer_id WHERE p.id=?',
      id,
    );
    return row && productView(row);
  }
  createCustomer(v: CustomerInput) {
    return inSavepoint(this.db, () => {
      const now = new Date().toISOString();
      const id = Number(this.db
        .prepare('INSERT INTO customers(name,contact,phone,address,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(v.name, v.contact, v.phone, v.address, v.notes, now, now).lastInsertRowid);
      replaceCustomerSites(this.store, id, initialCustomerSites(v), now);
      return readBack(this.customer(id), '客户');
    });
  }
  updateCustomer(v: CustomerInput, id: number, version: number, includeArchived = false, beforeSitesRemoved?: (ids: number[]) => void) {
    return inSavepoint(this.db, () => {
      const now = new Date().toISOString();
      const r = this.db
        .prepare(
          'UPDATE customers SET name=?,contact=?,phone=?,address=?,notes=?,updated_at=?,version=version+1 WHERE id=? AND version=?',
        )
        .run(v.name, v.contact, v.phone, v.address, v.notes, now, id, version);
      if (!r.changes) throw new ConflictError();
      if (v.sites !== undefined) replaceCustomerSites(this.store, id, v.sites, now, beforeSitesRemoved);
      return readBack(this.customer(id, includeArchived), '客户');
    });
  }
  createProduct(v: ProductInput) {
    return saveProductRecord(this.productSaveContext(), v, { existing: undefined, includeArchived: false });
  }
  /** 订单服务在同一个保存点内同步关联的成品库存。 */
  updateProduct(v: ProductInput, id: number, version: number, includeArchived = false) {
    return saveProductRecord(this.productSaveContext(), v, { existing: { id, version }, includeArchived });
  }
  private productSaveContext() {
    return { db: this.db, customer: this.customer.bind(this), product: this.product.bind(this) };
  }
  /** 这张订单上订单明细只在这张订单里的产品编号（编辑窗换客户时据此提示哪些产品跟着走，规则见 products.ts） */
  soleProductIds(order: Pick<Order, 'id' | 'lines'>): number[] {
    return [...productsOnlyInOrder(this.db, order.id, order.lines.map((l) => l.productId))];
  }
  /** 订单换客户时把只在这张订单里下过单的原客户产品改归新客户（规则见 products.ts 的 moveProductsWithOrder） */
  moveProductsWithOrder(before: Order, next: Pick<OrderInput, 'customerId' | 'lines'>, includeArchived = false) {
    const assertUnique = (p: Product, customerId: number) => {
      assertNewProductAllowed(this.store, { ...p, customerId }, true, p.id);
    };
    return moveProductsWithOrder({ ...this.productSaveContext(), assertUnique }, before, next, includeArchived);
  }
  /** 普通订单视图（订单头和明细，见 orders.ts） */
  orders(includeArchived = false): Order[] {
    return orderViews(this.store, undefined, includeArchived);
  }
  ordersByIds(ids: readonly number[], includeArchived = false): Order[] {
    return ids.length ? orderViews(this.store, ids, includeArchived) : [];
  }
  order(id: number, includeArchived = false): Order | undefined {
    return orderViews(this.store, id, includeArchived)[0];
  }
  /**
   * 订单的生产中、待发货、已发货由有效单据派生（AGENTS.md），不手工设置：单据流转按单据算出来后调这里写回。
   */
  setDerivedOrderStatus(id: number, status: string, at = new Date().toISOString()) {
    this.db.prepare('UPDATE orders SET status=?,version=version+1,updated_at=? WHERE id=?').run(status, at, id);
  }
  /**
   * 管理员直接改了数据以后，按明细重算全部订单的合计（只改对不上的）。
   * 和 precisionTotal 同一个算式：Σ 数量 × 万分之一元单价，四舍五入到分。只对列算（整数相除），不把算式用在绑定的参数上。
   */
  recomputeOrderTotals() {
    const total =
      '(SELECT (COALESCE(SUM(l.unit_price_e4*l.quantity),0)+50)/100 FROM order_lines l WHERE l.order_id=orders.id)';
    // 合计改了就和别的修改一样：版本号加一、修改时间更新（时间是程序生成的，按参数绑定）
    this.db
      .prepare('UPDATE orders SET total_cents=' + total + ',version=version+1,updated_at=? WHERE total_cents<>' + total)
      .run(new Date().toISOString());
  }
  /** 保存订单（规则见 orders.ts 的 saveOrder），改单核对由调用方传入 */
  saveOrder(v: OrderInput, id?: number, version?: number, includeArchived = false, checkEdit?: OrderEditCheck): Order {
    const context = {
      ...this.productSaveContext(),
      customer: this.customer.bind(this),
      order: this.order.bind(this),
    };
    return saveOrder(context, v, { existing: existingRecord(id, version), includeArchived, checkEdit });
  }
}

/** 按业务库取客户、产品和订单的读写入口。 */
export const sales = (store: Store) => new SalesRecords(store);
