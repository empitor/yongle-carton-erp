// 业务库拒收：0.9.0 以前的旧库、比程序新的库、别的文件、版本记录不完整的库都不打开，文件内容不变、不拍快照。
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import {
  SCHEMA_BASELINE,
  SCHEMA_LATEST,
  SchemaError,
  inspectSchema,
  openBusinessDatabase,
  schemaRefusal,
  snapshotBeforeUpgrade,
  upgradeSteps,
  type UpgradeStep,
} from '../server/core/schema/index.js';
import { currentDatabase, fictionalBuild, fictionalSteps, legacyDatabase, quiet, sha256, versions, workspace } from './schema-fixture.js';

const refusals: {
  name: string;
  build(path: string): void;
  kind: string;
  steps?: UpgradeStep[];
  expect: RegExp[];
}[] = [
  {
    name: '0.9.0 以前的旧库（只有第 1～19 版记录）',
    build: (path) => legacyDatabase(path),
    kind: 'legacy',
    expect: [
      /^这是 0\.9\.0 以前的旧业务数据库（第 19 版）：/,
      /0\.9\.0 起业务数据从新库开始，不再升级旧库。程序没有启动，数据没有任何改动。/,
      /erp\.sqlite，连同 erp\.sqlite-wal、erp\.sqlite-shm/,
      /import-archive 目录/,
      /ai-imports 目录/,
      /其余目录留着不动：账号（security）、提示词（ai-prompts）、助手工具设置（ai-tools）/,
      /用 0\.8\.4 的程序打开移走的那一份/,
    ],
  },
  {
    name: '比程序新的库',
    build: (path) => {
      currentDatabase(path);
      const db = new DatabaseSync(path);
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at,app_version) VALUES(?,?,?,?)').run(SCHEMA_LATEST + 1, '虚构的将来版本', '2027-01-01T00:00:00Z', '9.9.9');
      db.close();
    },
    kind: 'newer',
    expect: [
      new RegExp(`^数据库是第 ${SCHEMA_LATEST + 1} 版，比当前程序（最多支持第 ${SCHEMA_LATEST} 版）新：`),
      /多半是补丁回滚时只换回了程序。请换回新版本的程序，或用补丁前的完整备份恢复。/,
      /程序没有启动，数据没有任何改动。$/,
    ],
  },
  {
    name: '别的 SQLite 文件',
    build: (path) => {
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes(body) VALUES('别的程序的数据')");
      db.close();
    },
    kind: 'foreign',
    expect: [/^这个文件不是本系统的业务数据库：/, /请检查 DB_PATH 指向的位置。程序没有启动，数据没有任何改动。$/],
  },
  {
    name: '别的程序的库（文件头里是别的标识）',
    build: (path) => {
      const db = new DatabaseSync(path);
      db.exec('PRAGMA application_id=12345; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations(version) VALUES(20)');
      db.close();
    },
    kind: 'foreign',
    expect: [/^这个文件不是本系统的业务数据库：/],
  },
  {
    name: '根本不是数据库的文件',
    build: (path) => writeFileSync(path, '这不是数据库。'.repeat(400)),
    kind: 'foreign',
    expect: [/^这个文件不是本系统的业务数据库：/],
  },
  {
    name: '版本缺号的库（有第 20、22 版，缺第 21 版）',
    build: (path) => {
      currentDatabase(path);
      const db = new DatabaseSync(path);
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at,app_version) VALUES(?,?,?,?)').run(22, '虚构', '2027-01-01T00:00:00Z', '9.9.9');
      db.close();
    },
    kind: 'broken',
    steps: fictionalSteps,
    expect: [/^业务数据库的版本记录不完整（缺第 21 版的记录）：/, /请用最近的完整备份恢复，或联系维护人员。程序没有启动，数据没有任何改动。$/],
  },
  {
    name: '版本记录被清空的库',
    build: (path) => {
      currentDatabase(path);
      const db = new DatabaseSync(path);
      db.exec('DELETE FROM schema_migrations');
      db.close();
    },
    kind: 'broken',
    expect: [/^业务数据库的版本记录不完整（版本记录是空的）：/],
  },
  {
    name: '有版本记录到第 20 版、却没有本系统标识的库',
    build: (path) => {
      legacyDatabase(path, 20);
    },
    kind: 'broken',
    expect: [/版本记录不完整（版本记录到了第 20 版，但文件里没有本系统的标识）/],
  },
];
for (const refusal of refusals)
  test(`拒绝打开，文件内容不变：${refusal.name}`, () => {
    const w = workspace('erp-schema-refuse-');
    try {
      refusal.build(w.path);
      const hash = sha256(w.path);
      const open = () =>
        refusal.steps ? openBusinessDatabase(w.path, { ...quiet, steps: refusal.steps }).close() : new Store(w.path).close();
      for (let attempt = 0; attempt < 2; attempt++)
        assert.throws(open, (error: Error) => {
          assert.ok(error instanceof SchemaError, '抛的是 SchemaError：' + error.message);
          for (const pattern of refusal.expect) assert.match(error.message, pattern);
          assert.ok(error.message.includes(w.path), '提示里写明是哪个文件');
          return true;
        });
      assert.equal(sha256(w.path), hash, '文件内容不变');
      assert.equal(existsSync(join(w.dir, 'snapshots')), false, '被拒绝的库不拍快照');
      assert.equal(snapshotBeforeUpgrade(w.path, refusal.steps), null);
      assert.equal(sha256(w.path), hash);
      if (refusal.name !== '根本不是数据库的文件') {
        const db = new DatabaseSync(w.path, { readOnly: true });
        try {
          const state = inspectSchema(db, SCHEMA_BASELINE + (refusal.steps?.length ?? upgradeSteps.length));
          assert.equal(state.kind, refusal.kind);
          const refused = schemaRefusal(state, w.path);
          assert.ok(refused, refusal.name + '：要拒绝打开');
          assert.match(refused, refusal.expect[0]);
        } finally {
          db.close();
        }
      }
    } finally {
      w.close();
    }
  });

