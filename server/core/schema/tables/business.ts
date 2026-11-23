/**
 * 业务总览：产品唛头和唛头原文件。
 * 这里只有当前完整结构的建表、建索引语句，没有业务代码。改结构的规矩见 ../steps.ts。
 */
import { isSha256 } from './checks.js';

export const businessTables = `
-- 唛头原文件；sha256 是 content 的摘要，size 是 content 的字节数
CREATE TABLE mark_files(
  sha256 TEXT PRIMARY KEY CHECK(${isSha256('sha256')}),
  size INTEGER NOT NULL CHECK(size>0),
  mime TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content BLOB NOT NULL,
  CHECK(length(content)=size)
) STRICT;

-- 产品唛头
CREATE TABLE product_marks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  file_sha256 TEXT NOT NULL REFERENCES mark_files(sha256),
  page INTEGER NOT NULL DEFAULT 0 CHECK(page>=0),
  title TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL CHECK(source_kind IN ('manual','assistant')),
  source_ref TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(product_id,file_sha256,page)
) STRICT;
CREATE INDEX product_marks_file ON product_marks(file_sha256);
`;
