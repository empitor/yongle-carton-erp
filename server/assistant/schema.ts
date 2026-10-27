import type { DatabaseSync } from 'node:sqlite';
export function migrateAssistant(db: DatabaseSync) {
  db.exec('SAVEPOINT assistant_schema');
  try {
    db.exec(`
CREATE TABLE IF NOT EXISTS assistant_threads(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,document TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assistant_messages(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES assistant_threads(id),role TEXT NOT NULL,text TEXT NOT NULL,document TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS assistant_messages_thread ON assistant_messages(thread_id,created_at);
CREATE TABLE IF NOT EXISTS assistant_runs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES assistant_threads(id),user_id TEXT NOT NULL,state TEXT NOT NULL,document TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assistant_previews(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES assistant_threads(id),user_id TEXT NOT NULL,session_binding TEXT NOT NULL,expires_at INTEGER NOT NULL,digest TEXT NOT NULL,document TEXT NOT NULL,result TEXT);
CREATE TABLE IF NOT EXISTS assistant_audit(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,thread_id TEXT,tool TEXT NOT NULL,state TEXT NOT NULL,document TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assistant_attachments(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES assistant_threads(id),user_id TEXT NOT NULL,upload_id TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,mime TEXT NOT NULL,kind TEXT NOT NULL,sha256 TEXT NOT NULL,metadata TEXT NOT NULL,bytes BLOB,extracted_text TEXT,image_pages TEXT,created_at TEXT NOT NULL,deleted_at TEXT,UNIQUE(user_id,upload_id));
CREATE INDEX IF NOT EXISTS assistant_attachments_owner ON assistant_attachments(user_id,thread_id);
CREATE TABLE IF NOT EXISTS assistant_message_attachments(message_id TEXT NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,attachment_id TEXT NOT NULL REFERENCES assistant_attachments(id),PRIMARY KEY(message_id,attachment_id));
INSERT OR IGNORE INTO schema_migrations VALUES(8,datetime('now'));`);
    db.exec("INSERT OR IGNORE INTO schema_migrations VALUES(10,datetime('now'))");
    if (
      !db
        .prepare('PRAGMA table_info(assistant_attachments)')
        .all()
        .some((c) => c.name === 'extracted_text')
    )
      db.exec('ALTER TABLE assistant_attachments ADD COLUMN extracted_text TEXT');
    if (
      !db
        .prepare('PRAGMA table_info(assistant_attachments)')
        .all()
        .some((c) => c.name === 'image_pages')
    )
      db.exec('ALTER TABLE assistant_attachments ADD COLUMN image_pages TEXT');
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('全局助手迁移关联校验失败');
    db.exec('RELEASE assistant_schema');
  } catch (e) {
    db.exec('ROLLBACK TO assistant_schema; RELEASE assistant_schema');
    throw e;
  }
}
