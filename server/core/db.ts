import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import { resolve } from 'node:path';
import { APP_VERSION } from '../../shared/core/index.js';
import type { Customer, CustomerInput, Product, ProductInput, Order, OrderInput } from '../../shared/core/index.js';
import { priceFromE4, productSchema } from '../../shared/core/index.js';
import { orderViews, saveOrder, type OrderEditCheck } from './orders.js';
import { existingRecord, given, readBack } from './record-fields.js';
import { rows, type Rows } from './schema/rows.js';
import { exists, many, one } from './sql.js';
import { saveProductRecord } from './products.js';
import { openBusinessDatabase, optimizeDatabase, reclaimSpace } from './schema/index.js';
import { ConflictError } from './errors.js';
import { assertRecordKind } from './record-kinds.js';

export const defaultDbPath = resolve(process.env.DB_PATH || 'data/erp.sqlite');
/** 客户、供应商：库里的一行 → 接口里的往来单位（两张表的列一样；供应商视图在 server/operations/repository.ts 再加归档和采购历史） */
export function partyView(r: Rows['customers'] | Rows['suppliers']): Customer {
  return {
    id: r.id,
    name: r.name,
    contact: r.contact,
    phone: r.phone,
    address: r.address,
    notes: r.notes,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
/** 产品的一行：尺寸单位只有 mm、cm（建表有 CHECK），按产品录入规则的同一个取值校验 */
const productRow = rows.products.extend({ dimension_unit: productSchema.shape.dimensionUnit.unwrap() });
/**
 * 产品：库里的一行 → 接口里的产品。参考单价库里只存一份 price_e4（万分之一元的整数，没定价是 NULL），
 * price_cents 是由它算出来的列。没给过的单位原文、客户料号、附属关系库里是 NULL，读出来不带这个键。
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
    ...given('parentProductId', r.parent_product_id),
    // 没定价：分给 0，不带 priceExact；0 元是 priceExact='0.0000'
    priceCents: r.price_cents ?? 0,
    ...(r.price_e4 === null ? {} : { priceExact: priceFromE4(r.price_e4) }),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
const archivedRow = rows.record_lifecycle.pick({ record_id: true });
/** 某类记录的归档编号：Store.archivedIds 用它；只拿到库连接的（财务的只读窗口）直接调 */
export const archivedIdsIn = (db: DatabaseSync, entity: string) =>
  new Set(many(db, archivedRow, 'SELECT record_id FROM record_lifecycle WHERE entity=?', entity).map((r) => r.record_id));
/** 一组编号（json_each 用的 JSON 数组文字）里归档了的，按主键查：Store.archivedAmong 用它；只拿到库连接的直接调 */
export const archivedAmongIn = (db: DatabaseSync, entity: string, idsJson: string) =>
  new Set(
    many(
      db,
      archivedRow,
      'SELECT record_id FROM record_lifecycle WHERE entity=? AND record_id IN (SELECT value FROM json_each(?)) ORDER BY record_id',
      entity,
      idsJson,
    ).map((r) => r.record_id),
  );
/** 按编号筛（ids 给了才筛）：编号作为 JSON 数组绑定 */
const idFilter = (ids: readonly number[] | undefined) => (ids ? ' WHERE id IN (SELECT value FROM json_each(?))' : '');
const idParams = (ids: readonly number[] | undefined) => (ids ? [JSON.stringify(ids)] : []);
export class Store {
  db: DatabaseSync;
  readonly path: string;
  constructor(path = defaultDbPath) {
    this.path = path;
    // 建表、认版本、升级都在 schema/：旧库、比程序新的库、不是本系统的文件会被拒绝（抛 SchemaError），数据不动
    this.db = openBusinessDatabase(path, { appVersion: APP_VERSION });
  }
  /** 更新查询计划用的统计信息：关闭前会跑，服务运行中每天也跑一次（server/index.ts）。失败不影响业务。 */
  optimize() {
    optimizeDatabase(this.db);
  }
  /**
   * 把删掉数据后空出来的空间还给磁盘，返回还了多少页：服务运行中每天跑一次（server/index.ts）。
   * 内存库、正开着事务时不做，返回 0；失败不影响业务。
   */
  reclaimSpace() {
    return reclaimSpace(this.db);
  }
  close() {
    this.optimize();
    this.db.close();
  }
  /**
   * 归档：在归档标记表里登记。表归基础，删除归档、单据流转都调这里，不直接写这张表。
   * entity 要是各模块登记过的记录种类（record-kinds.ts），没登记的报错。
   */
  markArchived(entity: string, id: number, actorId: string, options: { ignoreExisting?: boolean } = {}) {
    assertRecordKind(entity);
    this.db
      .prepare((options.ignoreExisting ? 'INSERT OR IGNORE' : 'INSERT') + ' INTO record_lifecycle(entity,record_id,archived_at,actor_id) VALUES(?,?,?,?)')
      .run(entity, id, new Date().toISOString(), actorId);
  }
  /** 恢复（或删掉记录时）：去掉归档标记 */
  unarchive(entity: string, id: number) {
    this.db.prepare('DELETE FROM record_lifecycle WHERE entity=? AND record_id=?').run(entity, id);
  }
  archived(entity: string, id: number) {
    return exists(this.db, 'SELECT 1 FROM record_lifecycle WHERE entity=? AND record_id=?', entity, id);
  }
  /** 一次取回某类记录的归档编号，避免列表逐行查询。 */
  archivedIds(entity: string) {
    return archivedIdsIn(this.db, entity);
  }
  /** 这些编号里归档了的（按主键查，只读给的这几条） */
  archivedAmong(entity: string, ids: readonly number[]) {
    return ids.length ? archivedAmongIn(this.db, entity, JSON.stringify(ids)) : new Set<number>();
  }
  customers(includeArchived = false, ids?: readonly number[]): Customer[] {
    const archived = includeArchived ? null : this.archivedIds('customers');
    return many(this.db, rows.customers, 'SELECT * FROM customers' + idFilter(ids) + ' ORDER BY id DESC', ...idParams(ids))
      .filter((r) => !archived?.has(r.id))
      .map(partyView);
  }
  products(includeArchived = false, ids?: readonly number[]): Product[] {
    const archived = includeArchived ? null : this.archivedIds('products');
    return many(this.db, productRow, 'SELECT * FROM products' + idFilter(ids) + ' ORDER BY id DESC', ...idParams(ids))
      .filter((r) => !archived?.has(r.id))
      .map(productView);
  }
  customer(id: number, includeArchived = false): Customer | undefined {
    if (!includeArchived && this.archived('customers', id)) return undefined;
    const row = one(this.db, rows.customers, 'SELECT * FROM customers WHERE id=?', id);
    return row && partyView(row);
  }
  product(id: number, includeArchived = false): Product | undefined {
    if (!includeArchived && this.archived('products', id)) return undefined;
    const row = one(this.db, productRow, 'SELECT * FROM products WHERE id=?', id);
    return row && productView(row);
  }
  saveCustomer(v: CustomerInput, id?: number, version?: number, includeArchived = false) {
    const existing = existingRecord(id, version);
    const now = new Date().toISOString();
    let saved: number;
    if (existing) {
      const r = this.db
        .prepare(
          'UPDATE customers SET name=?,contact=?,phone=?,address=?,notes=?,updated_at=?,version=version+1 WHERE id=? AND version=?',
        )
        .run(v.name, v.contact, v.phone, v.address, v.notes, now, existing.id, existing.version);
      if (!r.changes) throw new ConflictError();
      saved = existing.id;
    } else
      // 编号由数据库分配（AUTOINCREMENT，删掉的也不复用）
      saved = Number(
        this.db
          .prepare(
            'INSERT INTO customers(name,contact,phone,address,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
          )
          .run(v.name, v.contact, v.phone, v.address, v.notes, now, now).lastInsertRowid,
      );
    return readBack(this.customer(saved, includeArchived), '客户');
  }
  /** 保存产品档案（规则见 products.ts）。 */
  saveProduct(v: ProductInput, id?: number, version?: number, includeArchived = false) {
    return saveProductRecord(this, v, { existing: existingRecord(id, version), includeArchived });
  }
  /** 普通订单视图（订单头和明细，见 orders.ts） */
  orders(includeArchived = false): Order[] {
    return orderViews(this, undefined, includeArchived);
  }
  ordersByIds(ids: readonly number[], includeArchived = false): Order[] {
    return ids.length ? orderViews(this, ids, includeArchived) : [];
  }
  order(id: number, includeArchived = false): Order | undefined {
    return orderViews(this, id, includeArchived)[0];
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
    return saveOrder(this, v, { existing: existingRecord(id, version), includeArchived, checkEdit });
  }
}
