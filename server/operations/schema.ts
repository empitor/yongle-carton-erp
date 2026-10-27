import type { DatabaseSync } from 'node:sqlite';
export function migrateOperations(db: DatabaseSync) {
  db.exec('SAVEPOINT operations_schema');
  try {
    db.exec(`
 CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY,name TEXT NOT NULL,contact TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL,notes TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS stock_items(id INTEGER PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('raw','finished')),unit TEXT NOT NULL,document TEXT NOT NULL,product_id INTEGER REFERENCES products(id),version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS purchases(id INTEGER PRIMARY KEY,number TEXT NOT NULL UNIQUE,supplier_id INTEGER NOT NULL REFERENCES suppliers(id),supplier_name TEXT NOT NULL,customer_order_id INTEGER REFERENCES orders(id),order_date TEXT NOT NULL,expected_date TEXT,status TEXT NOT NULL CHECK(status IN ('待订货','已订货','已取消')),notes TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS purchase_lines(id INTEGER PRIMARY KEY,purchase_id INTEGER NOT NULL REFERENCES purchases(id),stock_item_id INTEGER REFERENCES stock_items(id),document TEXT NOT NULL,quantity_units INTEGER NOT NULL CHECK(quantity_units>0),received_units INTEGER NOT NULL DEFAULT 0 CHECK(received_units>=0 AND received_units<=quantity_units));
 CREATE TABLE IF NOT EXISTS purchase_receipts(id TEXT PRIMARY KEY,purchase_id INTEGER NOT NULL REFERENCES purchases(id),reference TEXT NOT NULL,date TEXT NOT NULL,document TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(purchase_id,reference));
 CREATE TABLE IF NOT EXISTS stock_movements(id TEXT PRIMARY KEY,item_id INTEGER NOT NULL REFERENCES stock_items(id),action TEXT NOT NULL CHECK(action IN ('in','out','adjust','purchase')),delta_units INTEGER NOT NULL,before_units INTEGER NOT NULL CHECK(before_units>=0),after_units INTEGER NOT NULL CHECK(after_units>=0),source_kind TEXT NOT NULL,source_id TEXT,purchase_line_id INTEGER REFERENCES purchase_lines(id),customer_order_id INTEGER REFERENCES orders(id),date TEXT NOT NULL,notes TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS operation_requests(kind TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(kind,request_id));
 CREATE INDEX IF NOT EXISTS purchases_supplier ON purchases(supplier_id);
 CREATE INDEX IF NOT EXISTS purchases_order ON purchases(customer_order_id);
 CREATE INDEX IF NOT EXISTS purchase_lines_order ON purchase_lines(purchase_id);
 CREATE INDEX IF NOT EXISTS stock_movements_item ON stock_movements(item_id,created_at);
 INSERT OR IGNORE INTO schema_migrations VALUES(6,datetime('now'));
 `);
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('采购库存迁移关联检查失败');
    db.exec('RELEASE operations_schema');
  } catch (e) {
    db.exec('ROLLBACK TO operations_schema; RELEASE operations_schema');
    throw e;
  }
}
