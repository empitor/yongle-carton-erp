// 配置库（账号、AI 设置、提示词、助手工具设置、机器人设置、AI 识别工作区）的统一规则：
// 当前版本原样打开、新文件按当前结构建、旧库（比当前旧或没记版本却有表）删掉重建、比程序新的拒绝、坏文件不删。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkVersionedSqlite,
  openVersionedSqlite,
  registerVersionedSqlite,
  VersionedSqliteError,
  type VersionedSqliteSpec,
} from '../server/core/versioned-sqlite.js';

/** 一个虚构的配置库：当前是第 3 版，notes 带 pinned 列，另有 tags 表。 */
const notesOld = 'CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT NOT NULL)';
const spec = (override: Partial<VersionedSqliteSpec> = {}): VersionedSqliteSpec => ({
  label: '便签库',
  latest: 3,
  create(db) {
    db.exec(`CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE tags(note_id INTEGER NOT NULL REFERENCES notes(id),tag TEXT NOT NULL);`);
  },
  ...override,
});
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const version = (db: DatabaseSync) => Number(db.prepare('PRAGMA user_version').get()?.user_version);
const tables = (db: DatabaseSync) =>
  db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map((r) => String(r.name));
/** 在临时目录里用原始 SQL 造一个库文件（虚构数据） */
function workspace(prepare?: (db: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'erp-versioned-')),
    file = join(dir, 'notes.sqlite');
  if (prepare) {
    const db = new DatabaseSync(file);
    try {
      prepare(db);
    } finally {
      db.close();
    }
  }
  return { dir, file, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const refused = (file: string, s: VersionedSqliteSpec) => {
  try {
    openVersionedSqlite(file, s).close();
  } catch (error) {
    assert.ok(error instanceof VersionedSqliteError, '拒绝时抛的是给人看的中文提示：' + String(error));
    return error.message;
  }
  assert.fail('应当拒绝打开');
};

test('配置库：新文件按当前结构建，记成当前版本；再打开原样打开，数据还在', () => {
  const f = workspace();
  try {
    let db = openVersionedSqlite(f.file, spec());
    assert.equal(version(db), 3);
    assert.deepEqual(tables(db), ['notes', 'tags']);
    db.prepare("INSERT INTO notes(id,body,pinned) VALUES(1,'虚构便签',1)").run();
    db.close();
    db = openVersionedSqlite(f.file, spec({ create: () => assert.fail('当前版本不重建') }));
    assert.equal(db.prepare('SELECT body FROM notes WHERE id=1').get()?.body, '虚构便签');
    db.close();
    assert.deepEqual(readdirSync(f.dir).filter((n) => n.endsWith('.bak')), [], '不留备份');
  } finally {
    f.done();
  }
});

test('配置库：:memory: 能用，每次都是按当前结构新建', () => {
  const db = openVersionedSqlite(':memory:', spec());
  assert.equal(version(db), 3);
  assert.deepEqual(tables(db), ['notes', 'tags']);
  db.close();
});

test('配置库：比当前版本旧的、没记版本却有表的（0.9.0 以前留下的），整个删掉按当前结构重建，不迁移、不留备份', () => {
  for (const [why, sql] of [
    ['第 1 版', `${notesOld}; INSERT INTO notes VALUES(1,'旧便签'); PRAGMA user_version=1;`],
    ['第 2 版', `${notesOld}; INSERT INTO notes VALUES(1,'旧便签'); PRAGMA user_version=2;`],
    ['没记版本的旧库', `${notesOld}; INSERT INTO notes VALUES(1,'旧便签');`],
  ] as const) {
    const f = workspace((db) => db.exec(sql));
    try {
      writeFileSync(f.file + '-journal', '');
      const db = openVersionedSqlite(f.file, spec());
      assert.equal(version(db), 3, why);
      assert.deepEqual(tables(db), ['notes', 'tags'], why);
      assert.equal(db.prepare('SELECT count(*) AS n FROM notes').get()?.n, 0, why + '：旧内容不留');
      db.close();
      assert.deepEqual(readdirSync(f.dir).filter((n) => n !== 'notes.sqlite' && !n.endsWith('-wal') && !n.endsWith('-shm')), [], why + '：不留备份和附属文件');
    } finally {
      f.done();
    }
  }
});

test('配置库：比程序新的拒绝打开，文件不变', () => {
  const f = workspace((db) => db.exec(`${notesOld}; PRAGMA user_version=4;`));
  try {
    const before = sha(f.file);
    const message = refused(f.file, spec());
    assert.match(message, /^便签库比当前程序新，不能打开：它是第 4 版，当前程序最多支持第 3 版/);
    assert.match(message, /请换回新版本的程序再启动/);
    assert.ok(message.includes('文件：' + f.file));
    assert.equal(sha(f.file), before);
  } finally {
    f.done();
  }
});

test('配置库：不是数据库的文件不删，拒绝打开，文件不变', () => {
  const f = workspace();
  try {
    writeFileSync(f.file, '这不是数据库，是一段虚构的文字。'.repeat(40));
    const before = sha(f.file);
    assert.match(refused(f.file, spec()), /便签库不能打开：文件不是 SQLite 数据库，或者已经损坏/);
    assert.equal(sha(f.file), before);
  } finally {
    f.done();
  }
});

test('配置库：文件被别的程序占着时说“被占用”，不说损坏、不叫人移走文件；放开后照常打开', () => {
  const f = workspace((db) => db.exec(`${notesOld}; INSERT INTO notes(id,body) VALUES(1,'被占用时的虚构便签'); PRAGMA user_version=3;`));
  const holder = new DatabaseSync(f.file);
  try {
    holder.exec('BEGIN EXCLUSIVE');
    const message = refused(f.file, spec({ busyTimeout: 50 }));
    assert.match(message, /^便签库不能打开：文件正被别的程序占用/);
    assert.doesNotMatch(message, /损坏|移走/);
    assert.match(message, /文件没有任何改动/);
    holder.exec('ROLLBACK');
    const db = openVersionedSqlite(f.file, spec({ busyTimeout: 50, create: () => assert.fail('不应重建') }));
    assert.equal(db.prepare('SELECT body FROM notes WHERE id=1').get()?.body, '被占用时的虚构便签');
    db.close();
  } finally {
    holder.close();
    f.done();
  }
});

test('配置库：建库中途出错整体退回，不留半个库；所在目录打不开时提示带库名和路径', () => {
  const f = workspace();
  try {
    const message = refused(
      f.file,
      spec({
        create(db) {
          db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT NOT NULL)');
          throw new Error('虚构的建库失败');
        },
      }),
    );
    assert.match(message, /^便签库没有建成：虚构的建库失败/);
    const left = new DatabaseSync(f.file, { readOnly: true });
    try {
      assert.equal(version(left), 0);
      assert.deepEqual(tables(left), [], '建到一半的表一起退回');
    } finally {
      left.close();
    }
    // 修好后同一个文件能正常建
    const db = openVersionedSqlite(f.file, spec());
    assert.equal(version(db), 3);
    db.close();
    // 路径中间是一个普通文件，目录建不出来
    writeFileSync(join(f.dir, 'blocker'), '虚构占位');
    const blocked = join(f.dir, 'blocker', 'notes.sqlite');
    const cannot = refused(blocked, spec());
    assert.match(cannot, /^便签库不能打开：文件或它所在的目录打不开/);
    assert.ok(cannot.includes('文件：' + blocked));
  } finally {
    f.done();
  }
});

