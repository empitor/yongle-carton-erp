// 业务库新建：空库直接建成当前版本、建了一半退回、空间回收、建表语句规范化。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import {
  SCHEMA_APPLICATION_ID,
  SCHEMA_BASELINE,
  SCHEMA_LATEST,
  SchemaError,
  createSchema,
  describeSchema,
  expectedSchemaFingerprint,
  inspectSchema,
  normalizeSql,
  openBusinessDatabase,
  schemaFingerprint,
  upgradeSteps,
  type UpgradeStep,
} from '../server/core/schema/index.js';
import { APP_VERSION } from '../shared/core/version.js';
import { count } from '../server/core/sql.js';
import { one, quiet, rowsOf, versions, workspace } from './schema-fixture.js';

/** 程序新建的库的版本记录：第 20 版到当前版本各一行（建表已经是当前结构，新库不跑升级步骤） */
const createdVersions = [SCHEMA_BASELINE, ...upgradeSteps.map((step) => step.version)];

test('空库新建：版本记录从第 20 版到当前版本各一行，文件设置、连接设置、预置数据齐全；内存库和文件库结构一样，重新打开不变', () => {
  const w = workspace('erp-schema-new-');
  try {
    const store = new Store(w.path);
    try {
      const db = store.db;
      assert.equal(SCHEMA_BASELINE, 20);
      assert.deepEqual(
        rowsOf(db, 'schema_migrations').map((row) => ({ ...row, applied_at: typeof row.applied_at })),
        [
          { version: 20, name: '0.9.0 基线', applied_at: 'string', app_version: APP_VERSION },
          ...upgradeSteps.map((step) => ({ version: step.version, name: step.name, applied_at: 'string', app_version: APP_VERSION })),
        ],
      );
      assert.equal(one(db, 'application_id'), SCHEMA_APPLICATION_ID);
      assert.equal(SCHEMA_APPLICATION_ID, 0x5a584552);
      assert.equal(one(db, 'auto_vacuum'), 2, 'auto_vacuum 要在开 WAL、建表之前设成 INCREMENTAL');
      assert.equal(one(db, 'journal_mode'), 'wal');
      assert.equal(one(db, 'foreign_keys'), 1);
      assert.equal(one(db, 'synchronous'), 2, 'FULL');
      assert.equal(one(db, 'busy_timeout'), 5000);
      assert.equal(one(db, 'cache_size'), -65536);
      assert.equal(one(db, 'journal_size_limit'), 64 * 1024 * 1024);
      assert.equal(count(db, 'SELECT count(*) FROM fin_settings'), 1);
      assert.equal(count(db, 'SELECT count(*) FROM fin_accounts'), 93);
      assert.equal(count(db, 'SELECT count(*) FROM fin_templates'), 11);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(inspectSchema(db), { kind: 'current', version: SCHEMA_LATEST });
      const description = describeSchema(db);
      assert.deepEqual(description.versions, createdVersions);
      assert.equal(description.applicationId, SCHEMA_APPLICATION_ID);
      assert.equal(description.autoVacuum, 2);
      assert.deepEqual(Object.keys(description.seed).sort(), ['fin_accounts', 'fin_settings', 'fin_templates']);
      assert.equal(schemaFingerprint(description), expectedSchemaFingerprint());
      const memory = new Store(':memory:');
      try {
        assert.equal(schemaFingerprint(describeSchema(memory.db)), expectedSchemaFingerprint());
        assert.deepEqual(describeSchema(memory.db).seed, description.seed);
        assert.equal(one(memory.db, 'foreign_keys'), 1);
        assert.deepEqual(versions(memory.db), createdVersions);
      } finally {
        memory.close();
      }
    } finally {
      store.close();
    }
    const before = (() => {
      const db = new DatabaseSync(w.path, { readOnly: true });
      try {
        return { description: describeSchema(db), records: rowsOf(db, 'schema_migrations') };
      } finally {
        db.close();
      }
    })();
    const again = new Store(w.path);
    try {
      assert.deepEqual(describeSchema(again.db), before.description);
      assert.deepEqual(rowsOf(again.db, 'schema_migrations'), before.records, '重新打开不重写版本记录');
      assert.equal(one(again.db, 'journal_mode'), 'wal');
      assert.equal(one(again.db, 'cache_size'), -65536);
    } finally {
      again.close();
    }
    assert.equal(existsSync(join(w.dir, 'snapshots')), false, '新建和正常打开都不拍升级前快照');
  } finally {
    w.close();
  }
});

