-- 助手工具设置库第 2 版（基线）的结构快照：在一个全新的空文件上整份执行，建出来的就是这一版的库。
-- 用途：tests/config-db-evolution.test.ts 拿它当“从基线一路升级上来”的起点，核对升级上来的库和程序新建的库结构完全一样；
-- tests/upgrade-step-samples.test.ts 从它开始跑每一步的数据样例。
-- 怎么生成：npm run schema:dump（scripts/config-db-dump.ts，在内存里按规格的 create 建空库再导出）。
-- 定下以后不许改：要改结构在规格的 steps 里加升级步骤（规矩见 server/core/versioned-sqlite-spec.ts 开头）。

BEGIN;
CREATE TABLE tool_settings(name TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE tool_settings_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
CREATE TABLE assistant_account_settings(
        user_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, name)
      ) STRICT;
CREATE TABLE assistant_memories(
        id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, content TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('assistant','manual')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0
      ) STRICT;
CREATE INDEX assistant_memories_user ON assistant_memories(user_id, updated_at);
PRAGMA user_version=2;
COMMIT;
