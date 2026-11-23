// 配置库的升级前备份和补丁回滚时的换回（server/core/versioned-sqlite-backup.ts）：拿到写锁以后、第一步之前做好；
// 每个版本对留最新一份、最多 3 个版本对；账号库的备份和换下来的库里都没有登录会话；备份做不成就不升级；
// 换回只动比程序新的库，换下来的留着，位置算不出来、旁边有附属文件的报出来。只用虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountDatabase } from '../server/accounts/account-db.js';
import { openVersionedSqlite } from '../server/core/versioned-sqlite.js';
import { revertConfigUpgrades } from '../server/core/versioned-sqlite-backup.js';
import { VersionedSqliteError, type VersionedSqliteSpec } from '../server/core/versioned-sqlite-spec.js';
import {
  configWorkspace,
  noteSteps,
  notesSpec,
  notesSpecV1,
  notesV1,
  quietLog,
  readDb,
  runSql,
  sha256,
  snapshotDir,
  snapshotNames,
  tableRows,
  userVersion,
} from './config-db-fixture.js';

const mode = (file: string) => statSync(file).mode & 0o777;
const backupIn = (file: string, name: string) => join(snapshotDir(file), name);
/** 换回时要看的位置：都算得出来 */
const at = (...found: { spec: VersionedSqliteSpec; file: string }[]) => ({ found, unresolved: [] });

test('升级前备份在拿到写锁以后、第一步之前做好：内容是升级前的，通过完整性检查，权限和库文件一样', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    notesV1(f.file);
    chmodSync(f.file, 0o600);
    let seenDuringUpgrade: string[] = [];
    const watching = notesSpec({
      steps: [
        {
          ...noteSteps[0],
          up: (db) => {
            seenDuringUpgrade = snapshotNames(f.file);
            noteSteps[0].up(db);
          },
        },
        noteSteps[1],
      ],
    });
    openVersionedSqlite(f.file, watching).close();
    assert.equal(seenDuringUpgrade.length, 1, '第一步跑的时候备份已经在了');
    const backup = backupIn(f.file, seenDuringUpgrade[0]);
    assert.equal(userVersion(backup), 1);
    assert.deepEqual(tableRows(backup, 'notes'), [
      { id: 1, body: '置顶：虚构便签' },
      { id: 2, body: '虚构普通便签' },
    ]);
    assert.deepEqual(readDb(backup, (db) => db.prepare('PRAGMA quick_check').all().map((row) => ({ ...row }))), [{ quick_check: 'ok' }]);
    assert.equal(mode(backup), mode(f.file));
  } finally {
    f.done();
  }
});

/** 以前留下的一份升级前备份的文件名（内容不要紧，清理只看名字） */
const oldBackup = (pair: string, day: number) => `notes-upgrade-${pair}-2026-01-0${day}T00-00-00-000Z-abcdef.sqlite`;

test('同一个版本对连做几次（升级失败、服务反复重启）只留最新一份，更早升级留下的别的版本对还在；.partial 一起删，别的库和别的文件不动', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    notesV1(f.file);
    mkdirSync(snapshotDir(f.file));
    const others = [oldBackup('v1-to-v3', 9) + '.partial', 'other-upgrade-v1-to-v3-2026-01-01T00-00-00-000Z-abcdef.sqlite', '虚构说明.txt'];
    for (const name of [oldBackup('v1-to-v2', 1), oldBackup('v1-to-v3', 2), ...others]) writeFileSync(backupIn(f.file, name), '虚构');
    const failing = notesSpec({ steps: [noteSteps[0], { ...noteSteps[1], up: () => assert.fail('虚构的升级失败') }] });
    for (let restart = 0; restart < 3; restart++) assert.throws(() => openVersionedSqlite(f.file, failing), VersionedSqliteError);
    const left = snapshotNames(f.file);
    const fresh = left.filter((name) => name.startsWith('notes-upgrade-v1-to-v3-') && name !== oldBackup('v1-to-v3', 2));
    assert.equal(fresh.length, 1, '同一个版本对只剩最新做的那一份');
    assert.deepEqual(left, [oldBackup('v1-to-v2', 1), ...fresh, others[1], others[2]].sort());
  } finally {
    f.done();
  }
});

test('每个库文件最多留最近 3 个版本对，超了删最旧的那个版本对', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    notesV1(f.file);
    mkdirSync(snapshotDir(f.file));
    const pairs = [oldBackup('v1-to-v2', 1), oldBackup('v2-to-v3', 2), oldBackup('v3-to-v4', 3)];
    for (const name of pairs) writeFileSync(backupIn(f.file, name), '虚构');
    openVersionedSqlite(f.file, notesSpec()).close();
    const fresh = snapshotNames(f.file).filter((name) => !pairs.includes(name));
    assert.equal(fresh.length, 1);
    assert.deepEqual(snapshotNames(f.file), [pairs[1], pairs[2], ...fresh].sort(), '最旧的 v1-to-v2 删掉了');
  } finally {
    f.done();
  }
});

