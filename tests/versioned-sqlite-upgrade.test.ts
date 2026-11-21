// 配置库基线到当前之间的升级（server/core/versioned-sqlite.ts）：留备份后一步步升级、数据留着；
// 中途出错整个退回、文件不变、不删库；规格写错打开前就报错；比基线旧的照旧删掉重建；拿不到写锁就拒绝。只用造出来的步骤和虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { SNAPSHOT_DIRECTORY } from '../server/core/schema/index.js';
import { openVersionedSqlite } from '../server/core/versioned-sqlite.js';
import { VersionedSqliteError, type VersionedSqliteSpec } from '../server/core/versioned-sqlite-spec.js';
import {
  configWorkspace,
  noteSteps,
  notesSpec,
  notesV1,
  quietLog,
  runSql,
  sha256,
  snapshotDir,
  snapshotNames,
  tableRows,
  userVersion,
} from './config-db-fixture.js';

const refused = (file: string, spec: VersionedSqliteSpec) => {
  try {
    openVersionedSqlite(file, spec).close();
  } catch (error) {
    assert.ok(error instanceof VersionedSqliteError, '拒绝时抛的是给人看的中文提示：' + String(error));
    return error.message;
  }
  assert.fail('应当拒绝打开');
};
const failingStep = (version: number) => ({
  version,
  name: '虚构：会失败的一步',
  up: () => {
    throw new Error('虚构的升级失败');
  },
});

test('基线到当前之间：先留升级前备份，再一步步升到当前版本，数据留着、回填对；再打开原样打开，不再备份', (t) => {
  const log = quietLog(t);
  const f = configWorkspace();
  try {
    notesV1(f.file);
    openVersionedSqlite(f.file, notesSpec()).close();
    assert.equal(userVersion(f.file), 3);
    assert.deepEqual(tableRows(f.file, 'notes'), [
      { id: 1, body: '置顶：虚构便签', pinned: 1 },
      { id: 2, body: '虚构普通便签', pinned: 0 },
    ]);
    assert.deepEqual(tableRows(f.file, 'tags'), []);
    const [backup] = snapshotNames(f.file);
    assert.match(backup, /^notes-upgrade-v1-to-v3-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[\da-f]{6}\.sqlite$/);
    assert.deepEqual(snapshotNames(f.file), [backup], '只有这一份，没有留下 .partial');
    assert.equal(log.mock.callCount(), 1);
    assert.match(String(log.mock.calls[0].arguments[0]), /^虚构便签库已从第 1 版升级到第 3 版，升级前备份：.*notes-upgrade-v1-to-v3-/);
    const db = openVersionedSqlite(f.file, notesSpec({ create: () => assert.fail('当前版本不重建') }));
    db.close();
    assert.equal(snapshotNames(f.file).length, 1, '已是当前版本：不再升级，也不多做备份');
  } finally {
    f.done();
  }
});

test('从基线和当前之间的某一版开始：只跑后面的步骤', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    notesV1(f.file);
    const v2 = new DatabaseSync(f.file);
    noteSteps[0].up(v2);
    v2.exec("PRAGMA user_version=2; UPDATE notes SET pinned=0 WHERE id=1; INSERT INTO notes(id,body,pinned) VALUES(3,'第 2 版写的',1)");
    v2.close();
    openVersionedSqlite(f.file, notesSpec()).close();
    assert.equal(userVersion(f.file), 3);
    assert.deepEqual(
      tableRows(f.file, 'notes').map((row) => row.pinned),
      [0, 0, 1],
      '第 2 步没有重跑：第 2 版里改过的置顶保持原样',
    );
    assert.match(snapshotNames(f.file)[0], /^notes-upgrade-v2-to-v3-/);
  } finally {
    f.done();
  }
});

test('升级中途出错：整个退回，文件逐字节不变、不删库，提示写明库名、第几步、原因和备份位置；修好后照常升级', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    notesV1(f.file);
    const before = sha256(f.file);
    const message = refused(f.file, notesSpec({ steps: [noteSteps[0], failingStep(3)] }));
    assert.match(message, /^虚构便签库从第 1 版升级到第 3 版失败（第 3 步“虚构：会失败的一步”：虚构的升级失败），已整体退回。/);
    assert.ok(message.includes('文件：' + f.file + '\n文件没有任何改动。'), message);
    assert.match(message, /请换回旧版本的程序继续使用/);
    const backup = join(snapshotDir(f.file), snapshotNames(f.file)[0]);
    assert.ok(message.includes('升级前备份：' + backup), message);
    assert.equal(sha256(f.file), before, '第 2 步已经跑过也一起退回');
    assert.equal(userVersion(backup), 1, '备份留着，是升级前的版本');
    assert.deepEqual(readdirSync(f.dir).sort(), ['notes.sqlite', SNAPSHOT_DIRECTORY], '没有留下日志文件');
    // 修好以后同一个文件照常升级，数据都在
    openVersionedSqlite(f.file, notesSpec()).close();
    assert.equal(userVersion(f.file), 3);
    assert.equal(tableRows(f.file, 'notes').length, 2);
  } finally {
    f.done();
  }
});

