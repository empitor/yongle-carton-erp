-- AI 识别工作区第 3 版（基线）的结构快照：在一个全新的空文件上整份执行，建出来的就是这一版的库。
-- 用途：tests/config-db-evolution.test.ts 拿它当“从基线一路升级上来”的起点，核对升级上来的库和程序新建的库结构完全一样；
-- tests/upgrade-step-samples.test.ts 从它开始跑每一步的数据样例。
-- 怎么生成：npm run schema:dump（scripts/config-db-dump.ts，在内存里按规格的 create 建空库再导出）。
-- 定下以后不许改：要改结构在规格的 steps 里加升级步骤（规矩见 server/core/versioned-sqlite-spec.ts 开头）。

BEGIN;
CREATE TABLE workspaces(id TEXT PRIMARY KEY,file_hash TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL);
CREATE INDEX workspaces_hash ON workspaces(file_hash);
CREATE TABLE recognition_failures(id TEXT PRIMARY KEY,workspace_id TEXT,recorded_at TEXT NOT NULL,legacy_key TEXT UNIQUE,document TEXT NOT NULL);
CREATE INDEX recognition_failure_workspace ON recognition_failures(workspace_id,recorded_at);
PRAGMA user_version=3;
COMMIT;
