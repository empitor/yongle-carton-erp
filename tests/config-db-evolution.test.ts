// 配置库的结构守卫：每个登记的配置库都有短名和基线快照（tests/fixtures/config-db/，由 npm run schema:dump 导出，定下不许改），
// 基线到当前的步骤一版不缺；从基线快照一路升级上来的库和程序新建的库结构完全一样（步骤和 create 对得上）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { describeSchema } from '../server/core/schema/index.js';
import { openVersionedSqlite } from '../server/core/versioned-sqlite.js';
import { checkedSteps, latestOf, type VersionedSqliteSpec } from '../server/core/versioned-sqlite-spec.js';
import { CONFIG_BASELINE_DIRECTORY, configDatabases, configDbKeys, dumpConfigBaseline } from '../scripts/config-db-dump.js';
import { configWorkspace, notesBaseline, notesSpec, quietLog, runSql, snapshotNames, userVersion } from './config-db-fixture.js';

/**
 * 每份基线快照的 sha256（先把 CRLF 统一成 LF 再算，不受检出时换行转换的影响）。快照定下以后不许改：
 * 改了建表却没加升级步骤，重新导出时快照会变，这里就拦下；新加配置库时导出它的快照，把 sha256 登记在这里。
 */
const BASELINE_SHA256: Readonly<Record<string, string>> = {
  'accounts-v1.sql': 'c7e2be687c775ebd2e3cad814683c49ab9a474cadea1fcdcc789575211d56a45',
  'ai-settings-v2.sql': '0f58d5bfcb6eb644c6348257473cf75c39f6f7fb10d9502f56297190317e2c1a',
  'assistant-tools-v2.sql': '3c0e90bf41f9029ea0f359206852b5a9c51f0f2777d0f1b50b614deacec2b40e',
  'bots-v1.sql': 'ca725c870725cfb0f2c364405f8718484f7bdbd78754eb0f8dc2d97ca9aae6d6',
  'import-workspaces-v3.sql': 'ca7a615ec39894422c047df1b5bdc695ef7039ed0ef689e68d532f6587f5825a',
  'problem-log-v1.sql': 'f8256b517b6e3901c44bea8154d81f3733d0ff14c998d9789ab04d8b730a696c',
  'prompts-v2.sql': '7a230aa70db3df3109afd787fe1f102209aea20fa449a1bdf43035b75a5f8d6b',
};
const HELP =
  '基线快照定下以后不许改：要改结构请在规格的 steps 里加升级步骤（规矩见 server/core/versioned-sqlite-spec.ts 开头）；' +
  '新加配置库：在 scripts/config-db-dump.ts 登记短名，运行 npm run schema:dump 导出快照，再把 sha256 登记在 tests/config-db-evolution.test.ts';
const stored = (file: string) => readFileSync(join(CONFIG_BASELINE_DIRECTORY, file), 'utf8').replaceAll('\r\n', '\n');

test('每个登记的配置库都有短名和基线快照，快照没被改过（sha256 和登记的一致），快照的版本就是规格的基线，步骤从基线起一版不缺', () => {
  const databases = configDatabases();
  assert.deepEqual(
    databases.map((d) => d.spec.label).sort(),
    Object.keys(configDbKeys).sort(),
    'scripts/config-db-dump.ts 的 configDbKeys 和登记的配置库要一一对上',
  );
  assert.deepEqual(databases.map((d) => d.file).sort(), Object.keys(BASELINE_SHA256).sort(), '每个配置库登记一份基线快照的 sha256。' + HELP);
  for (const { spec, file } of databases) {
    assert.doesNotThrow(() => checkedSteps(spec), spec.label);
    const text = stored(file);
    assert.equal(createHash('sha256').update(text).digest('hex'), BASELINE_SHA256[file], `tests/fixtures/config-db/${file} 变了。${HELP}`);
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(text);
      assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), spec.baseline, file);
    } finally {
      db.close();
    }
  }
});

/** 按规格在内存里新建的库里有哪些表（含 SQLite 自己的 sqlite_sequence） */
function freshTables(spec: VersionedSqliteSpec) {
  const db = openVersionedSqlite(':memory:', spec);
  try {
    return db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .map((row) => String(row.name));
  } finally {
    db.close();
  }
}

test('配置库的表不用 AUTOINCREMENT（升级执行器不补自增计数）：新建的库没有 sqlite_sequence，基线快照里也没有', () => {
  for (const { spec, file } of configDatabases()) {
    assert.ok(!freshTables(spec).includes('sqlite_sequence'), `${spec.label}的建表用了 AUTOINCREMENT`);
    assert.doesNotMatch(stored(file), /AUTOINCREMENT/i, file);
  }
});

test('账号库的会话表还叫 auth_sessions：补丁回滚时旧程序靠这个表名清掉换下来的那份里的会话', () => {
  const accounts = configDatabases().find((d) => d.key === 'accounts');
  assert.ok(accounts);
  assert.ok(
    freshTables(accounts.spec).includes('auth_sessions'),
    '会话表的表名和“删光就是清空会话”的做法不许改（server/core/versioned-sqlite-spec.ts 开头）',
  );
});

test('还没有升级步骤的配置库：现在重新导出的基线快照和仓库里的逐字节相同（统一成 LF 比）', () => {
  for (const { spec, file } of configDatabases().filter((d) => !d.spec.steps.length))
    assert.equal(dumpConfigBaseline(spec), stored(file), `tests/fixtures/config-db/${file} 和建表对不上。${HELP}`);
});

/** 基线快照写进临时文件，按规格打开（有步骤就真升级、真备份），另一个临时文件按规格新建：两边的结构，和升上来的版本 */
function upgradedAndFresh(spec: VersionedSqliteSpec, baseline: string) {
  const w = configWorkspace();
  try {
    const fresh = join(w.dir, 'fresh.sqlite');
    runSql(w.file, baseline);
    openVersionedSqlite(w.file, spec).close();
    openVersionedSqlite(fresh, spec).close();
    const schema = (file: string) => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return describeSchema(db);
      } finally {
        db.close();
      }
    };
    return {
      upgraded: schema(w.file),
      fresh: schema(fresh),
      version: userVersion(w.file),
      backups: snapshotNames(w.file).length,
    };
  } finally {
    w.done();
  }
}

test('从基线快照一路升级上来的配置库和程序新建的结构完全一样（以后加了升级步骤这条照样成立）', (t) => {
  quietLog(t);
  for (const { spec, file } of configDatabases()) {
    const result = upgradedAndFresh(spec, stored(file));
    assert.deepEqual(result.upgraded, result.fresh, `${spec.label}：从基线升上来的和新建的结构不一样，steps 和 create 没对上`);
    assert.equal(result.version, latestOf(spec), spec.label);
    assert.equal(result.backups, spec.steps.length ? 1 : 0, spec.label + '：有步骤才升级、才留备份');
  }
});

test('结构守卫真的会拦：步骤加的列 create 里没有，从基线升上来的和新建的对不上', (t) => {
  quietLog(t);
  const matched = upgradedAndFresh(notesSpec(), notesBaseline);
  assert.deepEqual(matched.upgraded, matched.fresh);
  assert.equal(matched.backups, 1);
  // 第 3 步建了 tags 表，create 却忘了建
  const forgot = notesSpec({ create: (db) => db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0)') });
  const result = upgradedAndFresh(forgot, notesBaseline);
  assert.notDeepEqual(result.upgraded, result.fresh);
});
