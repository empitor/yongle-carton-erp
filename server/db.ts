import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  Customer,
  CustomerInput,
  Product,
  ProductInput,
  Order,
  OrderInput,
} from '../shared/domain.js';
import { precisionTotal, legacyCents } from '../shared/precision.js';
import { totalCost } from '../shared/domain.js';
import { migrateOperations } from './operations/schema.js';
import { OperationsRepository } from './operations/repository.js';
import { migrateFlow } from './flow/schema.js';
import { migrateAssistant } from './assistant/schema.js';
import { flowReference, shippedUnits } from './flow/service.js';

export const defaultDbPath = resolve(process.env.DB_PATH || 'data/erp.sqlite');
export class Store {
  db: DatabaseSync;
  constructor(path = defaultDbPath) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, notes TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, length INTEGER NOT NULL CHECK(length>0), width INTEGER NOT NULL CHECK(width>0), height INTEGER NOT NULL CHECK(height>0), material TEXT NOT NULL, flute TEXT NOT NULL, requirements TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents>=0), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(id), customer_name TEXT NOT NULL, order_date TEXT NOT NULL, delivery_date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('草稿','已确认','生产中','待发货','已发货','已取消')), notes TEXT NOT NULL, costs_json TEXT, total_cents INTEGER NOT NULL CHECK(total_cents>=0), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS order_lines(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id INTEGER NOT NULL REFERENCES products(id), product_name TEXT NOT NULL, specification TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0));
      CREATE INDEX IF NOT EXISTS orders_filter ON orders(customer_id,order_date,status);
      CREATE INDEX IF NOT EXISTS order_lines_order ON order_lines(order_id);
      INSERT OR IGNORE INTO schema_migrations VALUES(1,datetime('now'));
    `);
    this.migratePrecision();
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS record_lifecycle(entity TEXT NOT NULL,record_id INTEGER NOT NULL,archived_at TEXT NOT NULL,actor_id TEXT NOT NULL,PRIMARY KEY(entity,record_id));
    CREATE TABLE IF NOT EXISTS business_audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,source TEXT NOT NULL,action TEXT NOT NULL,entity TEXT NOT NULL,record_id INTEGER,document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS import_previews(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,revision INTEGER NOT NULL,actor_id TEXT NOT NULL,expires_at TEXT NOT NULL,digest TEXT NOT NULL,document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS import_executions(id TEXT PRIMARY KEY,preview_id TEXT NOT NULL UNIQUE,source_id TEXT NOT NULL UNIQUE,file_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,document TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS import_order_lookup ON import_executions(order_id);
    CREATE INDEX IF NOT EXISTS import_hash_lookup ON import_executions(file_hash);
    CREATE INDEX IF NOT EXISTS import_fingerprint_lookup ON import_executions(fingerprint);
    CREATE INDEX IF NOT EXISTS order_lines_product ON order_lines(product_id);
    INSERT OR IGNORE INTO schema_migrations VALUES(3,datetime('now'));`);
    this.migrateOptionalProducts();
    this.migratePermanentDeletion();
    this.migrateImportReimport();
    migrateOperations(this.db);
    migrateFlow(this.db);
    migrateAssistant(this.db);
  }
  private migratePermanentDeletion() {
    this.db.exec('SAVEPOINT permanent_schema');
    try {
      const orderColumn = this.db
        .prepare('PRAGMA table_info(import_executions)')
        .all()
        .find((c) => c.name === 'order_id');
      if (orderColumn?.notnull) {
        this.db
          .exec(`CREATE TABLE import_executions_v5(id TEXT PRIMARY KEY,preview_id TEXT NOT NULL UNIQUE,source_id TEXT NOT NULL UNIQUE,file_hash TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL UNIQUE,order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,document TEXT NOT NULL);
        INSERT INTO import_executions_v5 SELECT * FROM import_executions;
        DROP TABLE import_executions; ALTER TABLE import_executions_v5 RENAME TO import_executions;
        CREATE INDEX import_order_lookup ON import_executions(order_id);`);
      }
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS permanent_record_deletions(entity TEXT NOT NULL,record_id INTEGER NOT NULL,deleted_at TEXT NOT NULL,actor_id TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(entity,record_id));
      CREATE TABLE IF NOT EXISTS permanent_delete_previews(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,session_binding TEXT NOT NULL,expires_at INTEGER NOT NULL,digest TEXT NOT NULL,document TEXT NOT NULL,result TEXT);
      INSERT OR IGNORE INTO schema_migrations VALUES(5,datetime('now'));`);
      if (this.db.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('永久删除迁移关联校验失败');
      this.db.exec('RELEASE permanent_schema');
    } catch (e) {
      this.db.exec('ROLLBACK TO permanent_schema; RELEASE permanent_schema');
      throw e;
    }
  }
  // 同一原件允许在历史订单永久删除后重新导入：file_hash/fingerprint 不再全表唯一，
  // 重复校验改由导入服务按“有效/回收站/已永久删除”区分处理。
  private migrateImportReimport() {
    this.db.exec('SAVEPOINT import_reimport');
    try {
      const table = this.db
        .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='import_executions'")
        .get() as { sql?: string } | undefined;
      if (table?.sql && /file_hash\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(table.sql)) {
        this.db
          .exec(`CREATE TABLE import_executions_v9(id TEXT PRIMARY KEY,preview_id TEXT NOT NULL UNIQUE,source_id TEXT NOT NULL UNIQUE,file_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,document TEXT NOT NULL);
        INSERT INTO import_executions_v9 SELECT id,preview_id,source_id,file_hash,fingerprint,order_id,actor_id,created_at,document FROM import_executions;
        DROP TABLE import_executions; ALTER TABLE import_executions_v9 RENAME TO import_executions;
        CREATE INDEX IF NOT EXISTS import_order_lookup ON import_executions(order_id);
        CREATE INDEX IF NOT EXISTS import_hash_lookup ON import_executions(file_hash);
        CREATE INDEX IF NOT EXISTS import_fingerprint_lookup ON import_executions(fingerprint);`);
      }
      this.db.exec("INSERT OR IGNORE INTO schema_migrations VALUES(9,datetime('now'))");
      if (
        this.db
          .prepare(
            'SELECT file_hash FROM import_executions WHERE order_id IS NOT NULL GROUP BY file_hash HAVING COUNT(*)>1 LIMIT 1',
          )
          .get()
      )
        throw new Error(
          '发现同一原件关联多张有效或回收站订单，请先由管理员核对；没有自动删除任何记录。',
        );
      this.db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS import_live_file_unique ON import_executions(file_hash) WHERE order_id IS NOT NULL',
      );
      if (this.db.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('导入台账重导迁移关联校验失败');
      this.db.exec('RELEASE import_reimport');
    } catch (e) {
      this.db.exec('ROLLBACK TO import_reimport; RELEASE import_reimport');
      throw e;
    }
  }
  private nextId(entity: 'customers' | 'products' | 'orders') {
    return Number(
      this.db
        .prepare(
          'SELECT MAX(id)+1 n FROM (SELECT COALESCE(MAX(id),0) id FROM ' +
            entity +
            ' UNION ALL SELECT COALESCE(MAX(record_id),0) id FROM permanent_record_deletions WHERE entity=?)',
        )
        .get(entity)!.n,
    );
  }
  private migrateOptionalProducts() {
    const columns = this.db.prepare('PRAGMA table_info(products)').all();
    if (!columns.some((c) => c.name === 'dimension_unit')) {
      const retained = this.db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE tbl_name='products' AND type IN ('index','trigger') AND sql IS NOT NULL",
        )
        .all();
      this.db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
      try {
        this.db
          .exec(`CREATE TABLE products_v4(id INTEGER PRIMARY KEY,name TEXT NOT NULL,length REAL CHECK(length IS NULL OR (length>0 AND length<=10000)),width REAL CHECK(width IS NULL OR (width>0 AND width<=10000)),height REAL CHECK(height IS NULL OR (height>0 AND height<=10000)),dimension_unit TEXT CHECK(dimension_unit IS NULL OR dimension_unit IN ('mm','cm')),material TEXT NOT NULL DEFAULT '',flute TEXT NOT NULL DEFAULT '',requirements TEXT NOT NULL DEFAULT '',price_cents INTEGER NOT NULL DEFAULT 0 CHECK(price_cents>=0),version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,CHECK(dimension_unit IS NULL OR dimension_unit='mm' OR (COALESCE(length,0)<=1000 AND COALESCE(width,0)<=1000 AND COALESCE(height,0)<=1000)));
        INSERT INTO products_v4 SELECT id,name,length,width,height,'mm',material,flute,requirements,price_cents,version,created_at FROM products;
        DROP TABLE products; ALTER TABLE products_v4 RENAME TO products;`);
        for (const item of retained) this.db.exec(String(item.sql));
        if (this.db.prepare('PRAGMA foreign_key_check').all().length)
          throw new Error('产品迁移关联检查失败');
        this.db.exec("INSERT OR IGNORE INTO schema_migrations VALUES(4,datetime('now')); COMMIT");
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      } finally {
        this.db.exec('PRAGMA foreign_keys=ON');
      }
    } else this.db.exec("INSERT OR IGNORE INTO schema_migrations VALUES(4,datetime('now'))");
  }
  migratePrecision() {
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS product_extensions(product_id INTEGER PRIMARY KEY REFERENCES products(id),document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS order_extensions(order_id INTEGER PRIMARY KEY REFERENCES orders(id),document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS order_line_extensions(line_id INTEGER PRIMARY KEY REFERENCES order_lines(id) ON DELETE CASCADE,document TEXT NOT NULL);
    INSERT OR IGNORE INTO schema_migrations VALUES(2,datetime('now'));`);
  }
  extension(
    table: 'product_extensions' | 'order_extensions' | 'order_line_extensions',
    key: string,
    id: number,
  ) {
    const row = this.db.prepare('SELECT document FROM ' + table + ' WHERE ' + key + '=?').get(id);
    return row ? JSON.parse(String(row.document)) : {};
  }
  putExtension(
    table: 'product_extensions' | 'order_extensions' | 'order_line_extensions',
    id: number,
    value: unknown,
  ) {
    this.db
      .prepare('INSERT OR REPLACE INTO ' + table + ' VALUES(?,?)')
      .run(id, JSON.stringify(value));
  }
  close() {
    this.db.close();
  }
  archived(entity: string, id: number) {
    return !!this.db
      .prepare('SELECT 1 FROM record_lifecycle WHERE entity=? AND record_id=?')
      .get(entity, id);
  }
  suppliers(include = false) {
    return new OperationsRepository(this).suppliers(include);
  }
  purchases(include = false) {
    return new OperationsRepository(this).purchases(include);
  }
  stock_items(include = false) {
    return new OperationsRepository(this).items(include);
  }
  customers(includeArchived = false): Customer[] {
    return this.db
      .prepare(
        'SELECT id,name,contact,phone,address,notes,version,created_at AS createdAt FROM customers ORDER BY id DESC',
      )
      .all()
      .filter(
        (r) => includeArchived || !this.archived('customers', Number(r.id)),
      ) as unknown as Customer[];
  }
  products(includeArchived = false): Product[] {
    return this.db
      .prepare(
        'SELECT id,name,length,width,height,dimension_unit AS dimensionUnit,material,flute,requirements,price_cents AS priceCents,version,created_at AS createdAt FROM products ORDER BY id DESC',
      )
      .all()
      .filter((r) => includeArchived || !this.archived('products', Number(r.id)))
      .map((p: any) => ({
        ...p,
        ...this.extension('product_extensions', 'product_id', p.id),
      })) as Product[];
  }
  customer(id: number, includeArchived = false) {
    return this.customers(includeArchived).find((x) => x.id === id);
  }
  product(id: number, includeArchived = false) {
    return this.products(includeArchived).find((x) => x.id === id);
  }
  saveCustomer(v: CustomerInput, id?: number, version?: number, includeArchived = false) {
    if (id) {
      const r = this.db
        .prepare(
          'UPDATE customers SET name=?,contact=?,phone=?,address=?,notes=?,version=version+1 WHERE id=? AND version=?',
        )
        .run(v.name, v.contact, v.phone, v.address, v.notes, id, version!);
      if (!r.changes) throw new ConflictError();
    } else
      id = Number(
        this.db
          .prepare(
            'INSERT INTO customers(id,name,contact,phone,address,notes,created_at) VALUES(?,?,?,?,?,?,?)',
          )
          .run(
            this.nextId('customers'),
            v.name,
            v.contact,
            v.phone,
            v.address,
            v.notes,
            new Date().toISOString(),
          ).lastInsertRowid,
      );
    return this.customer(id, includeArchived)!;
  }
  saveProduct(v: ProductInput, id?: number, version?: number, includeArchived = false) {
    this.db.exec('SAVEPOINT save_product');
    try {
      const result = this.saveProductInner(v, id, version, includeArchived);
      this.db.exec('RELEASE save_product');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK TO save_product; RELEASE save_product');
      throw e;
    }
  }
  private saveProductInner(
    v: ProductInput,
    id?: number,
    version?: number,
    includeArchived = false,
  ) {
    const previous = id ? this.product(id, includeArchived) : undefined;
    const exact =
      v.priceExact ?? (previous?.priceCents === v.priceCents ? previous.priceExact : undefined);
    v = {
      ...v,
      priceExact: exact,
      customerProductCode: v.customerProductCode ?? previous?.customerProductCode,
      dimensionUnit:
        v.dimensionUnit !== undefined ? v.dimensionUnit : (previous?.dimensionUnit ?? null),
      dimensionUnitRaw: v.dimensionUnitRaw ?? previous?.dimensionUnitRaw,
    };
    if (v.priceExact !== undefined) v = { ...v, priceCents: legacyCents(v.priceExact) };
    if (id) {
      const r = this.db
        .prepare(
          'UPDATE products SET name=?,length=?,width=?,height=?,dimension_unit=?,material=?,flute=?,requirements=?,price_cents=?,version=version+1 WHERE id=? AND version=?',
        )
        .run(
          v.name,
          v.length,
          v.width,
          v.height,
          v.dimensionUnit ?? null,
          v.material,
          v.flute,
          v.requirements,
          v.priceCents,
          id,
          version!,
        );
      if (!r.changes) throw new ConflictError();
    } else
      id = Number(
        this.db
          .prepare(
            'INSERT INTO products(id,name,length,width,height,dimension_unit,material,flute,requirements,price_cents,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            this.nextId('products'),
            v.name,
            v.length,
            v.width,
            v.height,
            v.dimensionUnit ?? null,
            v.material,
            v.flute,
            v.requirements,
            v.priceCents,
            new Date().toISOString(),
          ).lastInsertRowid,
      );
    if (
      v.priceExact !== undefined ||
      v.customerProductCode !== undefined ||
      previous?.priceExact !== undefined ||
      v.dimensionUnitRaw !== undefined
    )
      this.putExtension('product_extensions', id, {
        priceExact: v.priceExact,
        customerProductCode: v.customerProductCode,
        dimensionUnitRaw: v.dimensionUnitRaw,
      });
    return this.product(id, includeArchived)!;
  }
  orders(includeArchived = false): Order[] {
    const rows = this.db
      .prepare(
        'SELECT id,number,customer_id AS customerId,customer_name AS customerName,order_date AS orderDate,delivery_date AS deliveryDate,status,notes,costs_json,total_cents AS totalCents,version,created_at AS createdAt,updated_at AS updatedAt FROM orders ORDER BY order_date DESC,id DESC',
      )
      .all();
    const lines = this.db
      .prepare(
        'SELECT id,order_id AS orderId,product_id AS productId,product_name AS productName,specification,quantity,unit_price_cents AS unitPriceCents FROM order_lines ORDER BY id',
      )
      .all();
    return rows
      .filter((r) => includeArchived || !this.archived('orders', Number(r.id)))
      .map((r) => {
        const { costs_json, ...rest } = r;
        const costs = costs_json === null ? null : JSON.parse(String(costs_json));
        const legacyDelivery =
          r.status === '已发货' &&
          !this.db
            .prepare(
              "SELECT 1 FROM flow_refs f JOIN flow_documents d ON d.id=f.document_id WHERE f.order_id=? AND d.kind='delivery' AND d.status='confirmed' LIMIT 1",
            )
            .get(r.id);
        const execution = this.db
            .prepare('SELECT document FROM import_executions WHERE order_id=?')
            .get(Number(r.id)),
          receipt = execution ? JSON.parse(String(execution.document)) : null;
        return {
          ...rest,
          ...(receipt
            ? {
                importSource: {
                  fileName: receipt.fileName,
                  at: receipt.at,
                  actorName: receipt.actor.name,
                  sourceId: receipt.sourceId,
                },
              }
            : {}),
          ...this.extension('order_extensions', 'order_id', Number(r.id)),
          costs,
          deliveryQuantitiesKnown: !legacyDelivery,
          costCents: totalCost(costs),
          lines: lines
            .filter((l) => l.orderId === r.id)
            .map(({ orderId, ...l }) => ({
              ...l,
              ...this.extension('order_line_extensions', 'line_id', Number(l.id)),
              shippedQuantity: legacyDelivery ? null : quantityForDelivery(this, Number(l.id)),
              remainingQuantity: legacyDelivery
                ? null
                : Math.max(0, Number(l.quantity) - quantityForDelivery(this, Number(l.id))),
            })),
        } as Order;
      });
  }
  order(id: number, includeArchived = false) {
    return this.orders(includeArchived).find((x) => x.id === id);
  }
  saveOrder(
    v: OrderInput,
    id?: number,
    version?: number,
    includeArchived = false,
    developer = false,
  ): Order {
    const customer = this.customer(v.customerId, includeArchived);
    if (!customer) throw new InputError('客户不存在或已停用，请先恢复客户或重新选择');
    const previous = id ? this.order(id, includeArchived) : undefined;
    const lines = v.lines.map((l) => {
      const p = this.product(l.productId, includeArchived);
      if (!p) throw new InputError('产品不存在或已停用，请先恢复产品或重新选择');
      const old = previous?.lines.find((x) => x.id === l.id && x.productId === l.productId);
      const exact =
        l.unitPriceExact ??
        (old?.unitPriceCents === l.unitPriceCents ? old.unitPriceExact : undefined);
      return {
        ...l,
        unitPriceExact: exact,
        unitPriceCents: exact !== undefined ? legacyCents(exact) : l.unitPriceCents,
        customerProductCode: l.customerProductCode ?? old?.customerProductCode,
        unit: l.unit ?? old?.unit,
        productName: l.productName ?? old?.productName ?? p.name,
        notes: l.notes ?? old?.notes,
        taxRate: l.taxRate ?? old?.taxRate,
        taxMode: l.taxMode ?? old?.taxMode,
        deliveryDate: l.deliveryDate ?? old?.deliveryDate,
      };
    });
    const precise = precisionTotal(lines);
    const linked = !!id && flowReference(this, 'orders', id);
    if (
      linked &&
      previous &&
      (v.customerId !== previous.customerId ||
        lines.length !== previous.lines.length ||
        lines.some((l) => {
          const old = previous.lines.find((o) => o.id === l.id);
          return (
            !old ||
            old.productId !== l.productId ||
            (!developer && old.quantity !== l.quantity) ||
            old.unit !== l.unit ||
            old.specification !== l.specification
          );
        }))
    )
      throw new InputError(
        '订单已关联生产/送货记录，不能改变客户、产品明细、规格、数量或单位。请通过后续更正单处理。',
      );
    if (linked && developer && lines.some((l) => shippedUnits(this, l.id!) > l.quantity * 1000))
      throw new InputError('订单数量不能低于实际已交付数量，请先更正送货记录。');
    if (
      linked &&
      previous &&
      previous.lines.some((l) => shippedUnits(this, l.id!) > 0) &&
      v.status !== previous.status
    )
      throw new InputError('已产生送货记录的订单状态由实际交付进度维护，请在送货管理更正。');
    const total = precise.cents;
    this.db.exec('SAVEPOINT save_order');
    try {
      const now = new Date().toISOString();
      if (id) {
        const customerName =
          previous?.customerId === v.customerId ? previous.customerName : customer.name;
        const r = this.db
          .prepare(
            'UPDATE orders SET customer_id=?,customer_name=?,order_date=?,delivery_date=?,status=?,notes=?,costs_json=?,total_cents=?,updated_at=?,version=version+1 WHERE id=? AND version=?',
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
            now,
            id,
            version!,
          );
        if (!r.changes) throw new ConflictError();
        if (!linked) this.db.prepare('DELETE FROM order_lines WHERE order_id=?').run(id);
      } else {
        const next = this.nextId('orders');
        const number = `ZX-${v.orderDate.replaceAll('-', '')}-${String(next).padStart(4, '0')}`;
        id = Number(
          this.db
            .prepare(
              'INSERT INTO orders(id,number,customer_id,customer_name,order_date,delivery_date,status,notes,costs_json,total_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            )
            .run(
              next,
              number,
              v.customerId,
              customer.name,
              v.orderDate,
              v.deliveryDate,
              v.status,
              v.notes,
              v.costs === null ? null : JSON.stringify(v.costs),
              total,
              now,
              now,
            ).lastInsertRowid,
        );
      }
      const insert = this.db.prepare(
        'INSERT INTO order_lines(order_id,product_id,product_name,specification,quantity,unit_price_cents) VALUES(?,?,?,?,?,?)',
      );
      for (const l of lines) {
        const result = linked
          ? { lastInsertRowid: l.id! }
          : insert.run(
              id,
              l.productId,
              l.productName,
              l.specification,
              l.quantity,
              l.unitPriceCents,
            );
        if (linked)
          this.db
            .prepare(
              'UPDATE order_lines SET product_name=?,unit_price_cents=?,quantity=? WHERE id=? AND order_id=?',
            )
            .run(l.productName, l.unitPriceCents, l.quantity, l.id!, id);
        if (
          l.unitPriceExact !== undefined ||
          l.customerProductCode !== undefined ||
          l.unit !== undefined ||
          l.notes !== undefined ||
          l.taxRate !== undefined ||
          l.taxMode !== undefined ||
          l.deliveryDate !== undefined
        )
          this.putExtension('order_line_extensions', Number(result.lastInsertRowid), {
            unitPriceExact: l.unitPriceExact,
            customerProductCode: l.customerProductCode,
            unit: l.unit,
            notes: l.notes,
            taxRate: l.taxRate,
            taxMode: l.taxMode,
            deliveryDate: l.deliveryDate,
          });
      }
      const extraKeys = [
        'externalPurchaseOrder',
        'supplierName',
        'currency',
        'taxRate',
        'taxMode',
        'terms',
        'roundingPolicy',
      ] as const;
      if (
        extraKeys.some((k) => v[k] !== undefined) ||
        lines.some((l) => l.unitPriceExact !== undefined)
      )
        this.putExtension('order_extensions', id!, {
          ...Object.fromEntries(extraKeys.map((k) => [k, v[k] ?? previous?.[k]])),
          totalAmountExact: precise.exact,
        });
      if (developer && linked && lines.some((l) => shippedUnits(this, l.id!) > 0)) {
        const complete = lines.every((l) => shippedUnits(this, l.id!) >= l.quantity * 1000);
        this.db
          .prepare('UPDATE orders SET status=? WHERE id=?')
          .run(complete ? '已发货' : '待发货', id);
      }
      this.db.exec('RELEASE save_order');
      return this.order(id, includeArchived)!;
    } catch (error) {
      this.db.exec('ROLLBACK TO save_order; RELEASE save_order');
      throw error;
    }
  }
}
export class InputError extends Error {}
function quantityForDelivery(store: Store, lineId: number) {
  return shippedUnits(store, lineId) / 1000;
}
export class ConflictError extends Error {
  constructor() {
    super('记录已被其他页面修改，请刷新后重试');
  }
}