test('清理旧备份失败不影响这次升级，打一行日志说清是哪个库', (t) => {
  quietLog(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const f = configWorkspace();
  try {
    notesV1(f.file);
    // 要删的那个“旧备份”其实是个目录，删不掉
    for (const name of [oldBackup('v1-to-v2', 1), oldBackup('v2-to-v3', 2), oldBackup('v3-to-v4', 3)])
      mkdirSync(backupIn(f.file, name), { recursive: true });
    openVersionedSqlite(f.file, notesSpec()).close();
    assert.equal(userVersion(f.file), 3);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /^虚构便签库的旧升级前备份没有清掉（.+），下次升级再清：/);
  } finally {
    f.done();
  }
});

/** 账号库加一个虚构的第 2 步（登录记录加一列）：create 跟着加，和走完步骤的一样 */
const accountsV2: VersionedSqliteSpec = {
  ...accountDatabase,
  steps: [{ version: 2, name: '虚构：登录记录加一列', up: (db) => db.exec('ALTER TABLE auth_events ADD COLUMN fictional TEXT') }],
  create(db) {
    accountDatabase.create(db);
    db.exec('ALTER TABLE auth_events ADD COLUMN fictional TEXT');
  },
};
const tokenA = 'fictional-session-token-a-' + 'a'.repeat(38);
const tokenB = 'fictional-session-token-b-' + 'b'.repeat(38);
const sessionCount = (file: string) => readDb(file, (db) => Number(db.prepare('SELECT count(*) AS n FROM auth_sessions').get()?.n));
const noTokens = (file: string, why: string) => {
  const bytes = readFileSync(file).toString('latin1');
  for (const token of [tokenA, tokenB]) assert.ok(!bytes.includes(token), why + '：按字节也找不到会话令牌');
};
/** 第 1 版的账号库：一个虚构管理员，登录着（会话 A） */
function accountsV1(file: string) {
  openVersionedSqlite(file, accountDatabase).close();
  runSql(
    file,
    `INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES('u1','虚构管理员','虚构盐','虚构哈希','[]','super_admin');
     INSERT INTO auth_sessions(token_hash,user_id,expires) VALUES('${tokenA}','u1',4102444800000);`,
  );
}

test('账号库：升级前备份里没有登录会话（按字节也找不到令牌），升级后库里的会话还在', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    accountsV1(f.file);
    openVersionedSqlite(f.file, accountsV2).close();
    const backup = backupIn(f.file, snapshotNames(f.file)[0]);
    assert.equal(userVersion(backup), 1);
    assert.equal(sessionCount(backup), 0);
    assert.equal(tableRows(backup, 'users').length, 1, '账号留着');
    noTokens(backup, '升级前备份');
    assert.equal(sessionCount(f.file), 1, '升级不让人退出登录');
  } finally {
    f.done();
  }
});

test('升级前备份做不成：不升级，库文件不变，拒绝打开并说清原因', () => {
  const f = configWorkspace();
  try {
    notesV1(f.file);
    writeFileSync(snapshotDir(f.file), '占住备份目录位置的虚构文件');
    const before = sha256(f.file);
    assert.throws(
      () => openVersionedSqlite(f.file, notesSpec()),
      (error: Error) =>
        error instanceof VersionedSqliteError &&
        error.message.startsWith('虚构便签库要从第 1 版升级到第 3 版，升级前备份没有做成（') &&
        error.message.includes('没有开始升级') &&
        error.message.includes('文件没有任何改动'),
    );
    assert.equal(sha256(f.file), before);
    assert.equal(userVersion(f.file), 1);
  } finally {
    f.done();
  }
});

test('换回：比程序新的库换回升级前备份，换下来的留在 snapshots 里（权限照原库）；不比程序新的、不存在的不动', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    notesV1(f.file);
    openVersionedSqlite(f.file, notesSpec()).close();
    runSql(f.file, "INSERT INTO notes(id,body) VALUES(3,'新程序运行时写的')");
    const same = join(f.dir, 'same.sqlite');
    notesV1(same);
    const sameBefore = sha256(same);
    const locations = [f.file, same, join(f.dir, 'missing.sqlite')].map((file) => ({ spec: notesSpecV1, file }));
    const { reverted, failed } = revertConfigUpgrades(undefined, at(...locations));
    assert.deepEqual(failed, []);
    assert.equal(reverted.length, 1);
    const [done] = reverted;
    assert.deepEqual({ ...done, backup: '', keptAs: '' }, { label: '虚构便签库', file: f.file, from: 3, to: 1, backup: '', keptAs: '' });
    assert.match(done.backup, /notes-upgrade-v1-to-v3-.*\.sqlite$/);
    assert.match(done.keptAs, /[\\/]snapshots[\\/]notes-before-revert-.*\.sqlite$/);
    assert.equal(userVersion(f.file), 1);
    assert.deepEqual(tableRows(f.file, 'notes').map((row) => row.body), ['置顶：虚构便签', '虚构普通便签']);
    assert.equal(userVersion(done.keptAs), 3);
    assert.equal(tableRows(done.keptAs, 'notes').length, 3, '新程序运行时写的在换下来的那份里');
    assert.equal(mode(done.keptAs), mode(f.file));
    assert.equal(sha256(same), sameBefore);
    openVersionedSqlite(f.file, notesSpecV1).close();
  } finally {
    f.done();
  }
});