test('只写过文件头的空文件、0 字节的文件都当空库建，auto_vacuum 照样生效', () => {
  const w = workspace('erp-schema-header-');
  try {
    const header = new DatabaseSync(w.path);
    header.exec('PRAGMA journal_mode=WAL');
    header.close();
    assert.ok(statSync(w.path).size > 0);
    const store = new Store(w.path);
    try {
      assert.equal(one(store.db, 'auto_vacuum'), 2);
      assert.equal(one(store.db, 'application_id'), SCHEMA_APPLICATION_ID);
      assert.deepEqual(versions(store.db), createdVersions);
    } finally {
      store.close();
    }
    const zero = join(w.dir, 'zero', 'erp.sqlite');
    mkdirSync(join(w.dir, 'zero'));
    writeFileSync(zero, '');
    const fresh = new Store(zero);
    try {
      assert.equal(one(fresh.db, 'auto_vacuum'), 2);
      assert.deepEqual(versions(fresh.db), createdVersions);
    } finally {
      fresh.close();
    }
  } finally {
    w.close();
  }
});

test('建新库失败：建了一半的表全部退回，抛中文的 SchemaError（写明原因和文件）；SQLite 已经自己退回事务时原因不被盖掉；下次照常建库', () => {
  const w = workspace('erp-schema-create-fail-');
  try {
    const tables = () => {
      const db = new DatabaseSync(w.path, { readOnly: true });
      try {
        return count(db, "SELECT count(*) FROM sqlite_schema WHERE type='table'");
      } finally {
        db.close();
      }
    };
    const expectFailure = (steps: UpgradeStep[], reason: RegExp) =>
      assert.throws(
        () => openBusinessDatabase(w.path, { ...quiet, steps }),
        (error: Error) => {
          assert.ok(error instanceof SchemaError, '抛的是 SchemaError：' + error.message);
          assert.match(error.message, /^业务数据库没有建成：/);
          assert.match(error.message, reason);
          assert.ok(error.message.includes('文件：' + w.path), '提示里写明是哪个文件');
          assert.match(error.message, /建了一半的表已经全部退回，程序没有启动。请检查磁盘空间和这个目录的读写权限/);
          assert.doesNotMatch(error.message, /no transaction is active/);
          return true;
        },
      );
    // 写版本记录时出错（版本名是空的）：事务还开着，由 createSchema 退回。
    // 版本名按类型必填，造坏数据时先建成合法的步骤，再把名字改成 null
    const nameless: UpgradeStep = { version: 21, name: '虚构', up: () => {} };
    Reflect.set(nameless, 'name', null);
    expectFailure([nameless], /NOT NULL constraint failed: schema_migrations\.name/);
    assert.equal(tables(), 0, '建了一半的表全部退回');
    // 磁盘满、读写出错这类错误 SQLite 会自己退回事务：模拟成读版本名时事务已经没了，原来的原因要原样抛出来
    const db = new DatabaseSync(w.path);
    try {
      assert.throws(
        () =>
          createSchema(db, {
            appVersion: 'test-9.9.9',
            steps: [
              {
                version: 21,
                get name(): string {
                  db.exec('ROLLBACK');
                  throw new Error('虚构的磁盘已满');
                },
                up: () => {},
              },
            ],
          }),
        /^Error: 虚构的磁盘已满$/,
      );
      assert.equal(db.isTransaction, false);
    } finally {
      db.close();
    }
    assert.equal(tables(), 0);
    // 原因排除以后照常建库
    const store = new Store(w.path);
    try {
      assert.deepEqual(versions(store.db), createdVersions);
      assert.equal(one(store.db, 'application_id'), SCHEMA_APPLICATION_ID);
    } finally {
      store.close();
    }
  } finally {
    w.close();
  }
});

