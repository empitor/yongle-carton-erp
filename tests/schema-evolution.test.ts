// 第 20 版结构快照（tests/fixtures/schema-v20.sql，由 npm run schema:dump 导出）是“从第 20 版升级上来”的起点：
// 快照没被改过、能直接执行、和重新导出的逐字节相同、从它升级上来的库和程序新建的库一样。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/core/index.js';
import {
  SCHEMA_APPLICATION_ID,
  SCHEMA_BASELINE,
  SCHEMA_LATEST,
  describeSchema,
  inspectSchema,
  upgradeSchema,
  upgradeSteps,
} from '../server/core/schema/index.js';
import { SNAPSHOT_PLACEHOLDERS, dumpSchemaSnapshot } from '../scripts/schema-dump.js';
import { ROWS_DIRECTORY, rowSchemaFiles } from '../scripts/schema-rows.js';
import { counters, one, rowsOf, workspace } from './schema-fixture.js';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const snapshotFile = join(projectRoot, 'tests/fixtures/schema-v20.sql');
/**
 * 快照文件的 sha256。先把 CRLF 统一成 LF 再算，不受检出时换行转换的影响；
 * 仓库的 .gitattributes 也把这个文件标成 eol=lf，检出来始终是 LF（下面“重新导出逐字节相同”那条要靠它）。
 */
const SNAPSHOT_SHA256 = 'a559e52ff4232c1bad2bac2b2b26c804a8d46bb365af614b4529923385635310';
/** 快照里版本记录的两列是固定占位值（scripts/schema-dump.ts），describeSchema 本来就不比这两列 */
const snapshotHelp =
  '发布前改了结构：运行 npm run schema:dump 重新导出，并把 tests/schema-evolution.test.ts 里的 sha256 换成新的；' +
  '0.9.0 发布后这份文件不许改，要改结构请在 server/core/schema/steps.ts 加升级步骤';
/** 有了升级步骤以后，程序新建的库不再是第 20 版，快照和它直接比、重新导出这两条就不适用了，由“从快照升级”那条接着守 */
const afterSteps =
  upgradeSteps.length > 0 &&
  `已经有升级步骤：程序新建的是第 ${SCHEMA_LATEST} 版，第 ${SCHEMA_BASELINE} 版快照不再和它直接比，改由“从第 ${SCHEMA_BASELINE} 版快照升级”那条测试核对`;