test('换回：没有对应的升级前备份就记进 failed，库文件不动；给了时间就只用那以后做的备份', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    runSql(f.file, "CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0); PRAGMA user_version=3;");
    const before = sha256(f.file);
    const none = revertConfigUpgrades(undefined, at({ spec: notesSpecV1, file: f.file }));
    assert.deepEqual(none.reverted, []);
    assert.deepEqual(none.failed.map((x) => x.label), ['虚构便签库']);
    assert.match(none.failed[0].reason, /^它是第 3 版，比当前程序（第 1 版）新，snapshots 里没有从第 1 版升到第 3 版的升级前备份$/);
    assert.equal(sha256(f.file), before);
    // 有一份升级前备份：给的时间在它之后就不用，在它之前才用
    const other = configWorkspace();
    try {
      notesV1(other.file);
      openVersionedSqlite(other.file, notesSpec()).close();
      const here = at({ spec: notesSpecV1, file: other.file });
      const later = revertConfigUpgrades(new Date(Date.now() + 60_000), here);
      assert.match(later.failed[0].reason, /的升级前备份（.+ 以后做的）$/);
      assert.equal(userVersion(other.file), 3);
      const earlier = revertConfigUpgrades(new Date(Date.now() - 60_000), here);
      assert.equal(earlier.reverted.length, 1);
      assert.equal(userVersion(other.file), 1);
    } finally {
      other.done();
    }
  } finally {
    f.done();
  }
});

test('换回账号库：换进去的和换下来留着的那份里都没有登录会话（按字节也找不到令牌）', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    accountsV1(f.file);
    chmodSync(f.file, 0o600);
    openVersionedSqlite(f.file, accountsV2).close();
    runSql(f.file, `INSERT INTO auth_sessions(token_hash,user_id,expires) VALUES('${tokenB}','u1',4102444800000)`);
    assert.equal(sessionCount(f.file), 2, '新程序运行时又登录了一次');
    const { reverted, failed } = revertConfigUpgrades(undefined, at({ spec: accountDatabase, file: f.file }));
    assert.deepEqual(failed, []);
    const { keptAs } = reverted[0];
    assert.equal(userVersion(keptAs), 2);
    assert.equal(sessionCount(keptAs), 0);
    assert.equal(tableRows(keptAs, 'users').length, 1, '账号留着供人工核对');
    noTokens(keptAs, '换下来的账号库');
    assert.equal(mode(keptAs), mode(f.file));
    assert.equal(userVersion(f.file), 1);
    assert.equal(sessionCount(f.file), 0, '换回以后所有人重新登录');
    noTokens(f.file, '换回的账号库');
  } finally {
    f.done();
  }
});

test('换回：库文件旁边还有附属文件（上次没正常关掉）就不换，说清原因，库文件和附属文件都不动', (t) => {
  quietLog(t);
  const f = configWorkspace();
  try {
    notesV1(f.file);
    openVersionedSqlite(f.file, notesSpec()).close();
    writeFileSync(f.file + '-shm', '虚构的附属文件');
    const before = sha256(f.file);
    const { reverted, failed } = revertConfigUpgrades(undefined, at({ spec: notesSpecV1, file: f.file }));
    assert.deepEqual(reverted, []);
    assert.deepEqual(failed, [
      {
        label: '虚构便签库',
        file: f.file,
        reason: '库文件旁边还有 notes.sqlite-shm：上次没有正常关掉，可能有没写完的改动，不能直接换掉。请确认服务已经停止，再交给维护人员处理',
      },
    ]);
    assert.equal(sha256(f.file), before);
    assert.equal(existsSync(f.file + '-shm'), true);
    assert.ok(!snapshotNames(f.file).some((name) => name.includes('before-revert')), '没有换就不留换下来的那份');
  } finally {
    f.done();
  }
});

test('换回：算不出来的默认位置（比如配置目录设错了）不悄悄跳过，列进 failed 并写明原因', () => {
  const { reverted, failed } = revertConfigUpgrades(undefined, {
    found: [],
    unresolved: [{ spec: notesSpecV1, reason: '虚构的配置目录错误' }],
  });
  assert.deepEqual(reverted, []);
  assert.deepEqual(failed, [{ label: '虚构便签库', file: null, reason: '默认位置算不出来（虚构的配置目录错误），看不了它要不要换回' }]);
});