test('版本是当前版、表结构和程序对不上的库：拒绝打开并写明缺了、多出、结构不同的表，文件不变；升级上来对不上的整体退回', () => {
  const w = workspace('erp-schema-mismatch-');
  try {
    currentDatabase(w.path);
    const db = new DatabaseSync(w.path);
    db.exec(`DROP TABLE document_template_settings;
      CREATE TABLE dev_scratch(id INTEGER PRIMARY KEY);
      ALTER TABLE customers ADD COLUMN dev_note TEXT;`);
    db.close();
    const hash = sha256(w.path);
    assert.throws(
      () => new Store(w.path),
      (error: Error) => {
        assert.ok(error instanceof SchemaError, '抛的是 SchemaError：' + error.message);
        assert.match(error.message, new RegExp(`^业务数据库的表结构和当前程序（第 ${SCHEMA_LATEST} 版）对不上：`));
        assert.ok(error.message.includes(w.path), '提示里写明是哪个文件');
        assert.match(error.message, /缺了的表：document_template_settings/);
        assert.match(error.message, /多出的表：dev_scratch/);
        assert.match(error.message, /结构不同的表：customers/);
        assert.match(error.message, /完整备份恢复/);
        assert.match(error.message, /程序没有启动，数据没有任何改动。$/);
        return true;
      },
    );
    assert.equal(sha256(w.path), hash, '文件内容不变');
    assert.throws(
      () => openBusinessDatabase(w.path, { ...quiet, steps: fictionalSteps, build: fictionalBuild, snapshot: false }),
      (error: Error) =>
        error instanceof SchemaError &&
        /第 20 版升级到第 23 版失败，已整体退回/.test(error.message) &&
        /缺了的表：document_template_settings/.test(error.message),
    );
    const after = new DatabaseSync(w.path, { readOnly: true });
    try {
      assert.deepEqual(inspectSchema(after, 23), { kind: 'upgrade', from: 20, to: 23 }, '升级退回，版本没变');
    } finally {
      after.close();
    }
  } finally {
    w.close();
  }
});

test('换了一套建表和升级步骤（测试的虚构结构）时按传进来的那套核对：用它新建的库，再用同一套打开照常放行', () => {
  const w = workspace('erp-schema-fictional-new-');
  try {
    const fictional = { ...quiet, steps: fictionalSteps, build: fictionalBuild };
    openBusinessDatabase(w.path, fictional).close();
    const db = openBusinessDatabase(w.path, fictional);
    try {
      assert.deepEqual(versions(db), [20, 21, 22, 23]);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='fictional_children'").get(), '按虚构的建表建出来');
    } finally {
      db.close();
    }
  } finally {
    w.close();
  }
});

test('能打开的状态没有拒绝提示；旧库带着没合并的 WAL 被拒绝时，主文件和 WAL 都原样不动', () => {
  assert.equal(schemaRefusal({ kind: 'empty' }, 'x'), null);
  assert.equal(schemaRefusal({ kind: 'current', version: 20 }, 'x'), null);
  assert.equal(schemaRefusal({ kind: 'upgrade', from: 20, to: 21 }, 'x'), null);
  const legacy = schemaRefusal({ kind: 'legacy', version: null }, 'x');
  assert.ok(legacy, '没有版本记录的旧库要拒绝打开');
  assert.match(legacy, /旧业务数据库（没有版本记录）/);
  const w = workspace('erp-schema-wal-');
  try {
    const source = join(w.dir, 'source.sqlite');
    const db = new DatabaseSync(source);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO schema_migrations(version,applied_at) VALUES(19,'2026-11-01 00:00:00');
      INSERT INTO customers(id,name) VALUES(1,'只在 WAL 里的旧客户');`);
    // 连接还开着时把主文件和 WAL 一起复制走：复制出来的库带着没合并的 WAL
    mkdirSync(join(w.dir, 'old'));
    const path = join(w.dir, 'old', 'erp.sqlite');
    copyFileSync(source, path);
    copyFileSync(source + '-wal', path + '-wal');
    db.close();
    assert.ok(statSync(path + '-wal').size > 0);
    const before = { main: sha256(path), wal: sha256(path + '-wal') };
    assert.throws(() => new Store(path), /0\.9\.0 以前的旧业务数据库（第 19 版）/);
    assert.equal(sha256(path), before.main);
    assert.equal(sha256(path + '-wal'), before.wal, 'WAL 没有被合并或清掉');
  } finally {
    w.close();
  }
});
