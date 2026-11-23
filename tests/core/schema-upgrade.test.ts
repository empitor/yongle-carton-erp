// 业务库升级：待做的步骤在一个事务里执行、失败整体回滚、升级前快照、重建自增表编号不回头、步骤编号连续。
// 升级步骤都是虚构的：在第 20 版的库上从第 21 版编起（schema-fixture.ts），和程序真有几步无关。
import { sales } from '../../server/sales/index.js';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store, nextAutoId, SchemaError } from '../../server/core/index.js';
import {
  SCHEMA_BASELINE,
  SCHEMA_LATEST,
  describeSchema,
  inspectSchema,
  schemaFingerprint,
  openBusinessDatabase,
  snapshotBeforeUpgrade,
  upgradeSchema,
  upgradeSteps,
  type UpgradeStep,
} from '../../server/core/schema/index.js';
import { baselineDatabase, counters, failing, fictionalBuild, fictionalSteps, one, quiet, rowsOf, sha256, versions, workspace } from '../support/schema-fixture.js';

test('升级成功：待做的步骤在一个事务里按顺序执行，版本记录带名字和程序版本，数据保留，外键检查恢复打开', () => {
  const w = workspace('erp-schema-upgrade-');
  try {
    baselineDatabase(w.path);
    const db = new DatabaseSync(w.path);
    try {
      db.exec('PRAGMA foreign_keys=ON');
      const customers = rowsOf(db, 'customers');
      assert.deepEqual(inspectSchema(db, 23), { kind: 'upgrade', from: 20, to: 23 });
      assert.deepEqual(upgradeSchema(db, { appVersion: 'test-9.9.9', steps: fictionalSteps }), { from: 20, to: 23 });
      assert.deepEqual(versions(db), [20, 21, 22, 23]);
      assert.deepEqual(
        rowsOf(db, 'schema_migrations').filter((row) => Number(row.version) > 20).map(({ version, name, app_version }) => ({ version, name, app_version })),
        fictionalSteps.map((step) => ({ version: step.version, name: step.name, app_version: 'test-9.9.9' })),
      );
      assert.deepEqual(inspectSchema(db, 23), { kind: 'current', version: 23 });
      assert.deepEqual(
        rowsOf(db, 'customers'),
        customers.map((row) => ({ ...row, fictional_note: '没填' })),
      );
      assert.deepEqual(rowsOf(db, 'fictional_parents'), [{ id: 1, name: '虚构父行', level: 1 }]);
      assert.deepEqual(rowsOf(db, 'fictional_children'), [{ id: 1, parent_id: 1, note: '虚构子行' }]);
      assert.equal(one(db, 'foreign_keys'), 1);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.throws(() => db.exec("INSERT INTO fictional_children(id,parent_id,note) VALUES(2,99,'没有父行')"), /FOREIGN KEY/);
      // 已经是最新：什么都不做
      assert.deepEqual(upgradeSchema(db, { appVersion: 'test-9.9.9', steps: fictionalSteps }), { from: 23, to: 23 });
      assert.deepEqual(versions(db), [20, 21, 22, 23]);
    } finally {
      db.close();
    }
  } finally {
    w.close();
  }
});

