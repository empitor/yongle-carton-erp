-- 出错记录库第 1 版（基线）的结构快照：在一个全新的空文件上整份执行，建出来的就是这一版的库。
-- 用途：tests/config-db-evolution.test.ts 拿它当“从基线一路升级上来”的起点，核对升级上来的库和程序新建的库结构完全一样；
-- tests/upgrade-step-samples.test.ts 从它开始跑每一步的数据样例。
-- 怎么生成：npm run schema:dump（scripts/config-db-dump.ts，在内存里按规格的 create 建空库再导出）。
-- 定下以后不许改：要改结构在规格的 steps 里加升级步骤（规矩见 server/core/versioned-sqlite-spec.ts 开头）。

BEGIN;
CREATE TABLE recent_problems(
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('server','page')),
        account TEXT,
        method TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL DEFAULT '',
        operation TEXT NOT NULL,
        category TEXT NOT NULL,
        status INTEGER NOT NULL,
        message TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        stack TEXT NOT NULL DEFAULT '',
        page TEXT NOT NULL DEFAULT '');
CREATE INDEX recent_problems_at ON recent_problems(at);
PRAGMA user_version=1;
COMMIT;
