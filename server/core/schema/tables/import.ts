/**
 * 识别导入：订单导入的执行记录、收件箱。
 * 这里只有当前完整结构的建表、建索引语句，没有业务代码。改结构的规矩见 ../steps.ts。
 */
import { isSha256 } from './checks.js';

export const importTables = `
-- 订单导入的执行记录（来源和幂等）；seq 是登记先后，同一原件按它找最近一次。不存预览；
-- 同一工作区、同一人、同一摘要再交返回原回执；同一原件只能有一条挂着订单；
-- order_id 删订单时置空（全库唯一的跨模块级联）
CREATE TABLE import_executions(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL UNIQUE,
  file_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE INDEX import_fingerprint_lookup ON import_executions(fingerprint);
CREATE INDEX import_hash_lookup ON import_executions(file_hash);
CREATE UNIQUE INDEX import_live_file_unique ON import_executions(file_hash) WHERE order_id IS NOT NULL;
CREATE INDEX import_order_lookup ON import_executions(order_id);

-- 收件箱条目。附件的四列（文件名、类型、大小、摘要）要么都有要么都没有；处理人和处理时间一起记。
-- 状态和转成了什么（converted_kind）故意不联动：允许“已转单据但没记是哪种”这类组合。同来源同消息只一条。
-- pending、ignored 收到 180 天后由每日清理删掉，converted 留着
CREATE TABLE inbox_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL CHECK(channel IN ('manual','wecom_bot','feishu_bot','dingtalk_bot')),
  external_id TEXT NOT NULL,
  sender_id TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  conversation TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK(kind IN ('text','image','file','voice','video','other')),
  text TEXT NOT NULL DEFAULT '',
  file_name TEXT,
  file_mime TEXT,
  file_size INTEGER CHECK(file_size IS NULL OR file_size>=0),
  file_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','converted','ignored')),
  converted_kind TEXT CHECK(converted_kind IS NULL OR converted_kind IN ('order','arrival')),
  converted_ref TEXT,
  handled_by TEXT,
  handled_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(channel,external_id),
  CHECK((file_sha256 IS NULL)=(file_name IS NULL) AND (file_sha256 IS NULL)=(file_mime IS NULL) AND (file_sha256 IS NULL)=(file_size IS NULL)),
  CHECK((handled_by IS NULL)=(handled_at IS NULL))
) STRICT;
CREATE INDEX inbox_status_received ON inbox_items(status,received_at);

-- 收件箱附件，按 SHA-256 存一份
CREATE TABLE inbox_files(
  sha256 TEXT PRIMARY KEY CHECK(${isSha256('sha256')}),
  size INTEGER NOT NULL CHECK(size>=0),
  content BLOB NOT NULL,
  CHECK(length(content)=size)
) STRICT;
`;