test('升级失败整体回滚：前面成功的步骤一起退回，版本、结构、数据都不变；提交前的数据关联校验不过也退回', () => {
  const w = workspace('erp-schema-rollback-');
  try {
    baselineDatabase(w.path);
    const db = new DatabaseSync(w.path);
    try {
      db.exec('PRAGMA foreign_keys=ON');
      const before = { description: describeSchema(db), customers: rowsOf(db, 'customers'), records: rowsOf(db, 'schema_migrations') };
      const unchanged = () => {
        assert.deepEqual(describeSchema(db), before.description);
        assert.deepEqual(rowsOf(db, 'customers'), before.customers);
        assert.deepEqual(rowsOf(db, 'schema_migrations'), before.records);
        assert.equal(one(db, 'foreign_keys'), 1);
        assert.equal(db.isTransaction, false);
      };
      assert.throws(
        () => upgradeSchema(db, { appVersion: 'test-9.9.9', steps: [...fictionalSteps.slice(0, 2), failing(23, '虚构的第三步出错')] }),
        (error: Error) => {
          assert.ok(error instanceof SchemaError);
          assert.match(error.message, /^数据库从第 20 版升级到第 23 版失败，已整体退回，数据没有改动：虚构的第三步出错$/);
          return true;
        },
      );
      unchanged();
      const orphan: UpgradeStep = {
        version: 22,
        name: '虚构：写进一条没有父行的子行',
        up: (handle) => handle.exec("INSERT INTO fictional_children(id,parent_id,note) VALUES(9,404,'孤儿')"),
      };
      assert.throws(
        () => upgradeSchema(db, { appVersion: 'test-9.9.9', steps: [fictionalSteps[0], orphan] }),
        /第 20 版升级到第 22 版失败，已整体退回，数据没有改动：升级后数据关联校验失败/,
      );
      unchanged();
      // 步骤编号写错是程序问题：还没碰数据库就报错
      assert.throws(() => upgradeSchema(db, { appVersion: 'x', steps: [fictionalSteps[1]] }), /必须从第 21 版起连续/);
      assert.throws(() => upgradeSchema(db, { appVersion: 'x', steps: [fictionalSteps[0], fictionalSteps[2]] }), /必须从第 21 版起连续/);
      unchanged();
    } finally {
      db.close();
    }
    // 回滚以后当前程序照常打开
    const store = new Store(w.path);
    try {
      assert.equal(sales(store).customers()[0].name, '虚构升级客户');
    } finally {
      store.close();
    }
  } finally {
    w.close();
  }
});

test('打开旧一些的库：先拍升级前快照（含 WAL 里已提交的内容、版本是升级前的），再升级；升级失败时库不变、快照留着', () => {
  const w = workspace('erp-schema-open-');
  try {
    baselineDatabase(w.path);
    // 留一条还在 WAL 里、没有合并进主文件的提交
    const writer = new DatabaseSync(w.path);
    writer.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO customers(name,contact,phone,address,notes,created_at,updated_at) VALUES('还在 WAL 里的客户','','','','','2026-11-12T00:00:00Z','2026-11-12T00:00:00Z')");
    const names = rowsOf(writer, 'customers').map((row) => row.name);
    assert.equal(names.length, 2);
    const snapshots = () => (existsSync(join(w.dir, 'snapshots')) ? readdirSync(join(w.dir, 'snapshots')).sort() : []);
    const inspect = (file: string, use: (db: DatabaseSync) => void) => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        use(db);
      } finally {
        db.close();
      }
    };

    // 失败的升级：快照已经拍好，库保持第 20 版
    const beforeFailure = describeSchema(writer);
    const messages: string[] = [];
    assert.throws(
      () => openBusinessDatabase(w.path, { appVersion: 'test-9.9.9', steps: [fictionalSteps[0], failing(22, '虚构的升级失败')], log: (m) => messages.push(m) }),
      (error: Error) => error instanceof SchemaError && /第 20 版升级到第 22 版失败，已整体退回/.test(error.message),
    );
    assert.equal(snapshots().length, 1);
    assert.match(snapshots()[0], /^upgrade-v20-to-v22-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[\da-f]{6}\.sqlite$/);
    assert.equal(messages.length, 1);
    assert.equal(messages[0], '已生成升级前业务库快照：' + join(w.dir, 'snapshots', snapshots()[0]));
    inspect(join(w.dir, 'snapshots', snapshots()[0]), (db) => {
      assert.equal(one(db, 'quick_check'), 'ok');
      assert.deepEqual(versions(db), [20]);
      assert.deepEqual(rowsOf(db, 'customers').map((row) => row.name), names, '快照含 WAL 里已提交的内容');
    });
    assert.deepEqual(describeSchema(writer), beforeFailure);
    assert.deepEqual(rowsOf(writer, 'customers').map((row) => row.name), names);
    writer.close();

    // 成功的升级
    const db = openBusinessDatabase(w.path, { appVersion: 'test-9.9.9', steps: fictionalSteps, build: fictionalBuild, log: (m) => messages.push(m) });
    try {
      assert.deepEqual(versions(db), [20, 21, 22, 23]);
      assert.deepEqual(rowsOf(db, 'customers').map((row) => row.name), names);
      assert.equal(one(db, 'foreign_keys'), 1);
      assert.equal(one(db, 'journal_mode'), 'wal');
      assert.equal(snapshots().length, 2);
      assert.equal(messages.at(-1), '业务数据库已从第 20 版升级到第 23 版。');
      assert.match(messages[messages.length - 2], /^已生成升级前业务库快照：.*upgrade-v20-to-v23-/);
    } finally {
      db.close();
    }
    // 已经是最新：不再拍、不再升
    openBusinessDatabase(w.path, { appVersion: 'test-9.9.9', steps: fictionalSteps, build: fictionalBuild, log: (m) => messages.push(m) }).close();
    assert.equal(snapshots().length, 2);
    assert.equal(messages.length, 3, '一次失败的升级只有快照的说明，一次成功的升级有快照和升级两条');
    assert.equal(snapshotBeforeUpgrade(w.path, fictionalSteps), null);
  } finally {
    w.close();
  }
});