test('升级后数据关联校验不过：整个退回，文件不变', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    notesV1(f.file);
    const before = sha256(f.file);
    const dangling = {
      ...noteSteps[1],
      up: (db: DatabaseSync) => {
        noteSteps[1].up(db);
        db.exec("INSERT INTO tags(note_id,tag) VALUES(999,'指向不存在的便签')");
      },
    };
    const message = refused(f.file, notesSpec({ steps: [noteSteps[0], dangling] }));
    assert.match(message, /^虚构便签库从第 1 版升级到第 3 版失败（升级后数据关联校验没有通过），已整体退回。/);
    assert.equal(sha256(f.file), before);
  } finally {
    f.done();
  }
});

test('步骤都跑完了、提交时出错（这里是别的连接正读着库，提交拿不到锁）：整个退回，文件不变，提示写明库名和备份位置', (t) => {
  quietLog(t);
  const f = configWorkspace();
  const reader: { db?: DatabaseSync } = {};
  try {
    notesV1(f.file);
    const before = sha256(f.file);
    // 最后一步跑完时，另一个连接开始读这个库并一直不放，提交要的独占锁拿不到
    const startReading = {
      ...noteSteps[1],
      up: (db: DatabaseSync) => {
        noteSteps[1].up(db);
        reader.db = new DatabaseSync(f.file, { readOnly: true });
        reader.db.exec('BEGIN');
        reader.db.prepare('SELECT count(*) AS n FROM notes').get();
      },
    };
    const message = refused(f.file, notesSpec({ steps: [noteSteps[0], startReading], busyTimeout: 0 }));
    // 原因是 SQLite 提交时报的“库被锁住”
    assert.match(message, /^虚构便签库从第 1 版升级到第 3 版失败（文件正被别的程序占用：database is locked），已整体退回。/);
    assert.ok(message.includes('文件：' + f.file + '\n文件没有任何改动。'), message);
    assert.ok(message.includes('升级前备份：' + join(snapshotDir(f.file), snapshotNames(f.file)[0])), message);
    assert.equal(sha256(f.file), before);
  } finally {
    reader.db?.close();
    f.done();
  }
});

test('步骤自己提交了事务（规矩不许）：停在这一步、不接着做；升级前备份改名留下，以后打开都拒绝、不在半截的库上重跑；按提示移回以后照常升级', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    notesV1(f.file);
    const originalRows = tableRows(f.file, 'notes');
    let commitsRun = 0;
    const commits = {
      ...noteSteps[0],
      up: (db: DatabaseSync) => {
        commitsRun++;
        noteSteps[0].up(db);
        db.exec('COMMIT');
      },
    };
    let later = false;
    const next = {
      ...noteSteps[1],
      up: () => {
        later = true;
      },
    };
    const broken = notesSpec({ steps: [commits, next] });
    const message = refused(f.file, broken);
    assert.match(message, /^虚构便签库从第 1 版升级到第 3 版停在第 2 步“虚构：便签加置顶”：这一步自己结束了事务（提交或退回），升级没有做完。库现在是半截的/);
    const [kept] = snapshotNames(f.file);
    assert.match(kept, /^notes-before-unfinished-v1-to-v3-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[\da-f]{6}\.sqlite$/, '清理认不出的名字');
    const keptPath = join(snapshotDir(f.file), kept);
    assert.ok(message.includes('升级前备份：' + keptPath), message);
    assert.match(message, /处理办法：先停掉程序，把这份升级前备份移到上面“文件”的位置、覆盖现在这个半截的库/);
    assert.equal(later, false, '后面的步骤不再跑');
    assert.equal(userVersion(f.file), 1, '版本号还是旧的');
    assert.equal(userVersion(keptPath), 1, '留下的就是升级前的库');
    assert.deepEqual(tableRows(keptPath, 'notes'), originalRows);
    // 服务自动重启、再打开：拒绝，不在半截的库上重跑步骤，留下的备份还在，也没有多做备份
    const half = sha256(f.file);
    const again = refused(f.file, broken);
    assert.match(again, /^虚构便签库上次升级没有做完，库是半截的，不能打开，也不会在半截的库上接着升级。/);
    assert.ok(again.includes('文件：' + f.file + '\n文件没有任何改动。'), again);
    assert.ok(again.includes('升级前备份：' + keptPath), again);
    assert.equal(commitsRun, 1);
    assert.deepEqual(snapshotNames(f.file), [kept]);
    assert.equal(sha256(f.file), half);
    // 按提示把备份移回库文件的位置，换上修好的程序：照常升级，数据都在
    renameSync(keptPath, f.file);
    openVersionedSqlite(f.file, notesSpec()).close();
    assert.equal(userVersion(f.file), 3);
    assert.deepEqual(tableRows(f.file, 'notes').map((row) => row.pinned), [1, 0]);
  } finally {
    f.done();
  }
});

