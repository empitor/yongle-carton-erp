import type { DatabaseSync } from 'node:sqlite';
export function migrateOperations(db: DatabaseSync) {
  db.exec('SAVEPOINT operations_schema');
  try {
    db.exec(`
 CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY,name TEXT NOT NULL,contact TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL,notes TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS stock_items(id INTEGER PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('raw','finished')),unit TEXT NOT NULL,document TEXT NOT NULL,product_id INTEGER REFERENCES products(id),version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS purchases(id INTEGER PRIMARY KEY,number TEXT NOT NULL UNIQUE,supplier_id INTEGER NOT NULL REFERENCES suppliers(id),supplier_name TEXT NOT NULL,customer_order_id INTEGER REFERENCES orders(id),order_date TEXT NOT NULL,expected_date TEXT,status TEXT NOT NULL CHECK(status IN ('待订货','已订货','已取消')),notes TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS purchase_lines(id INTEGER PRIMARY KEY,purchase_id INTEGER NOT NULL REFERENCES purchases(id),stock_item_id INTEGER REFERENCES stock_items(id),document TEXT NOT NULL,quantity_units INTEGER NOT NULL CHECK(quantity_units>0),received_units INTEGER NOT NULL DEFAULT 0 CHECK(received_units>=0));
 CREATE TABLE IF NOT EXISTS purchase_receipts(id TEXT PRIMARY KEY,purchase_id INTEGER NOT NULL REFERENCES purchases(id),reference TEXT NOT NULL,date TEXT NOT NULL,document TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(purchase_id,reference));
 CREATE TABLE IF NOT EXISTS stock_movements(id TEXT PRIMARY KEY,item_id INTEGER NOT NULL REFERENCES stock_items(id),action TEXT NOT NULL CHECK(action IN ('in','out','adjust','purchase')),delta_units INTEGER NOT NULL,before_units INTEGER NOT NULL CHECK(before_units>=0),after_units INTEGER NOT NULL CHECK(after_units>=0),source_kind TEXT NOT NULL,source_id TEXT,purchase_line_id INTEGER REFERENCES purchase_lines(id),customer_order_id INTEGER REFERENCES orders(id),date TEXT NOT NULL,notes TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS operation_requests(kind TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(kind,request_id));
 CREATE INDEX IF NOT EXISTS purchases_supplier ON purchases(supplier_id);
 CREATE INDEX IF NOT EXISTS purchases_order ON purchases(customer_order_id);
 CREATE INDEX IF NOT EXISTS purchase_lines_order ON purchase_lines(purchase_id);
 CREATE INDEX IF NOT EXISTS stock_movements_item ON stock_movements(item_id,created_at);
 INSERT OR IGNORE INTO schema_migrations VALUES(6,datetime('now'));
 `);
    const purchaseLinesDefinition = String(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name='purchase_lines'").get()?.sql || '',
    );
    if (/received_units\s*<=\s*quantity_units/.test(purchaseLinesDefinition)) {
      // SQLite删除被引用旧表会触发约束；事务内暂存并解除可空引用，重建后原样恢复。
      // 外键始终开启，不丢弃实收、库存流水或明细ID。
      const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
      const links: { table: string; column: string; rowid: number; value: number }[] = [];
      const retained = db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE tbl_name='purchase_lines' AND type IN ('index','trigger') AND sql IS NOT NULL",
        )
        .all();
      for (const t of db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()) {
        const table = String(t.name);
        for (const ref of db.prepare('PRAGMA foreign_key_list(' + quote(table) + ')').all()) {
          if (ref.table !== 'purchase_lines') continue;
          const column = String(ref.from);
          if (
            db
              .prepare('PRAGMA table_info(' + quote(table) + ')')
              .all()
              .find((c) => c.name === column)?.notnull
          )
            throw new Error('采购明细迁移发现未知必填关联：' + table + '.' + column);
          for (const row of db
            .prepare(
              'SELECT rowid AS key,' +
                quote(column) +
                ' AS value FROM ' +
                quote(table) +
                ' WHERE ' +
                quote(column) +
                ' IS NOT NULL',
            )
            .all())
            links.push({ table, column, rowid: Number(row.key), value: Number(row.value) });
          db.exec('UPDATE ' + quote(table) + ' SET ' + quote(column) + '=NULL');
        }
      }
      db.exec(`
        CREATE TABLE purchase_lines_maintenance(id INTEGER PRIMARY KEY,purchase_id INTEGER NOT NULL REFERENCES purchases(id),stock_item_id INTEGER REFERENCES stock_items(id),document TEXT NOT NULL,quantity_units INTEGER NOT NULL CHECK(quantity_units>0),received_units INTEGER NOT NULL DEFAULT 0 CHECK(received_units>=0));
        INSERT INTO purchase_lines_maintenance SELECT * FROM purchase_lines;
        DROP TABLE purchase_lines;
        ALTER TABLE purchase_lines_maintenance RENAME TO purchase_lines;
        INSERT OR IGNORE INTO schema_migrations VALUES(11,datetime('now'));`);
      for (const item of retained) db.exec(String(item.sql));
      for (const link of links)
        db.prepare(
          'UPDATE ' + quote(link.table) + ' SET ' + quote(link.column) + '=? WHERE rowid=?',
        ).run(link.value, link.rowid);
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('采购库存迁移关联检查失败');
    db.exec("INSERT OR IGNORE INTO schema_migrations VALUES(11,datetime('now'))");
    db.exec('RELEASE operations_schema');
  } catch (e) {
    db.exec('ROLLBACK TO operations_schema; RELEASE operations_schema');
    throw e;
  }
}