test('配置库登记表：打开过的位置、主人模块登记的默认位置都认得；据此只读判断另一个文件放到这个位置以后会怎样', () => {
  const f = workspace();
  try {
    const candidate = join(f.dir, 'candidate.sqlite');
    /** 用原始 SQL 造一个待检查的文件，返回它的哈希 */
    const make = (sql: string, file = candidate) => {
      rmSync(file, { force: true });
      const db = new DatabaseSync(file);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
      return sha(file);
    };
    make(notesOld + '; PRAGMA user_version=1');
    assert.equal(checkVersionedSqlite(candidate, f.file), null, '这个位置还没登记：不知道是哪个库');
    openVersionedSqlite(f.file, spec()).close();
    const cases: [sql: string, version: number, problem: 'newer' | 'older' | null, why: string][] = [
      ['PRAGMA user_version=0', 0, null, '空文件：打开时会直接建'],
      [notesOld, 0, 'older', '没记版本却有表：打开时删掉重建'],
      [notesOld + '; PRAGMA user_version=1', 1, 'older', '比程序旧：打开时删掉重建'],
      [notesOld + '; PRAGMA user_version=3', 3, null, '和程序同版本'],
      [notesOld + '; PRAGMA user_version=4', 4, 'newer', '比程序新'],
    ];
    for (const [sql, seen, problem, why] of cases) {
      const before = make(sql);
      assert.deepEqual(checkVersionedSqlite(candidate, f.file), { label: '便签库', version: seen, latest: 3, problem }, why);
      assert.equal(sha(candidate), before, '只读，文件不变：' + why);
    }
    // 打开时被拒绝的位置也登记了：知道那里放的是哪个库
    const rejected = join(f.dir, 'rejected.sqlite');
    make(notesOld + '; PRAGMA user_version=9', rejected);
    assert.match(refused(rejected, spec()), /便签库比当前程序新/);
    assert.equal(checkVersionedSqlite(candidate, rejected)?.label, '便签库');
    // 主人模块登记的默认位置：登记时不去算，用到时才算；算不出来的当它没登记；只登记，不建文件
    const home = join(f.dir, 'default', 'notes.sqlite');
    let calls = 0;
    registerVersionedSqlite(spec({ label: '位置算不出来的库' }), () => {
      throw new Error('虚构的配置目录错误');
    });
    registerVersionedSqlite(spec({ label: '默认位置的便签库', latest: 1 }), () => {
      calls++;
      return home;
    });
    assert.equal(calls, 0);
    make('PRAGMA user_version=0');
    assert.deepEqual(checkVersionedSqlite(candidate, home), { label: '默认位置的便签库', version: 0, latest: 1, problem: null });
    assert.equal(checkVersionedSqlite(candidate, join(f.dir, 'nobody.sqlite')), null);
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(join(f.dir, 'nobody.sqlite')), false);
  } finally {
    f.done();
  }
});