test('规格写错（基线不是正整数、步骤缺了或不连续）：打开任何文件之前就报错，文件不动', () => {
  const f = configWorkspace();
  try {
    notesV1(f.file);
    const before = sha256(f.file);
    const cases: [VersionedSqliteSpec, string][] = [
      [notesSpec({ steps: [noteSteps[1]] }), '虚构便签库的升级步骤必须从第 2 版起连续，第 1 步写的是第 3 版。'],
      [notesSpec({ steps: [noteSteps[0], noteSteps[0]] }), '虚构便签库的升级步骤必须从第 2 版起连续，第 2 步写的是第 2 版。'],
      [notesSpec({ baseline: 0, steps: [] }), '虚构便签库的基线版本必须是正整数。'],
    ];
    for (const [spec, expected] of cases) {
      assert.throws(
        () => openVersionedSqlite(f.file, spec),
        (error: Error) => !(error instanceof VersionedSqliteError) && error.message === expected,
      );
      assert.equal(sha256(f.file), before, expected);
    }
    assert.equal(existsSync(snapshotDir(f.file)), false);
  } finally {
    f.done();
  }
});

test('比基线旧的（基线比当前低时也一样）：照旧删掉重建，不做升级前备份', () => {
  // 基线第 2 版、当前第 3 版：第 1 版和没记版本却有表的是 0.9.0 以前留下的
  const spec = notesSpec({ baseline: 2, steps: [noteSteps[1]] });
  for (const sql of ['', ' PRAGMA user_version=0;']) {
    const f = configWorkspace();
    try {
      notesV1(f.file);
      if (sql) runSql(f.file, sql);
      openVersionedSqlite(f.file, spec).close();
      assert.equal(userVersion(f.file), 3);
      assert.deepEqual(tableRows(f.file, 'notes'), [], '旧内容不留');
      assert.equal(existsSync(snapshotDir(f.file)), false, '删掉重建的不做备份');
    } finally {
      f.done();
    }
  }
});

test('要升级时库被别的程序占着写锁：拒绝打开，文件不变、不做备份；放开后照常升级', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    notesV1(f.file);
    const before = sha256(f.file);
    const holder = new DatabaseSync(f.file);
    try {
      holder.exec('BEGIN IMMEDIATE');
      const message = refused(f.file, notesSpec({ busyTimeout: 0 }));
      assert.match(message, /^虚构便签库不能打开：文件正被别的程序占用/);
      assert.match(message, /文件没有任何改动/);
      holder.exec('ROLLBACK');
    } finally {
      holder.close();
    }
    assert.equal(sha256(f.file), before);
    assert.deepEqual(snapshotNames(f.file), []);
    openVersionedSqlite(f.file, notesSpec({ busyTimeout: 0 })).close();
    assert.equal(userVersion(f.file), 3);
  } finally {
    f.done();
  }
});

test('两个连接先后打开同一个要升级的库：先到的升级，后到的看到已是当前版本，原样打开，不升两遍、不多做备份', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    notesV1(f.file);
    let runs = 0;
    const counted = notesSpec({
      steps: noteSteps.map((step) => ({
        ...step,
        up: (db: DatabaseSync) => {
          runs++;
          step.up(db);
        },
      })),
    });
    const first = openVersionedSqlite(f.file, counted);
    const second = openVersionedSqlite(f.file, counted);
    try {
      assert.equal(runs, 2, '两步各跑一次');
      assert.equal(snapshotNames(f.file).length, 1);
      assert.equal(second.prepare('SELECT count(*) AS n FROM notes').get()?.n, 2);
    } finally {
      first.close();
      second.close();
    }
  } finally {
    f.done();
  }
});
