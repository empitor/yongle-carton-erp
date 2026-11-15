/**
 * 单据导出：导出记录（文件内容和交付状态）、单据模板设置。
 * 这里只有当前完整结构的建表、建索引语句，没有业务代码。改结构的规矩见 ../steps.ts。
 */
import { isDateOrNull } from './checks.js';

export const documentsTables = `
-- 单据导出记录：一次导出一行，文件内容和交付状态都在这里。
-- record_id 按 record_kind 指采购单或送货单，故意不加外键：单据删了，导出记录照旧留着。
-- bytes 过了保存期清成 NULL，行、摘要、模板快照都留着。
CREATE TABLE document_exports(
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('purchase','delivery')),
  record_id INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('docx','xlsx')),
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  size INTEGER NOT NULL CHECK(size>=0),
  template_id TEXT NOT NULL,
  template_revision INTEGER NOT NULL,
  batch_number TEXT,
  ship_date TEXT CHECK(${isDateOrNull('ship_date')}),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  completed_at TEXT,
  options TEXT NOT NULL CHECK(json_valid(options)),
  template_snapshot TEXT NOT NULL CHECK(json_valid(template_snapshot)),
  bytes BLOB,
  CHECK(completed_at IS NULL OR delivered_at IS NOT NULL),
  CHECK(bytes IS NULL OR length(bytes)=size)
) STRICT;
CREATE INDEX document_exports_record ON document_exports(record_kind,record_id);
CREATE UNIQUE INDEX document_exports_batch_number ON document_exports(batch_number) WHERE batch_number IS NOT NULL;
CREATE INDEX document_exports_created ON document_exports(created_at);

-- 单据模板设置：只有一行；没有这一行就是出厂默认。初始化不清
CREATE TABLE document_template_settings(
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL CHECK(revision>=1),
  updated_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
`;