test('升级前快照：只在可以升级时拍；拍不成就不升级；只保留最近 3 份，别的文件不动；snapshot:false 不拍', () => {
  const w = workspace('erp-schema-snapshot-');
  try {
    assert.equal(snapshotBeforeUpgrade(w.path), null, '文件不存在');
    assert.equal(snapshotBeforeUpgrade(':memory:'), null);
    baselineDatabase(w.path);
    assert.equal(snapshotBeforeUpgrade(w.path, []), null, '已经是当前版本');
    const dir = join(w.dir, 'snapshots');
    const taken: string[] = [];
    for (let i = 0; i < 5; i++) {
      const file = snapshotBeforeUpgrade(w.path, fictionalSteps);
      assert.ok(file && existsSync(file));
      taken.push(file);
      if (i === 0) {
        writeFileSync(join(dir, 'erp-2026-11-01T00-00-00-000Z-abcdef-reset.sqlite'), '虚构的破坏性操作前快照');
        writeFileSync(join(dir, 'upgrade-2026-01-01T00-00-00-000Z-abcdef.sqlite'), '0.9.0 以前的升级前快照');
        writeFileSync(join(dir, '别的文件.txt'), '不是快照');
      }
    }
    const kept = readdirSync(dir).filter((name) => /^upgrade-v/.test(name));
    assert.equal(kept.length, 3);
    assert.deepEqual(kept.sort(), taken.slice(-3).map((file) => file.slice(dir.length + 1)).sort(), '留下的是最近 3 份');
    for (const other of ['erp-2026-11-01T00-00-00-000Z-abcdef-reset.sqlite', 'upgrade-2026-01-01T00-00-00-000Z-abcdef.sqlite', '别的文件.txt'])
      assert.ok(existsSync(join(dir, other)), other);
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.partial')), false);

    // 快照目录不能用：不升级，库不变
    const blocked = workspace('erp-schema-snapshot-blocked-');
    try {
      baselineDatabase(blocked.path);
      writeFileSync(join(blocked.dir, 'snapshots'), '占住快照目录的文件');
      const hash = sha256(blocked.path);
      assert.throws(
        () => openBusinessDatabase(blocked.path, { ...quiet, steps: fictionalSteps }),
        (error: Error) => error instanceof SchemaError && /^升级前业务库快照失败，没有开始升级，数据没有改动：/.test(error.message),
      );
      assert.equal(sha256(blocked.path), hash);
      // 明确不要快照时照常升级
      const db = openBusinessDatabase(blocked.path, { ...quiet, steps: fictionalSteps, build: fictionalBuild, snapshot: false });
      try {
        assert.deepEqual(versions(db), [20, 21, 22, 23]);
      } finally {
        db.close();
      }
    } finally {
      blocked.close();
    }
  } finally {
    w.close();
  }
});

/** 虚构的升级步骤：按 SQLite 官方做法重建 orders（建新表、复制、删旧表、改名、重建索引），结构不变 */
const rebuildOrders = (version: number, seen: number[]): UpgradeStep => ({
  version,
  name: '虚构：重建订单表',
  up: (db) => {
    const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='orders'").get();
    if (!table) throw new Error('虚构步骤：库里没有 orders 表');
    const sql = String(table.sql);
    const indexes = db
      .prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='orders' AND sql IS NOT NULL")
      .all()
      .map((row) => String(row.sql));
    const columns = db
      .prepare("SELECT name FROM pragma_table_xinfo('orders') WHERE hidden=0")
      .all()
      .map((row) => String(row.name))
      .join(',');
    const created = sql.replace(/^CREATE TABLE "?orders"?/, 'CREATE TABLE orders_rebuilt');
    assert.notEqual(created, sql);
    db.exec(created);
    db.exec(`INSERT INTO orders_rebuilt(${columns}) SELECT ${columns} FROM orders;
      DROP TABLE orders;
      ALTER TABLE orders_rebuilt RENAME TO orders;`);
    for (const index of indexes) db.exec(index);
    // 记下重建刚做完、执行器还没补计数时的下一个编号
    seen.push(nextAutoId(db, 'orders'));
  },
});

