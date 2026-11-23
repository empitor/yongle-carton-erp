// 做完整备份：带上哪些文件、清单记什么、数据库副本整理成单个文件；自动备份的调度、复制到另一个目录和按份数清理。
import { sales } from '../server/sales/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  Store,
  defaultDbPath,
  createFullBackup,
  restoreFullBackup,
  readBackupManifest,
  autoBackupFailure,
  scheduleDailyBackup,
  validateBusinessDatabase,
} from '../server/core/index.js';
import { checkVersionedSqlite } from '../server/core/backup/versioned-sqlite.js';
import { promptModules } from '../shared/ai/index.js';
import { copyAutomaticBackup } from '../server/core/backup/backup-auto.js';
import { supportedDatabaseVersions } from '../server/core/backup/backup-check.js';
import { APP_VERSION } from '../shared/core/version.js';
import { customerSchema } from '../shared/core/domain.js';
import { AuthManager } from '../server/accounts/index.js';
import { InboxService } from '../server/inbox/service.js';
import * as ai from '../server/ai/index.js';
import * as inbox from '../server/inbox/index.js';
import * as assistant from '../server/assistant/index.js';
import '../server/import/index.js';
import { configFixture, files, run } from './backup-fixture.js';

test('完整备份的清单记下每个数据库文件的版本：业务库记结构版本，其余各记自己的 user_version', async () => {
  const f = await configFixture();
  try {
    const manifest = readBackupManifest(f.backup.dir);
    const latest = Math.max(...supportedDatabaseVersions);
    const recorded = Object.fromEntries(
      manifest.files.map((file) => [
        file.path,
        [file.schemaVersion === undefined ? null : '结构第 ' + file.schemaVersion + ' 版', file.userVersion === undefined ? null : 'user_version ' + file.userVersion],
      ]),
    );
    assert.deepEqual(recorded, {
      'erp.sqlite': ['结构第 ' + latest + ' 版', null],
      'security/users.sqlite': [null, 'user_version 1'],
      'ai-imports/workspaces.sqlite': [null, 'user_version 3'],
      'notes/notes.sqlite': [null, 'user_version 2'],
      'misc/scraps.sqlite': [null, 'user_version 7'],
      'misc/虚构.bin': [null, null],
      '_extra/local.sqlite': [null, 'user_version 2'],
    });
    assert.equal(manifest.schemaVersion, latest);
    assert.equal(manifest.appVersion, APP_VERSION);
    // 读配置库的版本没有在备份目录里留下清单以外的文件
    assert.deepEqual(
      Object.keys(files(f.backup.dir)).map((name) => name.split(sep).join('/')).sort(),
      [...manifest.files.map((file) => file.path), 'manifest.json'].sort(),
    );
  } finally { f.close(); }
});

