// 从完整备份恢复：不合格的备份在复制和切换之前就拒绝、现有数据不动；切换中途出错整体退回；正常的照常恢复。
import { sales } from '../server/sales/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/core/db.js';
import { openVersionedSqlite } from '../server/core/versioned-sqlite.js';
import { ImportRepository } from '../server/import/repository.js';
import { restoreFullBackup } from '../server/core/backup.js';
import { readBackupManifest } from '../server/core/backup-manifest.js';
import { supportedDatabaseVersions, validateBusinessDatabase } from '../server/core/backup-check.js';
import { AuthManager } from '../server/accounts/index.js';
import {
  alterBackupDatabase,
  configFixture,
  files,
  fictionalNotes,
  fictionalNotesV3,
  noteMarker,
  run,
  versionOf,
} from './backup-fixture.js';

function assertTargetUntouched(f: { root: string; target: string }, before: Record<string, string>) {
  assert.deepEqual(files(f.target), before);
  assert.equal(readdirSync(f.root).some((name) => name.startsWith('target.before-restore-') || name.startsWith('target.restore-')), false);
}

test('恢复中第二次改名失败时，退回所有原文件和运行标记，抛出原错误', async (t) => {
  const f = await configFixture();
  const original = fs.renameSync;
  try {
    const before = files(f.target), failure = new Error('虚构第二次改名失败');
    let calls = 0;
    t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      if (++calls === 2) throw failure;
      return original(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => restoreFullBackup(f.backup.dir, f.target), (error) => error === failure);
    assert.equal(calls, 2, '第一项已经切过去后才注入失败');
    assert.deepEqual(files(f.target), before);
    const copy = readdirSync(f.root).find((name) => name.startsWith('target.before-restore-'));
    assert.ok(copy, '留了恢复前的副本');
    assert.deepEqual(files(join(f.root, copy)), before);
    assert.equal(readdirSync(f.root).some((name) => name.startsWith('target.restore-')), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test('切换清空失败也自动退回；回退再次失败时错误保留原副本位置', async (t) => {
  const f = await configFixture(), originalRemove = fs.rmSync, originalCopy = fs.cpSync;
  try {
    const before = files(f.target), failure = new Error('虚构清空失败');
    let removes = 0;
    t.mock.method(fs, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
      if (String(args[0]).startsWith(f.target + sep) && ++removes === 2) throw failure;
      return originalRemove(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => restoreFullBackup(f.backup.dir, f.target), (error) => error === failure);
    assert.deepEqual(files(f.target), before);
    t.mock.restoreAll(); syncBuiltinESMExports();
    t.mock.method(fs, 'renameSync', () => { throw new Error('虚构切换失败'); });
    t.mock.method(fs, 'cpSync', (...args: Parameters<typeof fs.cpSync>) => {
      if (String(args[0]).includes('.before-restore-')) throw new Error('虚构回退失败');
      return originalCopy(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => restoreFullBackup(f.backup.dir, f.target), (error: Error) => {
      assert.match(error.message, /虚构切换失败.*自动回退失败.*before-restore-/);
      const path = error.message.split('原数据副本保留在：')[1];
      assert.deepEqual(files(path), before); return true;
    });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test('版本记录不完整、结构被改过的备份，即使清单哈希正确也拒绝恢复，不改目标目录；备份时不比结构', async () => {
  const latest = Math.max(...supportedDatabaseVersions);
  const mismatch = new RegExp(`数据库的结构和第 ${latest} 版的标准结构不一致`);
  const cases: [sql: string, pattern: RegExp, backupStillWorks: boolean][] = [
    ['DELETE FROM schema_migrations', /数据库版本记录不连续（版本记录是空的），拒绝处理/, false],
    ['CREATE INDEX fictional_extra_index ON customers(name)', mismatch, true],
    ['ALTER TABLE customers ADD COLUMN fictional_extra TEXT', mismatch, true],
  ];
  const f = await configFixture();
  try {
    const database = join(f.backup.dir, 'erp.sqlite'), manifest = join(f.backup.dir, 'manifest.json');
    const originalDatabase = readFileSync(database), originalManifest = readFileSync(manifest);
    const before = files(f.target);
    for (const [sql, pattern, backupStillWorks] of cases) {
      writeFileSync(database, originalDatabase);
      writeFileSync(manifest, originalManifest);
      const path = alterBackupDatabase(f.backup.dir, run(sql));
      assert.throws(() => validateBusinessDatabase(path), pattern, sql);
      assert.throws(() => restoreFullBackup(f.backup.dir, f.target), pattern, sql);
      assertTargetUntouched(f, before);
      // 备份时只查完整性、关联和版本，库被手工加过索引、加过列也照样能备份；恢复才严格
      if (backupStillWorks) assert.deepEqual(validateBusinessDatabase(path, { allowNewer: true }), { version: latest, newer: false });
      else assert.throws(() => validateBusinessDatabase(path, { allowNewer: true }), pattern);
    }
  } finally { f.close(); }
});

test('清单没有、不是 JSON、不合结构（种类不对、文件项缺体积、路径不是文字）：报“不是完整备份目录。”，目标目录不动', async () => {
  const f = await configFixture();
  try {
    const manifestPath = join(f.backup.dir, 'manifest.json');
    const good = readFileSync(manifestPath, 'utf8');
    const before = files(f.target);
    const variants: [string, string | null][] = [
      ['没有清单', null],
      ['不是 JSON', '{不是 JSON'],
      ['种类不对', good.replace('"erp-full-backup"', '"别的备份"')],
      ['文件项缺体积', good.replace(/,\s*"bytes": \d+/, '')],
      ['路径不是文字', good.replace(/"path": "[^"]*"/, '"path": 5')],
    ];
    for (const [name, text] of variants) {
      assert.notEqual(text, good, name);
      if (text === null) rmSync(manifestPath);
      else writeFileSync(manifestPath, text);
      assert.throws(() => restoreFullBackup(f.backup.dir, f.target), /^Error: 不是完整备份目录。$/, name);
      assertTargetUntouched(f, before);
    }
  } finally { f.close(); }
});

test('0.9.0 以前的备份：整目录恢复在复制和切换之前就拒绝，单文件校验是同一句提示，目标目录不动', async () => {
  const f = await configFixture();
  try {
    const path = alterBackupDatabase(f.backup.dir, (file) => {
      rmSync(file);
      const db = new DatabaseSync(file);
      try {
        db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
          CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
          INSERT INTO customers(id,name) VALUES(1,'虚构旧客户');`);
        const record = db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,datetime('now'))");
        for (let version = 1; version <= 19; version++) record.run(version);
      } finally {
        db.close();
      }
    });
    const before = files(f.target);
    const message = '这是 0.9.0 以前的备份（业务库第 19 版），0.9.0 起业务数据从新库开始，不能恢复；要查看旧数据，请用 0.8.4 的程序恢复到另一个目录。';
    const refused = (error: Error) => {
      assert.equal(error.message, message);
      return true;
    };
    assert.throws(() => restoreFullBackup(f.backup.dir, f.target), refused);
    assert.throws(() => validateBusinessDatabase(path), refused);
    assertTargetUntouched(f, before);
    const fresh = join(f.root, 'fresh');
    assert.throws(() => restoreFullBackup(f.backup.dir, fresh), refused);
    assert.equal(existsSync(fresh), false, '新目录也不会被建出来');
    // 备份旧库同样拒绝，说法是“没有备份”
    assert.throws(
      () => validateBusinessDatabase(path, { allowNewer: true }),
      /这是 0\.9\.0 以前的旧业务库（业务库第 19 版），当前程序不处理它，没有备份。要保存旧数据，请直接复制整个数据目录，或用 0\.8\.4 的程序备份。$/,
    );
    // 不是本系统的库
    const other = join(f.root, 'other.sqlite');
    run('CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)')(other);
    assert.throws(() => validateBusinessDatabase(other), /不是本系统的业务数据库/);
  } finally { f.close(); }
});

test('备份里的配置库损坏、比程序新、是 0.9.0 以前的旧格式：恢复在复制和切换之前拒绝并写明是哪个文件，现有数据不变', async () => {
  const untouched = '现有数据没有改动。';
  /** 表里的值改掉一个字节，索引里的还是原样：文件打得开，但过不了完整性检查 */
  const breakIndex = (path: string) => {
    const bytes = readFileSync(path), at = bytes.indexOf(noteMarker);
    assert.ok(at > 0 && bytes.indexOf(noteMarker, at + 1) > at, '标记在表和索引里各有一份');
    bytes[at] += 1;
    writeFileSync(path, bytes);
  };
  const garbage = (path: string) => writeFileSync(path, '虚构的坏文件，不是数据库');
  const notDatabase = (name: string) => (message: string) =>
    message.startsWith(`备份里的 ${name} 打不开，文件已经损坏或者不是数据库（`) && message.endsWith(`），不能恢复。请换一份备份。${untouched}`);
  const newer = (name: string, label: string, version: number, latest: number) =>
    `备份里的 ${name}（${label}）是第 ${version} 版，比当前程序新（当前程序最多支持第 ${latest} 版），不能恢复。请用更新的程序恢复这份备份。${untouched}`;
  const cases: [name: string, change: (path: string) => void, expected: string | ((message: string) => boolean)][] = [
    ['security/users.sqlite', run('PRAGMA user_version=2'), newer('security/users.sqlite', '账号库', 2, 1)],
    ['notes/notes.sqlite', run('PRAGMA user_version=3'), newer('notes/notes.sqlite', '虚构便签库', 3, 2)],
    [
      // 没记版本却有内容（0.9.0 以前的程序留下的）：恢复以后打开时会被清空重建，所以拒绝
      'ai-imports/workspaces.sqlite',
      run('PRAGMA user_version=0'),
      `备份里的 ai-imports/workspaces.sqlite（AI 识别工作区）是旧版本的库（没有记版本，比第 3 版旧），恢复以后程序打开时会把它清空重建，所以不能恢复。请换一份备份。${untouched}`,
    ],
    [
      // 比基线（第 2 版）旧：恢复以后打开时会被清空重建，所以拒绝
      'notes/notes.sqlite',
      run('PRAGMA user_version=1'),
      `备份里的 notes/notes.sqlite（虚构便签库）是旧版本的库（第 1 版，比第 2 版旧），恢复以后程序打开时会把它清空重建，所以不能恢复。请换一份备份。${untouched}`,
    ],
    ['notes/notes.sqlite', breakIndex, `备份里的 notes/notes.sqlite 没有通过完整性检查，文件已经损坏，不能恢复。请换一份备份。${untouched}`],
    ['security/users.sqlite', garbage, notDatabase('security/users.sqlite')],
    // 没人登记的数据库文件也要通过完整性检查
    ['misc/scraps.sqlite', garbage, notDatabase('misc/scraps.sqlite')],
    ['_extra/local.sqlite', garbage, notDatabase('_extra/local.sqlite')],
  ];
  for (const [name, change, expected] of cases) {
    const f = await configFixture();
    try {
      alterBackupDatabase(f.backup.dir, change, name);
      const before = files(f.target), local = readFileSync(f.local);
      assert.throws(
        () => restoreFullBackup(f.backup.dir, f.target),
        (error: Error) => {
          if (typeof expected === 'string') assert.equal(error.message, expected);
          else assert.ok(expected(error.message), error.message);
          return true;
        },
        name,
      );
      assertTargetUntouched(f, before);
      assert.deepEqual(readFileSync(f.local), local, '数据目录外的本机配置也没动');
      // 恢复到一个还不存在的目录：同样先查完整性，目录不会被建出来
      if (typeof expected !== 'string') {
        const fresh = join(f.root, 'fresh');
        assert.throws(() => restoreFullBackup(f.backup.dir, fresh), (error: Error) => expected(error.message), name);
        assert.equal(existsSync(fresh), false);
      }
    } finally { f.close(); }
  }
});

test('备份里的配置库在基线和当前之间：照常恢复，打开时升级到当前版本，数据还在', async () => {
  const f = await configFixture();
  try {
    const notesFile = join(f.target, 'notes', 'notes.sqlite');
    // 程序已经是第 3 版（这个位置按第 3 版的规格打开过），备份里的便签库还是第 2 版
    openVersionedSqlite(notesFile, fictionalNotesV3).close();
    assert.equal(versionOf(join(f.backup.dir, 'notes', 'notes.sqlite')), 2);
    restoreFullBackup(f.backup.dir, f.target);
    assert.equal(versionOf(notesFile), 2, '恢复只换文件，不升级');
    const notes = openVersionedSqlite(notesFile, fictionalNotesV3);
    try {
      assert.deepEqual({ ...notes.prepare('SELECT body,pinned FROM notes').get() }, { body: noteMarker, pinned: 0 });
    } finally {
      notes.close();
    }
    assert.equal(versionOf(notesFile), 3);
  } finally { f.close(); }
});

test('正常的备份照常恢复：换成备份里的文件（运行标记留着），恢复前的数据留副本，配置库和没人登记的数据库文件都能打开', async () => {
  const f = await configFixture();
  try {
    const manifest = readBackupManifest(f.backup.dir);
    const before = files(f.target), local = readFileSync(f.local);
    const restored = restoreFullBackup(f.backup.dir, f.target);
    assert.equal(restored.files, manifest.files.length);
    assert.deepEqual(restored.integrityOnly.sort(), ['_extra/local.sqlite', 'misc/scraps.sqlite'], '认不出的和 _extra 里的只查完整性');
    assert.deepEqual(files(restored.previous), before, '恢复前的数据留了副本');
    const inData = manifest.files.map((file) => file.path).filter((path) => !path.startsWith('_extra/'));
    assert.deepEqual(
      Object.keys(files(f.target)).map((name) => name.split(sep).join('/')).sort(),
      [...inData, 'erp.sqlite.running'].sort(),
      '备份以外的旧文件清掉了，运行标记留着',
    );
    assert.equal(readFileSync(join(f.target, 'erp.sqlite.running'), 'utf8'), '虚构运行标记');
    for (const path of inData) assert.deepEqual(readFileSync(join(f.target, path)), readFileSync(join(f.backup.dir, path)), path);
    assert.deepEqual(readFileSync(f.local), local, '_extra 里的本机配置不会自动覆盖回去');
    // 恢复出来的库原样打开，内容还在
    const notes = openVersionedSqlite(join(f.target, 'notes', 'notes.sqlite'), fictionalNotes);
    try {
      assert.deepEqual({ ...notes.prepare('SELECT body,tag FROM notes').get() }, { body: noteMarker, tag: null });
    } finally {
      notes.close();
    }
    assert.equal(versionOf(join(f.target, 'notes', 'notes.sqlite')), 2);
    new AuthManager(join(f.target, 'security', 'users.sqlite')).close();
    assert.equal(versionOf(join(f.target, 'security', 'users.sqlite')), 1);
    new ImportRepository(join(f.target, 'ai-imports', 'workspaces.sqlite')).close();
    assert.equal(versionOf(join(f.target, 'misc', 'scraps.sqlite')), 7);
    const store = new Store(join(f.target, 'erp.sqlite'));
    try {
      assert.deepEqual(sales(store).customers().map((customer) => customer.name), ['虚构配置库客户']);
    } finally {
      store.close();
    }
  } finally { f.close(); }
});

test('数据库副本还是 WAL 模式的备份（不是当前程序做的）：恢复在用 SQLite 打开之前就拒绝，备份目录、目标目录一个文件都不多，原有数据不变', async () => {
  const f = await configFixture();
  try {
    const manifest = readBackupManifest(f.backup.dir);
    const databases = manifest.files.map((file) => file.path).filter((path) => path.endsWith('.sqlite')).sort();
    assert.ok(databases.includes('erp.sqlite') && databases.includes('_extra/local.sqlite'));
    for (const name of databases) {
      // 复制一份备份，把其中一个数据库副本的文件头改成 WAL 模式（第 18、19 字节都是 2），清单哈希跟着改对
      const copy = join(f.root, 'wal-' + name.replace(/\W/g, '_'));
      fs.cpSync(f.backup.dir, copy, { recursive: true });
      alterBackupDatabase(copy, (file) => {
        const bytes = readFileSync(file);
        bytes[18] = 2;
        bytes[19] = 2;
        writeFileSync(file, bytes);
      }, name);
      const backupBefore = files(copy), targetBefore = files(f.target), siblings = readdirSync(f.root).sort();
      assert.throws(
        () => restoreFullBackup(copy, f.target),
        (error: Error) => {
          assert.equal(
            error.message,
            `这份备份是旧格式（里面的数据库文件 ${name} 没有整理成单个文件），不能恢复。请用当前版本重新做一次完整备份（npm run backup）；直接复制出来的 erp.sqlite 也不能当备份用。现有数据没有改动。`,
          );
          return true;
        },
      );
      assert.deepEqual(files(copy), backupBefore, name + '：备份目录没有多出 -wal、-shm，一个字节没变');
      assert.deepEqual(files(f.target), targetBefore, name + '：目标目录不变');
      assert.deepEqual(readdirSync(f.root).sort(), siblings, name + '：没有建暂存目录');
    }
    // 单独校验业务库文件也是同一句
    const wal = join(f.root, 'wal-erp_sqlite');
    assert.throws(() => validateBusinessDatabase(join(wal, 'erp.sqlite')), /^Error: 这份备份是旧格式（里面的数据库文件 erp\.sqlite 没有整理成单个文件）/);
    assert.deepEqual(readdirSync(wal).filter((name) => /-(wal|shm)$/.test(name)), []);
  } finally { f.close(); }
});

test('清单里的路径越出备份目录：拒绝恢复，目标目录不会被建出来', async () => {
  const f = await configFixture();
  try {
    const manifestPath = join(f.backup.dir, 'manifest.json');
    const tampered = readBackupManifest(f.backup.dir);
    tampered.files[0].path = '../outside.sqlite';
    writeFileSync(manifestPath, JSON.stringify(tampered));
    assert.throws(() => restoreFullBackup(f.backup.dir, join(f.root, 'rejected')), /无效路径/);
    assert.equal(existsSync(join(f.root, 'rejected')), false);
  } finally { f.close(); }
});

test('备份文件被改过（和清单哈希对不上）：拒绝恢复', async () => {
  const f = await configFixture();
  try {
    writeFileSync(join(f.backup.dir, 'misc', '虚构.bin'), 'tampered');
    const before = files(f.target);
    assert.throws(() => restoreFullBackup(f.backup.dir, f.target), /校验失败/);
    assertTargetUntouched(f, before);
  } finally { f.close(); }
});