/** 在一个全新的文件库上整份执行快照，返回打开的连接 */
function snapshotDatabase(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(readFileSync(snapshotFile, 'utf8'));
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
/** 程序新建的文件库（和正式新建业务库同一条路）：读出结构、自增序号和版本记录就关掉 */
function freshDatabase(path: string) {
  const store = new Store(path);
  try {
    return {
      description: describeSchema(store.db),
      sequence: rowsOf(store.db, 'sqlite_sequence'),
      migrations: rowsOf(store.db, 'schema_migrations'),
    };
  } finally {
    store.close();
  }
}

/**
 * 升级步骤里改了名或删掉的自增表：'旧表名' → { renamedTo: '新表名' } 或 { dropped: '理由' }。
 * 改名的，步骤要自己把旧名的计数写到新名上（执行器认不出新表就是旧表，见 steps.ts 的规矩）。现在没有。
 */
const autoIncrementTableChanges: Record<string, { renamedTo: string } | { dropped: string }> = {};
/** 用 AUTOINCREMENT 的表 */
const autoIncrementTables = (db: DatabaseSync) =>
  db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND sql LIKE '%AUTOINCREMENT%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
function setCounter(db: DatabaseSync, table: string, seq: number) {
  if (!db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(seq, table).changes)
    db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(table, seq);
}

test('第 20 版结构快照文件没被改过：sha256 和登记的一致', () => {
  const text = readFileSync(snapshotFile, 'utf8').replaceAll('\r\n', '\n');
  assert.equal(createHash('sha256').update(text).digest('hex'), SNAPSHOT_SHA256, 'tests/fixtures/schema-v20.sql 变了。' + snapshotHelp);
});

test('第 20 版结构快照能直接执行：建出来的库和程序新建的库完全一样（文件设置、表、索引、触发器、视图、预置数据、版本、自增序号）', { skip: afterSteps }, () => {
  const w = workspace('erp-schema-v20-');
  try {
    // 两边都是文件库，auto_vacuum 才比得出来
    const fresh = freshDatabase(join(w.dir, 'fresh.sqlite'));
    const db = snapshotDatabase(w.path);
    try {
      const snapshot = describeSchema(db);
      assert.deepEqual(snapshot, fresh.description, '快照建出来的库和程序新建的库不一样。' + snapshotHelp);
      assert.equal(snapshot.applicationId, SCHEMA_APPLICATION_ID);
      assert.equal(snapshot.autoVacuum, 2, 'auto_vacuum=INCREMENTAL 要在建第一张表之前设');
      assert.deepEqual(snapshot.versions, [SCHEMA_BASELINE]);
      assert.deepEqual(rowsOf(db, 'sqlite_sequence'), fresh.sequence, '自增序号也一样');
      assert.deepEqual(
        rowsOf(db, 'schema_migrations'),
        fresh.migrations.map((row) => ({ ...row, ...SNAPSHOT_PLACEHOLDERS })),
        '版本记录除了时间和程序版本（快照里是固定占位值）都一样',
      );
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(db.prepare('PRAGMA quick_check').all().map((row) => ({ ...row })), [{ quick_check: 'ok' }]);
      assert.equal(db.isTransaction, false, '快照自己提交了事务');
    } finally {
      db.close();
    }
  } finally {
    w.close();
  }
});

test('现在重新导出一次，和仓库里的快照逐字节相同：改了建表却没重新导出会被拦下', { skip: afterSteps }, () => {
  // 和 npm run schema:dump 同一个导出函数
  const dumped = Buffer.from(dumpSchemaSnapshot());
  const stored = readFileSync(snapshotFile);
  if (dumped.equals(stored)) return;
  const a = dumped.toString('utf8').split('\n');
  const b = stored.toString('utf8').split('\n');
  const line = a.findIndex((text, index) => text !== b[index]);
  const at = line < 0 ? b.length : line;
  assert.fail(
    `重新导出的内容和 tests/fixtures/schema-v20.sql 不一样（第 ${at + 1} 行起）：\n  重新导出：${a[at] ?? '（没有这一行）'}\n  仓库里的：${b[at] ?? '（没有这一行）'}\n${snapshotHelp}`,
  );
});

test('重新生成的行结构和仓库里的一致：改了建表（业务库或配置库）却没重新生成 server/core/schema/rows 会被拦下', () => {
  // 和 npm run schema:dump 同一个生成函数；仓库里的先把 CRLF 统一成 LF，不受检出时换行转换的影响
  for (const file of rowSchemaFiles()) {
    const stored = readFileSync(join(ROWS_DIRECTORY, file.path), 'utf8').replaceAll('\r\n', '\n');
    if (stored === file.text) continue;
    const a = file.text.split('\n');
    const b = stored.split('\n');
    const at = a.findIndex((text, index) => text !== b[index]);
    const line = at < 0 ? b.length : at;
    assert.fail(
      `server/core/schema/${file.path} 和建表对不上（第 ${line + 1} 行起）：\n  重新生成：${a[line] ?? '（没有这一行）'}\n  仓库里的：${b[line] ?? '（没有这一行）'}\n` +
        '改了建表要运行 npm run schema:dump 重新生成行结构',
    );
  }
});

/**
 * 升级前后各张自增表“用过的最大编号”对比（remaining 是升级后还在的自增表）：
 * 编号回头了的、表不见了却没在 autoIncrementTableChanges 登记的、登记了改名或删除可表还在的，各一句
 */
function countersWentBack(before: Map<string, number>, after: Map<string, number>, remaining: Set<string>) {
  const wentBack: string[] = [];
  for (const [table, seq] of before) {
    const change = autoIncrementTableChanges[table];
    const now = remaining.has(table) ? table : change && 'renamedTo' in change ? change.renamedTo : undefined;
    if (change && remaining.has(table)) wentBack.push(`${table}：登记了改名或删除，可表还在`);
    else if (now === undefined) {
      if (!change) wentBack.push(`${table}：升级以后不见了，改名或删除要在 autoIncrementTableChanges 登记`);
    } else if ((after.get(now) ?? 0) < seq) wentBack.push(`${table}${now === table ? '' : ' → ' + now}：${seq} 变成了 ${after.get(now) ?? '没有计数'}`);
  }
  return wentBack;
}

test('从第 20 版快照升级到当前版本：不报错、外键校验为空，结构和程序新建的库完全一样（以后加了升级步骤这条照样成立）', () => {
  const w = workspace('erp-schema-from-v20-');
  try {
    const fresh = freshDatabase(join(w.dir, 'fresh.sqlite'));
    const db = snapshotDatabase(w.path);
    try {
      db.exec('PRAGMA foreign_keys=ON');
      const before = describeSchema(db);
      assert.deepEqual(before.versions, [SCHEMA_BASELINE]);
      assert.deepEqual(
        inspectSchema(db),
        upgradeSteps.length
          ? { kind: 'upgrade', from: SCHEMA_BASELINE, to: SCHEMA_LATEST }
          : { kind: 'current', version: SCHEMA_BASELINE },
      );
      // 每张自增表都当作已经用过一批编号（各不相同），升级以后计数不能回头
      const autoTables = autoIncrementTables(db);
      assert.ok(autoTables.length > 10, '找到了自增表');
      autoTables.forEach((table, index) => setCounter(db, table, 1000 + index));
      const countersBefore = counters(db);
      assert.deepEqual(upgradeSchema(db, { appVersion: 'test-9.9.9' }), { from: SCHEMA_BASELINE, to: SCHEMA_LATEST });
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(one(db, 'foreign_keys'), 1, '升级完外键检查恢复打开');
      const wentBack = countersWentBack(countersBefore, counters(db), new Set(autoIncrementTables(db)));
      assert.deepEqual(wentBack, [], '自增表“用过的最大编号”不能回头，否则删掉的编号会被重新分出去');
      const after = describeSchema(db);
      assert.deepEqual(after, fresh.description, '从第 20 版升级上来的库和程序新建的库结构不一样：steps.ts 的升级步骤和 tables/ 的建表没对上');
      if (!upgradeSteps.length) assert.deepEqual(after, before, '没有升级步骤时结构不变');
      // 已经是最新：再走一遍什么都不做
      assert.deepEqual(upgradeSchema(db, { appVersion: 'test-9.9.9' }), { from: SCHEMA_LATEST, to: SCHEMA_LATEST });
      assert.deepEqual(describeSchema(db), after);
    } finally {
      db.close();
    }
  } finally {
    w.close();
  }
});
