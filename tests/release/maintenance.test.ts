import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../server/core/db.js';
import { acquireLock } from '../../server/core/lock.js';
import { snapshotBeforeDestructive } from '../../server/core/snapshots.js';
// 订单视图的发货、订料进度和改单核对由单据流转提供（server/core/order-hooks.ts），读写订单要加载它
import '../../server/flow/index.js';
import { SCHEMA_LATEST } from '../../server/core/schema/index.js';
import { snapshotForUpgrade } from '../../server/core/schema/upgrade.js';
import { readBackupManifest } from '../../server/core/backup-manifest.js';
import { alterBackupDatabase, versionOf } from '../backup-fixture.js';

/** 在临时目录里起命令行维护脚本（server/maintenance.ts）；env 把业务库、备份目录这些指进临时目录 */
const runner =
  (dir: string, env: Record<string, string>) =>
  (...args: string[]) =>
    spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('server/maintenance.ts'), ...args], {
      cwd: dir,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });

/** 虚构的配置库：恢复前只看它放在哪、完不完整、记的是第几版，里面的表长什么样不管 */
function fakeConfigDatabase(path: string, version: number) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS fictional(id INTEGER PRIMARY KEY, body TEXT); PRAGMA user_version=' + version);
  } finally {
    db.close();
  }
}

