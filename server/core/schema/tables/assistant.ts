/**
 * 助手：对话、消息、运行记录、待确认的操作、审计、附件。
 * 这里只有当前完整结构的建表、建索引语句，没有业务代码。改结构的规矩见 ../steps.ts。
 */
import { isJsonObject, isSha256 } from './checks.js';

export const assistantTables = `
-- 对话（会话，按账号）。document 存搜索返回过的网址 webUrls、本会话的识别任务 orderWorkflow
CREATE TABLE assistant_threads(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(${isJsonObject('document')})
) STRICT;

-- 消息；seq 是先后顺序（自增、不复用），排序、截取、清空都按它。document 的字段：
--
-- - turn：一轮的原样记录（messages、cards、files），存在那一轮的用户消息上，页面不给；压缩过的那一轮另有 restart，更早的行就没有 turn。
-- - facts：这一轮服务器实际做了什么。interim：回答前先说的话，存全文。sources：搜到和读过的网页，最多 30 条，只收 http/https。
-- - hidden：确认或拒绝卡片后的“接着办”，是一条不显示的用户消息。
CREATE TABLE assistant_messages(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE INDEX assistant_messages_thread ON assistant_messages(thread_id);

-- 每一轮的运行记录；state 只有 running、completed、failed
CREATE TABLE assistant_runs(
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id),
  user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','completed','failed')),
  created_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE INDEX assistant_runs_thread ON assistant_runs(thread_id);

-- 待确认的操作（确认卡片），绑定账号和会话；expires_at 是毫秒时间戳，点“不执行”或作废时写 0。
-- result 是执行结果；document.started、failed 有一样就不再执行
CREATE TABLE assistant_previews(
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id),
  user_id TEXT NOT NULL,
  session_binding TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>=0),
  digest TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document)),
  result TEXT CHECK(result IS NULL OR json_valid(result))
) STRICT;
CREATE INDEX assistant_previews_thread ON assistant_previews(thread_id);

-- 助手工具调用审计（只追加）。tool 是工具名（含插件）、state 含诊断阶段，都跟着功能增加，不列枚举，只要求不为空。
-- 压缩记 assistant.compaction（pruned、done、failed）；要删的 DeepSeek 文件记 attachments.remote（pending，删成后 deleted）
CREATE TABLE assistant_audit(
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  thread_id TEXT,
  tool TEXT NOT NULL CHECK(length(tool)>0),
  state TEXT NOT NULL CHECK(length(state)>0),
  created_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE INDEX assistant_audit_tool ON assistant_audit(user_id,tool);

-- 聊天附件；seq 是上传先后（自增、不复用），清空附件按它截止；字节（bytes）放最后，删除时清空
CREATE TABLE assistant_attachments(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id),
  user_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size>0),
  mime TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('image','pdf','office','text')),
  sha256 TEXT NOT NULL CHECK(${isSha256('sha256')}),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  metadata TEXT NOT NULL CHECK(json_valid(metadata)),
  bytes BLOB,
  UNIQUE(user_id,upload_id)
) STRICT;
CREATE INDEX assistant_attachments_owner ON assistant_attachments(user_id,thread_id);
CREATE INDEX assistant_attachments_thread ON assistant_attachments(thread_id);

-- 消息带了哪些附件；删消息时跟着删
CREATE TABLE assistant_message_attachments(
  message_id TEXT NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES assistant_attachments(id),
  PRIMARY KEY(message_id,attachment_id)
) STRICT;
CREATE INDEX assistant_message_attachments_attachment ON assistant_message_attachments(attachment_id);
`;