test('升级步骤重建自增表：删掉的最大编号不会被重新分出去（表空了也一样），结构不变', () => {
  const w = workspace('erp-schema-autoincrement-');
  try {
    baselineDatabase(w.path);
    const db = new DatabaseSync(w.path);
    try {
      db.exec('PRAGMA foreign_keys=ON');
      const first = db.prepare('SELECT id FROM customers').get();
      assert.ok(first, '库里有客户');
      const customer = Number(first.id);
      const insert = db.prepare(
        "INSERT INTO orders(number,customer_id,customer_name,order_date,delivery_date,status,total_cents,created_at,updated_at,notes) VALUES(?,?,'虚构升级客户','2026-11-01','2026-11-10','待确认',0,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z','')",
      );
      for (let i = 1; i <= 5; i++) insert.run('虚构-DD-' + i, customer);
      db.exec('DELETE FROM orders WHERE id=5');
      assert.equal(nextAutoId(db, 'orders'), 6);
      const before = describeSchema(db);

      const seen: number[] = [];
      assert.deepEqual(upgradeSchema(db, { appVersion: 'test-9.9.9', steps: [rebuildOrders(21, seen)] }), { from: 20, to: 21 });
      assert.deepEqual(seen, [5], '不补的话，重建以后第 5 号会被重新分出去');
      assert.equal(nextAutoId(db, 'orders'), 6, '升级以后编号不回头');
      assert.deepEqual(db.prepare('SELECT id FROM orders ORDER BY id').all().map((row) => Number(row.id)), [1, 2, 3, 4]);
      assert.deepEqual({ ...describeSchema(db), versions: before.versions }, before, '重建前后结构一样');

      // 订单全删光再重建：复制进来的是空表，sqlite_sequence 里连这一行都没有了，执行器补一行
      db.exec('DELETE FROM orders');
      const later: number[] = [];
      upgradeSchema(db, { appVersion: 'test-9.9.9', steps: [rebuildOrders(21, []), rebuildOrders(22, later)] });
      assert.deepEqual(later, [1]);
      assert.equal(nextAutoId(db, 'orders'), 6);
      assert.equal(Number(insert.run('虚构-DD-6', customer).lastInsertRowid), 6, 'SQLite 自己分的编号也接着 6');
      // 别的自增表的计数不受影响
      assert.equal(counters(db).get('customers'), 1);
    } finally {
      db.close();
    }
  } finally {
    w.close();
  }
});

test('第 20 版的库用一套建表和升级步骤升上来，再用同一套打开放行；那套建表直接建出来的结构和升上来的一样', () => {
  const w = workspace('erp-schema-upgrade-reopen-');
  const fresh = workspace('erp-schema-upgrade-fresh-');
  try {
    baselineDatabase(w.path);
    const fictional = { ...quiet, steps: fictionalSteps, build: fictionalBuild, snapshot: false };
    openBusinessDatabase(w.path, fictional).close();
    const upgraded = openBusinessDatabase(w.path, fictional);
    const built = openBusinessDatabase(fresh.path, fictional);
    try {
      assert.deepEqual(versions(upgraded), [20, 21, 22, 23]);
      assert.equal(schemaFingerprint(describeSchema(upgraded)), schemaFingerprint(describeSchema(built)));
    } finally {
      upgraded.close();
      built.close();
    }
  } finally {
    w.close();
    fresh.close();
  }
});

test('升级步骤从第 21 版起连续，当前版本等于基线加步骤数', () => {
  upgradeSteps.forEach((step, index) => {
    assert.equal(step.version, SCHEMA_BASELINE + 1 + index);
    assert.ok(step.name.trim(), `第 ${step.version} 版的步骤要有名字`);
  });
  assert.equal(SCHEMA_LATEST, SCHEMA_BASELINE + upgradeSteps.length);
});
