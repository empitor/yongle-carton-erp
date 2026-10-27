import type { DatabaseSync } from 'node:sqlite';
// 仅添加表，不改写任何历史业务表。
export function migrateFlow(db: DatabaseSync) {
  db.exec('SAVEPOINT flow_schema');
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS flow_documents(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL CHECK(kind IN ('arrival','task','production','delivery')),number TEXT NOT NULL UNIQUE,date TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','confirmed','cancelled','reversed')),version INTEGER NOT NULL DEFAULT 1,document TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS flow_refs(document_id INTEGER NOT NULL REFERENCES flow_documents(id),customer_id INTEGER REFERENCES customers(id),supplier_id INTEGER REFERENCES suppliers(id),product_id INTEGER REFERENCES products(id),order_id INTEGER REFERENCES orders(id),order_line_id INTEGER REFERENCES order_lines(id),purchase_id INTEGER REFERENCES purchases(id),purchase_line_id INTEGER REFERENCES purchase_lines(id),stock_id INTEGER REFERENCES stock_items(id),task_id INTEGER REFERENCES flow_documents(id));
    CREATE INDEX IF NOT EXISTS flow_refs_document ON flow_refs(document_id);
    CREATE INDEX IF NOT EXISTS flow_refs_order ON flow_refs(order_id);
    CREATE TABLE IF NOT EXISTS flow_previews(id TEXT PRIMARY KEY,document_id INTEGER NOT NULL REFERENCES flow_documents(id),actor_id TEXT NOT NULL,session_binding TEXT NOT NULL,expires_at INTEGER NOT NULL,digest TEXT NOT NULL,document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS flow_receipt_keys(supplier_id INTEGER NOT NULL REFERENCES suppliers(id),reference TEXT NOT NULL,document_id INTEGER NOT NULL REFERENCES flow_documents(id),PRIMARY KEY(supplier_id,reference));
    CREATE TABLE IF NOT EXISTS flow_file_uses(hash TEXT PRIMARY KEY,document_id INTEGER NOT NULL REFERENCES flow_documents(id));
    CREATE TABLE IF NOT EXISTS flow_sources(id TEXT PRIMARY KEY,file_name TEXT NOT NULL,hash TEXT NOT NULL,format TEXT NOT NULL,bytes BLOB NOT NULL,document TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL);
    INSERT OR IGNORE INTO schema_migrations VALUES(7,datetime('now'));
    `);
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('实物流转迁移外键检查失败');
    db.exec('RELEASE flow_schema');
  } catch (error) {
    db.exec('ROLLBACK TO flow_schema; RELEASE flow_schema');
    throw error;
  }
}