test('删掉数据后空出来的空间能还给磁盘：页数和文件都变小；正开着事务时不做，内存库和关掉的库跳过', () => {
  const w = workspace('erp-schema-reclaim-');
  /** 写入一批虚构内容再删掉，返回空出来多少页。用自己的临时表，不依赖业务表长什么样 */
  const fillAndDelete = (db: DatabaseSync) => {
    db.exec('CREATE TABLE fictional_bulk(id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO fictional_bulk(body) VALUES(?)');
    db.exec('BEGIN');
    for (let i = 0; i < 2000; i++) insert.run('虚构内容'.repeat(100));
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const pages = Number(one(db, 'page_count'));
    db.exec('DELETE FROM fictional_bulk');
    assert.equal(Number(one(db, 'page_count')), pages, '删除只把页记成空闲，页数不会自己变少');
    return Number(one(db, 'freelist_count'));
  };
  try {
    const store = new Store(w.path);
    try {
      const db = store.db;
      assert.equal(store.reclaimSpace(), 0, '新建的库没有空闲页');
      const free = fillAndDelete(db);
      assert.ok(free > 100, '删掉的数据占的页都成了空闲页');
      const before = { pages: Number(one(db, 'page_count')), bytes: statSync(w.path).size };
      // 正开着事务：这次不做，留到下一次
      db.exec('BEGIN');
      assert.equal(store.reclaimSpace(), 0);
      db.exec('ROLLBACK');
      assert.equal(Number(one(db, 'freelist_count')), free);
      assert.equal(store.reclaimSpace(), free, '返回还了多少页');
      assert.equal(Number(one(db, 'freelist_count')), 0);
      const pages = Number(one(db, 'page_count'));
      assert.ok(pages <= before.pages - free, `页数从 ${before.pages} 降到 ${pages}`);
      // 文件本身也变小了（WAL 模式下要等检查点，回收完顺带做了一次）
      assert.equal(statSync(w.path).size, pages * Number(one(db, 'page_size')));
      assert.ok(statSync(w.path).size < before.bytes);
      assert.deepEqual(db.prepare('PRAGMA quick_check').all().map((row) => ({ ...row })), [{ quick_check: 'ok' }]);
      assert.equal(store.reclaimSpace(), 0, '没有空闲页了');
    } finally {
      store.close();
    }
    assert.equal(store.reclaimSpace(), 0, '库已经关了：不报错');
    const memory = new Store(':memory:');
    try {
      const free = fillAndDelete(memory.db);
      assert.ok(free > 100);
      assert.equal(memory.reclaimSpace(), 0, '内存库没有文件可还');
      assert.equal(Number(one(memory.db, 'freelist_count')), free);
    } finally {
      memory.close();
    }
  } finally {
    w.close();
  }
});

test('建立语句规范化：排版、标识符引号、大小写不算差别，字符串里的内容算', () => {
  assert.equal(
    normalizeSql('CREATE TABLE "products"(\n  id INTEGER PRIMARY KEY,\n  unit TEXT DEFAULT \'mm\'\n)'),
    normalizeSql("create table products(id integer primary key, unit text default 'mm')"),
  );
  assert.notEqual(normalizeSql("x TEXT DEFAULT 'MM'"), normalizeSql("x TEXT DEFAULT 'mm'"));
  assert.notEqual(normalizeSql("x TEXT DEFAULT 'a b'"), normalizeSql("x TEXT DEFAULT 'ab'"));
  assert.equal(normalizeSql(`d TEXT DEFAULT '{"a":null}'`), `dtextdefault'{"a":null}'`);
  assert.equal(normalizeSql("n TEXT DEFAULT 'it''s  ok' NOT NULL"), "ntextdefault'it''s  ok'notnull");
});