test('Linux：复制目录和本地备份目录只差大小写算两个目录，照常复制', { skip: process.platform !== 'linux' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-case-backup-'));
  try {
    const source = join(dir, 'Backup', 'auto-fictional');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'fictional.txt'), '虚构备份');
    await copyAutomaticBackup(source, join(dir, 'backup'));
    assert.equal(readFileSync(join(dir, 'backup', 'auto-fictional', 'fictional.txt'), 'utf8'), '虚构备份');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('各配置库的主人模块加载时登记了默认位置：恢复备份的命令行不打开任何配置库，也认得出备份里的是哪个库', () => {
  // server/maintenance.ts 恢复整份备份时加载基础、账号、AI 接入、识别导入（含收件箱）、助手
  const dir = mkdtempSync(join(tmpdir(), 'erp-config-homes-'));
  try {
    const candidate = join(dir, 'candidate.sqlite');
    run('CREATE TABLE anything(id INTEGER PRIMARY KEY); PRAGMA user_version=99')(candidate);
    // 数据目录里的按备份里的相对路径拼（恢复时就是这样找的），配置目录里的两个是备份时放进 _extra 的
    const dataDir = dirname(defaultDbPath);
    const homes: [home: string, label: string][] = [
      [join(dataDir, 'security', 'users.sqlite'), '账号库'],
      [join(dataDir, 'ai-tools', 'tools.sqlite'), '助手工具设置库'],
      [join(dataDir, 'ai-imports', 'workspaces.sqlite'), 'AI 识别工作区'],
      ...promptModules.map((module): [string, string] => [join(dataDir, 'ai-prompts', module.storageFile), '提示词库']),
      [ai.defaultAiSettingsPath(), 'AI 设置库'],
      [inbox.defaultBotSettingsPath(), '机器人设置库'],
    ];
    assert.equal(assistant.defaultAssistantToolsPath(), homes[1][0]);
    assert.ok(promptModules.length > 0, '每个提示词模块一个文件，都要认得');
    for (const [home, label] of homes) {
      const seen = checkVersionedSqlite(candidate, home);
      assert.deepEqual(seen && { label: seen.label, version: seen.version, state: seen.state }, { label, version: 99, state: 'newer' }, home);
    }
    // Windows 上路径不分大小写
    if (process.platform === 'win32') assert.equal(checkVersionedSqlite(candidate, homes[0][0].toUpperCase())?.label, '账号库');
    assert.equal(checkVersionedSqlite(candidate, join(dir, 'nobody.sqlite')), null, '没登记过的位置不认，恢复时只查完整性');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('完整备份带上账号、收件箱原件、识别工作区，不带运行标记、快照和误放进来的凭据主密钥（点名要带也拒绝）；连接没关时 WAL 里的提交也进备份；恢复出来的账号库没有会话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-backup-content-')),
    data = join(dir, 'data');
  try {
    const store = new Store(join(data, 'erp.sqlite'));
    sales(store).createCustomer(customerSchema.parse({ name: '虚构备份客户' }));
    const file = { name: '虚构附件.bin', mime: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) };
    const inboxId = Number(
      new InboxService(store).ingest({ channel: 'manual', externalId: 'fictional-inbox', kind: 'file', receivedAt: '2026-11-05T10:00:00Z', file }).id,
    );
    const auth = new AuthManager(join(data, 'security', 'users.sqlite'));
    // 只为看会话会不会跟着备份走，不建账号：临时关掉外键检查直接写一条
    auth.db.exec("PRAGMA foreign_keys=OFF; INSERT INTO auth_sessions(token_hash,user_id,expires) VALUES('fictional-token-hash','fictional-user',1); PRAGMA foreign_keys=ON;");
    mkdirSync(join(data, 'ai-imports', 'files'), { recursive: true });
    writeFileSync(join(data, 'ai-imports', 'files', 'a.bin'), 'fictional-original');
    writeFileSync(join(data, 'erp.sqlite.running'), '1');
    mkdirSync(join(data, 'snapshots'));
    writeFileSync(join(data, 'snapshots', 'erp-old.sqlite'), 'skip');
    const key = join(data, 'credentials', 'master.key');
    mkdirSync(dirname(key));
    writeFileSync(key, randomBytes(32));
    // 不关连接就备份
    const result = await createFullBackup({ dataDir: data, backupRoot: join(dir, 'backups') });
    store.close();
    auth.close();
    assert.ok(existsSync(join(result.dir, 'security', 'users.sqlite')));
    assert.ok(existsSync(join(result.dir, 'ai-imports', 'files', 'a.bin')));
    assert.ok(!existsSync(join(result.dir, 'erp.sqlite.running')));
    assert.ok(!existsSync(join(result.dir, 'snapshots')));
    const manifest = readBackupManifest(result.dir);
    assert.ok(manifest.files.every((f) => !f.path.includes('master.key')));
    await assert.rejects(createFullBackup({ dataDir: data, backupRoot: join(dir, 'backups'), extraFiles: { 'master.key': key } }), /主密钥不能进入/);
    const fresh = join(dir, 'fresh');
    restoreFullBackup(result.dir, fresh);
    const back = new Store(join(fresh, 'erp.sqlite'));
    try {
      assert.deepEqual(sales(back).customers().map((c) => c.name), ['虚构备份客户']);
      const restoredInbox = new InboxService(back);
      assert.equal(restoredInbox.get(inboxId).externalId, 'fictional-inbox');
      assert.deepEqual(restoredInbox.file(inboxId).content, file.bytes);
    } finally {
      back.close();
    }
    const users = new DatabaseSync(join(fresh, 'security', 'users.sqlite'), { readOnly: true });
    try {
      assert.equal(users.prepare('SELECT count(*) AS n FROM auth_sessions').get()?.n, 0, '会话不跟着备份走');
    } finally {
      users.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('备份里的数据库副本都是回滚日志模式：只读校验、恢复前检查都不会在备份目录里留下 -wal、-shm，文件和清单哈希不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-backup-journal-')),
    data = join(dir, 'data');
  /** SQLite 文件头第 18、19 字节：1 是回滚日志，2 是 WAL */
  const journal = (file: string) => {
    const head = readFileSync(file);
    return [head[18], head[19]];
  };
  const sidecars = (root: string) => Object.keys(files(root)).filter((name) => /-(wal|shm|journal)$/.test(name));
  try {
    const store = new Store(join(data, 'erp.sqlite'));
    sales(store).createCustomer(customerSchema.parse({ name: '虚构备份客户' }));
    const auth = new AuthManager(join(data, 'security', 'users.sqlite'));
    // 一个没人登记的 WAL 模式数据库文件：备份照样复制，副本也要切成回滚日志
    mkdirSync(join(data, 'misc'));
    const other = new DatabaseSync(join(data, 'misc', 'fictional.sqlite'));
    other.exec("PRAGMA journal_mode=WAL; CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes(body) VALUES('虚构内容');");
    assert.deepEqual(journal(join(data, 'erp.sqlite')), [2, 2], '正在用的业务库是 WAL 模式');
    const result = await createFullBackup({ dataDir: data, backupRoot: join(dir, 'backups') });
    other.close();
    auth.close();
    store.close();
    const manifest = readBackupManifest(result.dir);
    const databases = manifest.files.filter((file) => file.path.endsWith('.sqlite')).map((file) => file.path).sort();
    assert.deepEqual(databases, ['erp.sqlite', 'misc/fictional.sqlite', 'security/users.sqlite']);
    for (const name of databases) assert.deepEqual(journal(join(result.dir, name)), [1, 1], name + ' 的副本是回滚日志模式');
    for (const file of manifest.files)
      assert.equal(createHash('sha256').update(readFileSync(join(result.dir, file.path))).digest('hex'), file.sha256, '清单里的哈希是切换以后算的：' + file.path);
    assert.deepEqual(sidecars(result.dir), []);
    const before = files(result.dir);
    // 只读校验和恢复前检查（恢复到一个新目录）
    validateBusinessDatabase(join(result.dir, 'erp.sqlite'));
    restoreFullBackup(result.dir, join(dir, 'restored'));
    assert.deepEqual(sidecars(result.dir), [], '备份目录里没有多出 -wal、-shm');
    assert.deepEqual(files(result.dir), before, '备份目录里的文件一个字节没变');
    // 恢复出来的业务库照常打开，程序会重新设成 WAL
    const back = new Store(join(dir, 'restored', 'erp.sqlite'));
    try {
      assert.equal(sales(back).customers()[0].name, '虚构备份客户');
      assert.equal(back.db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    } finally {
      back.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自动备份的复制：可以重复执行，按份数清理复制目录里的旧自动备份，别的文件不动；和本地备份目录相同时拒绝', async () => {
  const f = await configFixture();
  try {
    // 自动备份按名字认（auto-时间-随机号）：把这份备份改成自动备份的名字
    const source = join(dirname(f.backup.dir), 'auto-2026-11-14T00-00-00-000Z-abcdef');
    renameSync(f.backup.dir, source);
    const replica = join(f.root, 'replica');
    const oldCopy = join(replica, 'auto-2000-01-01T00-00-00-000Z-000000');
    mkdirSync(oldCopy, { recursive: true });
    mkdirSync(join(replica, 'keep-other-files'));
    await copyAutomaticBackup(source, replica);
    await copyAutomaticBackup(source, replica);
    assert.ok(existsSync(oldCopy), '没给份数不清理');
    await copyAutomaticBackup(source, replica, 1);
    assert.equal(existsSync(oldCopy), false);
    assert.ok(existsSync(join(replica, 'keep-other-files')));
    assert.deepEqual(files(join(replica, 'auto-2026-11-14T00-00-00-000Z-abcdef')), files(source));
    await assert.rejects(copyAutomaticBackup(source, dirname(source)), /备份复制目录须与本地备份目录不同/);
  } finally { f.close(); }
});

/** 等到 done() 成立（自动备份在计时器里异步跑，用真实的 setImmediate 让它跑完），最多等 30 秒 */
async function until(done: () => boolean) {
  const started = performance.now();
  while (!done()) {
    if (performance.now() - started > 30_000) throw new Error('等太久了');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('自动备份调度：启动一分钟后做第一份；24 小时内不重做但配置了复制目录照样复制；失败记下、下次成功清掉；按份数清理', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-auto-schedule-'));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const stops: (() => void)[] = [];
  try {
    const data = join(dir, 'data'), backups = join(dir, 'backups'), replica = join(dir, 'replica');
    new Store(join(data, 'erp.sqlite')).close();
    // 本地已有 14 份两天前的自动备份（名字更早）
    mkdirSync(backups);
    const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000;
    const old = Array.from({ length: 14 }, (_, i) => `auto-2000-01-${String(i + 10).padStart(2, '0')}T00-00-00-000Z-000000`);
    for (const name of old) mkdirSync(join(backups, name)), utimesSync(join(backups, name), twoDaysAgo, twoDaysAgo);
    const autos = () => readdirSync(backups).filter((n) => n.startsWith('auto-') && !n.endsWith('.partial')).sort();
    const errors: Error[] = [];
    /** 停掉最近起的那个调度 */
    const stopLast = () => {
      const stop = stops.pop();
      assert.ok(stop);
      stop();
    };
    stops.push(scheduleDailyBackup({ dataDir: data, backupRoot: backups, onError: (e) => errors.push(e) }));
    t.mock.timers.tick(59_000);
    assert.deepEqual(autos(), old, '一分钟之前不做');
    t.mock.timers.tick(1_000);
    await until(() => autos().length === 14 && !autos().includes(old[0]));
    const first = autos().at(-1);
    assert.ok(first);
    assert.ok(!old.includes(first), '做了一份新的');
    assert.equal(autos().length, 14, '超过 14 份清掉最早的');
    // 之后每小时看一次：24 小时内不重做
    t.mock.timers.tick(3600_000);
    assert.equal(autos().at(-1), first);
    stopLast();

    // 配置了复制目录：本地这份还新鲜，不重做，只复制
    stops.push(scheduleDailyBackup({ dataDir: data, backupRoot: backups, copyDir: replica, copyKeep: 3 }));
    t.mock.timers.tick(60_000);
    await until(() => existsSync(join(replica, first)));
    assert.equal(autos().at(-1), first);
    stopLast();

    // 失败：备份目录被一个文件占住，记下失败；挪开以后下一次成功，记录清掉
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, '占住备份目录');
    stops.push(scheduleDailyBackup({ dataDir: data, backupRoot: blocked, onError: (e) => errors.push(e) }));
    t.mock.timers.tick(60_000);
    await until(() => errors.length > 0);
    assert.equal(autoBackupFailure()?.message, errors[0].message);
    rmSync(blocked);
    t.mock.timers.tick(3600_000);
    await until(() => autoBackupFailure() === null);
    assert.equal(readdirSync(blocked).filter((n) => n.startsWith('auto-')).length, 1);
  } finally {
    stops.forEach((stop) => stop());
    t.mock.timers.reset();
    // Windows 上最后一次备份的文件句柄要等事件循环转几圈才放掉
    await until(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    });
  }
});