test('备份和恢复演练：数据可恢复，旧库保留，运行中恢复及损坏备份被拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carton-erp-restore-')),
    dbPath = join(dir, 'data', 'erp.sqlite');
  const run = runner(dir, { DB_PATH: dbPath, LOCALAPPDATA: dir, ERP_BACKUP_DIR: join(dir, 'backups') });
  try {
    let store = new Store(dbPath);
    store.saveCustomer({ name: '备份前虚构客户', contact: '', phone: '', address: '', notes: '' });
    store.close();
    const backup = run('backup');
    assert.equal(backup.status, 0, backup.stderr + backup.stdout);
    const file = join(dir, 'backups', readdirSync(join(dir, 'backups'))[0]);
    store = new Store(dbPath);
    store.saveCustomer({ name: '备份后虚构客户', contact: '', phone: '', address: '', notes: '' });
    store.close();
    const unlock = acquireLock(dbPath);
    try {
      assert.equal(run('restore', file).status, 1);
    } finally {
      unlock();
    }
    const restored = run('restore', file);
    assert.equal(restored.status, 0, restored.stderr + restored.stdout);
    store = new Store(dbPath);
    assert.equal(store.customers().length, 1);
    assert.equal(store.customers()[0].name, '备份前虚构客户');
    store.close();
    // 完整恢复把原data目录整体另存为同级目录，不覆盖。
    assert.ok(readdirSync(dir).some((x) => x.includes('before-restore')));
    const broken = join(dir, 'broken.sqlite');
    writeFileSync(broken, 'broken data');
    assert.equal(run('restore', broken).status, 1);
    store = new Store(dbPath);
    assert.equal(store.customers().length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('命令行遇到 0.9.0 以前的库：restore 在动文件之前拒绝并说明原因，文件都不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carton-erp-legacy-')),
    dbPath = join(dir, 'data', 'erp.sqlite');
  try {
    const store = new Store(dbPath);
    store.saveCustomer({ name: '现在的虚构客户', contact: '', phone: '', address: '', notes: '' });
    store.close();
    // 0.9.0 以前的库的样子：没有本系统的标识，版本记录只有两列、到第 19 版
    const legacy = join(dir, 'legacy.sqlite');
    const old = new DatabaseSync(legacy);
    old.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO customers(id,name) VALUES(1,'虚构旧客户');`);
    const record = old.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,datetime('now'))");
    for (let version = 1; version <= 19; version++) record.run(version);
    old.close();
    const current = readFileSync(dbPath);
    const restored = runner(dir, { DB_PATH: dbPath, LOCALAPPDATA: dir })('restore', legacy);
    assert.equal(restored.status, 1, restored.stderr + restored.stdout);
    assert.ok(
      restored.stderr.includes('这是 0.9.0 以前的备份（业务库第 19 版），0.9.0 起业务数据从新库开始，不能恢复；要查看旧数据，请用 0.8.4 的程序恢复到另一个目录。'),
      restored.stderr,
    );
    assert.deepEqual(readFileSync(dbPath), current, '现在的业务库没有被动过');
    assert.deepEqual(readdirSync(join(dir, 'data')).filter((name) => name.includes('restore')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('命令行备份和恢复整份备份：清单记着各配置库的版本；备份里有配置库比程序新、或是 0.9.0 以前的 AI 识别工作区时，在动文件之前拒绝并写明是哪个文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carton-erp-config-restore-')),
    dataDir = join(dir, 'data'),
    dbPath = join(dataDir, 'erp.sqlite'),
    configDir = join(dir, 'config');
  // 命令行不打开任何配置库：认得出备份里的是哪个库，全靠各库的主人模块加载时登记的默认位置
  const run = runner(dir, { DB_PATH: dbPath, LOCALAPPDATA: dir, ERP_CONFIG_DIR: configDir, ERP_BACKUP_DIR: join(dir, 'backups') });
  const database = fakeConfigDatabase;
  try {
    const store = new Store(dbPath);
    store.saveCustomer({ name: '备份前虚构客户', contact: '', phone: '', address: '', notes: '' });
    store.close();
    // 各库按当前程序的版本造：账号库、机器人设置库第 1 版，助手工具设置、提示词库、AI 设置库第 2 版，AI 识别工作区第 3 版
    const latest: Record<string, number> = {
      'security/users.sqlite': 1,
      'ai-tools/tools.sqlite': 2,
      'ai-imports/workspaces.sqlite': 3,
      'ai-prompts/presets.sqlite': 2,
      '_extra/bots.sqlite': 1,
    };
    for (const path of ['security/users.sqlite', 'ai-tools/tools.sqlite', 'ai-imports/workspaces.sqlite', 'ai-prompts/presets.sqlite'])
      database(join(dataDir, path), latest[path]);
    database(join(configDir, 'ai', 'settings.sqlite'), 2);
    database(join(configDir, 'bots', 'bots.sqlite'), 1);
    const backup = run('backup');
    assert.equal(backup.status, 0, backup.stderr + backup.stdout);
    const backupDir = join(dir, 'backups', readdirSync(join(dir, 'backups'))[0]);
    const manifest = readBackupManifest(backupDir);
    assert.deepEqual(
      Object.fromEntries(manifest.files.filter((file) => file.userVersion !== undefined).map((file) => [file.path, file.userVersion])),
      {
        'security/users.sqlite': 1,
        'ai-tools/tools.sqlite': 2,
        'ai-imports/workspaces.sqlite': 3,
        'ai-prompts/presets.sqlite': 2,
        '_extra/ai-settings.sqlite': 2,
        '_extra/bots.sqlite': 1,
      },
    );
    const business = manifest.files.find((file) => file.path === 'erp.sqlite');
    assert.ok(business);
    assert.equal(business.schemaVersion, manifest.schemaVersion);
    /** 把备份里的一个库改成指定的版本，清单里的哈希跟着改对 */
    const setVersion = (name: string, version: number) => alterBackupDatabase(backupDir, (path) => database(path, version), name);
    const current = readFileSync(dbPath);
    const refused = (name: string, version: number, message: string) => {
      setVersion(name, version);
      const result = run('restore', backupDir);
      assert.equal(result.status, 1, name + '\n' + result.stderr + result.stdout);
      assert.ok(result.stderr.includes(message), result.stderr);
      assert.ok(result.stderr.includes('现有数据没有改动。'), result.stderr);
      assert.deepEqual(readFileSync(dbPath), current, '现在的业务库没有被动过');
      assert.deepEqual(readdirSync(dir).filter((entry) => entry.includes('restore')), [], '没有留下恢复用的目录');
      setVersion(name, latest[name]);
    };
    const newer = (name: string, label: string) =>
      refused(name, latest[name] + 1, `备份里的 ${name}（${label}）是第 ${latest[name] + 1} 版，比当前程序新（当前程序最多支持第 ${latest[name]} 版），不能恢复。请用更新的程序恢复这份备份。`);
    // 每个库的位置有没有登记，tests/backup-recovery.test.ts 逐个查过；这里只走命令行特有的路：
    // 助手工具设置库、AI 识别工作区的主人模块是恢复时才加载的
    newer('ai-tools/tools.sqlite', '助手工具设置库');
    refused(
      'ai-imports/workspaces.sqlite',
      0,
      '备份里的 ai-imports/workspaces.sqlite（AI 识别工作区）是旧版本的库（没有记版本，比第 3 版旧），恢复以后程序打开时会把它清空重建，所以不能恢复。请换一份备份。',
    );
    // 都改回去以后照常恢复；_extra 里的本机配置不恢复，比程序新也不拒绝，只查完整性并列出来
    setVersion('_extra/bots.sqlite', latest['_extra/bots.sqlite'] + 1);
    const restored = run('restore', backupDir);
    assert.equal(restored.status, 0, restored.stderr + restored.stdout);
    assert.ok(
      restored.stdout.includes('只查了完整性的文件（认不出是哪个配置库，或是 _extra 里不恢复的本机配置）：\n  _extra/ai-settings.sqlite\n  _extra/bots.sqlite'),
      restored.stdout,
    );
    assert.ok(readdirSync(dir).some((entry) => entry.includes('before-restore')));
    const back = new Store(dbPath);
    try {
      assert.deepEqual(back.customers().map((customer) => customer.name), ['备份前虚构客户']);
    } finally {
      back.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('命令行换回配置库：比程序新的换回补丁开始以后的升级前备份并列出留下的文件；换不回的写明原因、退出码非零', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carton-erp-revert-config-')),
    dataDir = join(dir, 'data');
  const run = runner(dir, { DB_PATH: join(dataDir, 'erp.sqlite'), LOCALAPPDATA: dir, ERP_CONFIG_DIR: join(dir, 'config') });
  const users = join(dataDir, 'security', 'users.sqlite'),
    tools = join(dataDir, 'ai-tools', 'tools.sqlite');
  try {
    // 新程序把账号库升到了第 2 版（当前程序是第 1 版），升级前备份在 snapshots/ 里；补丁开始在备份之前
    fakeConfigDatabase(users, 2);
    const backup = join(dataDir, 'security', 'snapshots', 'users-upgrade-v1-to-v2-2026-11-21T10-00-00-000Z-a1b2c3.sqlite');
    fakeConfigDatabase(backup, 1);
    const nothing = run('revert-config-upgrades', '2026-11-21T11:00:00.000Z');
    assert.equal(nothing.status, 1, '补丁开始以后没有升级前备份：换不回');
    assert.match(nothing.stderr, /账号库没有换回/);
    assert.equal(versionOf(users), 2, '换不回时库不动');
    assert.match(run('revert-config-upgrades', '不是时间').stderr, /时间写法不对/);

    const done = run('revert-config-upgrades', '2026-11-21T09:00:00.000Z');
    assert.equal(done.status, 0, done.stderr + done.stdout);
    assert.match(done.stdout, /账号库已从第 2 版换回第 1 版/);
    assert.match(done.stdout, /所有人要重新登录/);
    assert.equal(versionOf(users), 1);
    const kept = readdirSync(join(dataDir, 'security', 'snapshots')).filter((name) => name.includes('-before-revert-'));
    assert.equal(kept.length, 1, '换下来的库留着');
    assert.equal(versionOf(join(dataDir, 'security', 'snapshots', kept[0])), 2);
    const again = run('revert-config-upgrades');
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /没有比当前程序新的配置库/);

    // 助手工具设置库比程序新、没有升级前备份：列进失败，退出码非零
    fakeConfigDatabase(tools, 3);
    const failed = run('revert-config-upgrades');
    assert.equal(failed.status, 1, failed.stderr + failed.stdout);
    assert.match(failed.stderr, /助手工具设置库没有换回/);
    assert.equal(versionOf(tools), 3);

    // 配置目录设错了：AI 设置库、机器人设置库的默认位置算不出来，写明原因、退出码非零，不悄悄跳过
    rmSync(tools);
    const unresolved = runner(dir, { DB_PATH: join(dataDir, 'erp.sqlite'), LOCALAPPDATA: dir, ERP_CONFIG_DIR: 'config' })('revert-config-upgrades');
    assert.equal(unresolved.status, 1, unresolved.stderr + unresolved.stdout);
    for (const label of ['AI 设置库', '机器人设置库'])
      assert.ok(unresolved.stderr.includes(`${label}没有换回：默认位置算不出来`), unresolved.stderr);
    assert.equal(unresolved.stderr.split('默认位置算不出来').length - 1, 2, '每个库只说一遍：' + unresolved.stderr);
    assert.match(unresolved.stderr, /ERP_CONFIG_DIR 必须是绝对路径/);
    assert.equal(unresolved.stderr.includes('null'), false, unresolved.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('命令行单文件恢复：WAL 模式的文件（直接复制出来的业务库）在打开之前就拒绝；正常恢复和中途失败后数据目录里都没有暂存文件和 -wal、-shm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carton-erp-restore-file-')),
    dataDir = join(dir, 'data'),
    dbPath = join(dataDir, 'erp.sqlite'),
    backups = join(dir, 'backups');
  const run = runner(dir, { DB_PATH: dbPath, LOCALAPPDATA: dir, ERP_BACKUP_DIR: backups });
  const leftovers = () => readdirSync(dataDir).filter((name) => /\.restore-|-wal$|-shm$|-journal$/.test(name));
  try {
    const store = new Store(dbPath);
    store.saveCustomer({ name: '单文件恢复虚构客户', contact: '', phone: '', address: '', notes: '' });
    store.close();
    // 格式正确的单个文件：完整备份里的业务库副本
    const made = run('backup');
    assert.equal(made.status, 0, made.stderr + made.stdout);
    const good = join(backups, readdirSync(backups)[0], 'erp.sqlite');
    const backupFiles = readdirSync(dirname(good)).sort();
    // 直接复制出来的 WAL 模式文件：改文件头第 18、19 字节
    const walDir = join(dir, 'copied');
    mkdirSync(walDir);
    const wal = join(walDir, 'erp.sqlite');
    const bytes = readFileSync(good);
    bytes[18] = 2;
    bytes[19] = 2;
    writeFileSync(wal, bytes);
    const before = readdirSync(dataDir).sort();
    const current = readFileSync(dbPath);
    const refused = run('restore', wal);
    assert.equal(refused.status, 1, refused.stderr + refused.stdout);
    assert.match(
      refused.stderr,
      /这份备份是旧格式（里面的数据库文件 erp\.sqlite 没有整理成单个文件），不能恢复。请用当前版本重新做一次完整备份（npm run backup）；直接复制出来的 erp\.sqlite 也不能当备份用。/,
    );
    assert.deepEqual(readdirSync(walDir), ['erp.sqlite'], '备份所在目录没有多出 -wal、-shm');
    assert.deepEqual(readdirSync(dataDir).sort(), before, '数据目录没有暂存文件');
    assert.deepEqual(readFileSync(dbPath), current, '现有数据不变');

    // 中途失败：Windows 上另一个连接开着业务库时，把它改名挪开会失败（别的系统上改名不受影响，这一段只在 Windows 上跑）
    if (process.platform === 'win32') {
      // 读写连接：关掉时它是最后一个连接，会把业务库自己的 -wal、-shm 收掉，剩下的只可能是恢复留下的
      const holder = new DatabaseSync(dbPath);
      try {
        holder.prepare('SELECT count(*) FROM customers').get();
        const failed = run('restore', good);
        assert.equal(failed.status, 1, failed.stderr + failed.stdout);
        assert.match(failed.stderr, /rename/, '是在复制好暂存文件以后、挪开现有业务库时失败的');
      } finally {
        holder.close();
      }
      assert.deepEqual(leftovers(), [], '中途失败也不留暂存文件：' + leftovers().join('、'));
      assert.deepEqual(readFileSync(dbPath), current);
    }

    const restored = run('restore', good);
    assert.equal(restored.status, 0, restored.stderr + restored.stdout);
    assert.deepEqual(leftovers(), [], '恢复完数据目录里没有暂存文件和 -wal、-shm：' + leftovers().join('、'));
    assert.deepEqual(
      readdirSync(dataDir).filter((name) => !before.includes(name)).map((name) => name.replace(/-\d{4}-.*$/, '')),
      ['erp.sqlite.before-restore'],
      '只多了恢复前那一份',
    );
    assert.deepEqual(readdirSync(dirname(good)).sort(), backupFiles, '备份目录没有多出 -wal、-shm');
    const back = new Store(dbPath);
    try {
      assert.equal(back.customers()[0].name, '单文件恢复虚构客户');
    } finally {
      back.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('程序自动拍的快照（删除前、初始化前、升级前）都是单个文件，能用命令行单文件恢复恢复回来，数据目录不留暂存文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carton-erp-restore-snapshot-')),
    dataDir = join(dir, 'data'),
    dbPath = join(dataDir, 'erp.sqlite');
  const run = runner(dir, { DB_PATH: dbPath, LOCALAPPDATA: dir, ERP_BACKUP_DIR: join(dir, 'backups') });
  const names = () => {
    const store = new Store(dbPath);
    try {
      return store.customers().map((customer) => customer.name).sort();
    } finally {
      store.close();
    }
  };
  const journal = (file: string) => {
    const head = readFileSync(file);
    return [head[18], head[19]];
  };
  try {
    const store = new Store(dbPath);
    store.saveCustomer({ name: '快照前虚构客户甲', contact: '', phone: '', address: '', notes: '' });
    // 删除、初始化前拍的快照
    const destructive = snapshotBeforeDestructive(store, 'delete');
    assert.ok(destructive);
    store.saveCustomer({ name: '快照后虚构客户乙', contact: '', phone: '', address: '', notes: '' });
    store.close();
    // 升级前拍的快照（和 openBusinessDatabase 升级前用的是同一个函数）
    const upgrade = snapshotForUpgrade(dbPath, SCHEMA_LATEST, SCHEMA_LATEST + 1);
    for (const file of [destructive, upgrade]) assert.deepEqual(journal(file), [1, 1], file + ' 是回滚日志模式，过得了文件头检查');
    const before = readdirSync(dataDir).sort();
    const snapshotDir = readdirSync(join(dataDir, 'snapshots')).sort();

    const back = run('restore', destructive);
    assert.equal(back.status, 0, back.stderr + back.stdout);
    assert.deepEqual(names(), ['快照前虚构客户甲']);
    const again = run('restore', upgrade);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.deepEqual(names(), ['快照前虚构客户甲', '快照后虚构客户乙']);

    assert.deepEqual(readdirSync(dataDir).filter((name) => /\.restore-|-wal$|-shm$|-journal$/.test(name)), [], '数据目录不留暂存文件和 -wal、-shm');
    assert.deepEqual(
      readdirSync(dataDir).filter((name) => !before.includes(name)).map((name) => name.replace(/-\d{4}-.*$/, '')),
      ['erp.sqlite.before-restore', 'erp.sqlite.before-restore'],
      '每次恢复只多出恢复前那一份',
    );
    assert.deepEqual(readdirSync(join(dataDir, 'snapshots')).sort(), snapshotDir, '快照目录里没有多出 -wal、-shm');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
