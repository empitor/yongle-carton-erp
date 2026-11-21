-- 账号库第 1 版（基线）的结构快照：在一个全新的空文件上整份执行，建出来的就是这一版的库。
-- 用途：tests/config-db-evolution.test.ts 拿它当“从基线一路升级上来”的起点，核对升级上来的库和程序新建的库结构完全一样；
-- tests/upgrade-step-samples.test.ts 从它开始跑每一步的数据样例。
-- 怎么生成：npm run schema:dump（scripts/config-db-dump.ts，在内存里按规格的 create 建空库再导出）。
-- 定下以后不许改：要改结构在规格的 steps 里加升级步骤（规矩见 server/core/versioned-sqlite-spec.ts 开头）。

BEGIN;
CREATE TABLE users(
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        permissions TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin','super_admin')),
        disabled_at TEXT,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        temp_password_expires INTEGER);
CREATE TABLE auth_events(id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor_id TEXT,action TEXT NOT NULL);
CREATE TABLE account_requests(
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('register','reset')),
        name TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        salt TEXT,
        password_hash TEXT,
        client TEXT NOT NULL,
        created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX account_requests_reset ON account_requests(name) WHERE kind='reset';
CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expires ON auth_sessions(expires);
PRAGMA user_version=1;
COMMIT;
