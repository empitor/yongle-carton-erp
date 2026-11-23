// 补丁脚本的纯逻辑：回滚时先换回配置库、再处理业务库（scripts/linux/patch-rollback.mjs、patch-logic.mjs），补丁锁。
// 脚本不能引 server 代码，备份文件名、配置目录的规则各写了一份：这里拿程序真做出来的结果核对两边对得上。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { configDirectory, openVersionedSqlite } from '../../server/core/index.js';
import { quietLog } from '../support/config-db-fixture.js';
import { patchLogic, patchRollback, projectRoot, type RollbackContext, type RollbackIo, type SchemaState } from '../support/patch-scripts-fixture.js';

/** 0.9.0 的 erp.sh 的分支（还没有换回配置库的命令） */
const oldErpSh = [
  'case "$action" in',
  '  start) entry=server/index.ts ;;',
  '  stop) entry=server/stop.ts ;;',
  '  backup|restore|reset-password) entry=server/maintenance.ts; set -- "$action" "$@" ;;',
  "  *) echo '用法：erp.sh start|stop|backup|restore 备份目录|reset-password 用户名' >&2; exit 2 ;;",
  'esac',
].join('\n');
const newErpSh = readFileSync(join(projectRoot, 'scripts/linux/erp.sh'), 'utf8');

const v20: SchemaState = { exists: true, versions: [20] };
const v21: SchemaState = { exists: true, versions: [20, 21] };
/** 虚构的配置库，从第 1 版加一步升到第 2 版 */
const addTag = (db: DatabaseSync) => db.exec('ALTER TABLE notes ADD COLUMN tag TEXT');
const notesV1 = { label: '虚构便签库', baseline: 1, steps: [], create: (db: DatabaseSync) => db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)') };
const notesV2 = {
  ...notesV1,
  steps: [{ version: 2, name: '虚构便签加标签', up: addTag }],
  create(db: DatabaseSync) {
    notesV1.create(db);
    addTag(db);
  },
};

/**
 * 虚构的数据目录和配置目录。upgrade 用程序真打开一次、真升级一次，留下程序自己命名的升级前备份；
 * startedAt 是升级之前的时间（补丁开始），readVersion 照实读库文件的版本
 */
function serverDirs() {
  const root = mkdtempSync(join(tmpdir(), 'erp-rollback-'));
  const data = join(root, 'data'),
    config = join(root, 'config');
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const versions = new Map<string, number | null>();
  const upgrade = (file: string, { fail = false } = {}) => {
    mkdirSync(dirname(file), { recursive: true });
    openVersionedSqlite(file, notesV1).close();
    const failing = { ...notesV2, steps: [{ ...notesV2.steps[0], up: () => { throw new Error('虚构的升级失败'); } }] };
    if (fail) assert.throws(() => openVersionedSqlite(file, failing), /虚构的升级失败/);
    else openVersionedSqlite(file, notesV2).close();
    versions.set(file, fail ? 1 : 2);
  };
  return {
    data,
    config,
    startedAt,
    upgrade,
    setVersion: (file: string, version: number | null) => versions.set(file, version),
    readVersion: (file: string) => versions.get(file) ?? null,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 回滚的数据步骤：记下按什么顺序调了哪几样、给人看了什么 */
function rollbackRun(
  dirs: ReturnType<typeof serverDirs>,
  erpSh: string,
  options: { revert?: number; schemaAfter?: SchemaState; roots?: (string | null)[] } = {},
) {
  const calls: string[] = [],
    lines: string[] = [];
  const ctx: RollbackContext = { startedAt: dirs.startedAt, schemaBefore: v20, backupDir: '/虚构/backups/full-x', backupRoot: '/虚构/backups', port: '3001' };
  const io: RollbackIo = {
    readErpSh: () => erpSh,
    roots: options.roots ?? [dirs.data, dirs.config],
    revert: () => {
      calls.push('换回配置库');
      return options.revert ?? 0;
    },
    readVersion: dirs.readVersion,
    readSchema: () => {
      calls.push('读业务库版本');
      return options.schemaAfter ?? v20;
    },
    restoreDatabase: () => {
      calls.push('恢复业务库');
      return true;
    },
    warn: (...text) => {
      lines.push(...text);
    },
  };
  return { calls, text: () => lines.join('\n'), run: async () => (await patchRollback()).rollbackData(ctx, io) };
}

test('回滚脚本认得出程序真做出来的配置库升级前备份：库、从第几版、到第几版都对；补丁开始以后做的才算', async (t) => {
  quietLog(t);
  const { configUpgradeBackups } = await patchRollback();
  const dirs = serverDirs();
  try {
    const file = join(dirs.config, 'ai', 'settings.sqlite');
    dirs.upgrade(file);
    const found = configUpgradeBackups([dirs.data, dirs.config], new Date(dirs.startedAt));
    assert.deepEqual(found.map(({ database, from, to }) => ({ database, from, to })), [{ database: file, from: 1, to: 2 }]);
    assert.deepEqual(configUpgradeBackups([dirs.data, dirs.config], new Date(Date.now() + 60_000)), [], '补丁开始以前的不算');
  } finally {
    dirs.close();
  }
});

test('回滚脚本定配置目录和程序的规则一样：同样的输入结果相同，相对路径两边都拒绝', async () => {
  const { configDirOf } = await patchLogic();
  const home = '/var/lib/yongle';
  const passwd = `root:x:0:0::/root:/bin/sh\nyongle-erp:x:999:999::${home}:/usr/sbin/nologin\n`;
  const cases: Record<string, string>[] = [
    { ERP_CONFIG_DIR: '/srv/config/' },
    { ERP_CONFIG_DIR: '/srv/a/../config', XDG_CONFIG_HOME: '/srv/xdg' },
    { XDG_CONFIG_HOME: '/srv/xdg' },
    {},
    { ERP_CONFIG_DIR: 'config' },
    { XDG_CONFIG_HOME: 'xdg' },
  ];
  for (const env of cases) {
    const label = JSON.stringify(env);
    let program: string | Error;
    try {
      program = configDirectory('linux', env, home);
    } catch (error) {
      program = error instanceof Error ? error : new Error(String(error));
    }
    if (program instanceof Error) assert.throws(() => configDirOf(env, passwd), { message: program.message }, label);
    else assert.equal(configDirOf(env, passwd), program, label);
  }
  assert.equal(configDirOf({}, ''), null, '查不到服务账号的家目录就定不下');
});

test('认得出换回来的旧程序有没有换回配置库的命令', async () => {
  const { hasRevertCommand } = await patchRollback();
  assert.equal(hasRevertCommand(newErpSh), true, '现在的 erp.sh 有这个动作');
  assert.equal(hasRevertCommand(oldErpSh), false, '0.9.0 的没有');
  assert.equal(hasRevertCommand("echo '用法：revert-config-upgrades'"), false, '只认分支，不认提示文字');
});

test('旧程序有换回命令且成功：先换回配置库，再按业务库版本恢复，然后可以启动', async () => {
  const dirs = serverDirs();
  try {
    const r = rollbackRun(dirs, newErpSh, { schemaAfter: v21 });
    assert.equal(await r.run(), true);
    assert.deepEqual(r.calls, ['换回配置库', '读业务库版本', '恢复业务库'], '配置库在业务库之前');
  } finally {
    dirs.close();
  }
});

test('旧程序有换回命令但失败：服务保持停止，手动步骤只列还没换回的库，写明业务库要不要恢复，编号不重复', async (t) => {
  quietLog(t);
  const dirs = serverDirs();
  try {
    const users = join(dirs.data, 'security', 'users.sqlite'),
      bots = join(dirs.config, 'bots', 'bots.sqlite');
    dirs.upgrade(users);
    dirs.upgrade(bots);
    dirs.setVersion(bots, 1); // 命令已经换回了机器人设置库
    const same = rollbackRun(dirs, newErpSh, { revert: 1 });
    assert.equal(await same.run(), false);
    assert.deepEqual(same.calls, ['换回配置库', '读业务库版本'], '只读看一眼业务库，不恢复');
    const text = same.text();
    assert.match(text, /换回配置库失败/);
    assert.match(text, /服务保持停止/);
    assert.match(text, /已经换回的库看上面的输出，下面只列还没换回的/);
    assert.ok(
      text.split('\n').some((line) => line.includes('cp -p ') && line.includes('users-upgrade-v1-to-v2-') && line.endsWith(' ' + users)),
      '手动步骤里有把升级前备份复制回账号库的命令：' + text,
    );
    assert.equal(text.includes(bots), false, '已经换回的不列');
    assert.match(text, /-wal、-shm、-journal/);
    assert.match(text, /不要删/);
    assert.match(text, /业务库没变.*换完配置库直接启动/);
    assert.equal(text.includes('erp.sh restore'), false);
    const steps = text.match(/^ {2}\d+\./gm) ?? [];
    assert.deepEqual(steps.map((step) => step.trim()), ['1.', '2.', '3.', '4.'], '编号接着往下排，不重复');

    const changed = rollbackRun(dirs, newErpSh, { revert: 1, schemaAfter: v21 });
    assert.equal(await changed.run(), false);
    assert.deepEqual(changed.calls, ['换回配置库', '读业务库版本']);
    assert.match(changed.text(), /业务库变了.*第 20 版变成第 21 版.*接着做下面的恢复/);
    assert.match(changed.text(), /3\. sudo -u yongle-erp \S+erp\.sh restore \/虚构\/backups\/full-x/);
    assert.deepEqual((changed.text().match(/^ {2}\d+\./gm) ?? []).map((step) => step.trim()), ['1.', '2.', '3.', '4.', '5.']);
  } finally {
    dirs.close();
  }
});

test('旧程序有换回命令但失败、接着又读不出库的版本：留住“换回失败”，补丁后的备份全列出来并写明不确定，服务保持停止', async (t) => {
  quietLog(t);
  const dirs = serverDirs();
  try {
    const users = join(dirs.data, 'security', 'users.sqlite'),
      bots = join(dirs.config, 'bots', 'bots.sqlite');
    dirs.upgrade(users);
    dirs.upgrade(bots);
    dirs.setVersion(users, null); // 比如库旁边有热日志，只读打不开
    const r = rollbackRun(dirs, newErpSh, { revert: 1 });
    assert.equal(await r.run(), false);
    assert.deepEqual(r.calls, ['换回配置库', '读业务库版本'], '命令跑过；只读看一眼业务库，不恢复');
    const text = r.text();
    assert.match(text, /换回配置库失败（原因见上面的输出）/);
    assert.match(text, /已经换回的库看上面的输出/);
    assert.match(text, new RegExp(`读不出 .+users\\.sqlite 的版本.*下面这些不确定是否已经换回，逐个确认后再换`));
    assert.match(text, /2\. 下面这些不确定是否已经换回/);
    for (const [file, backup] of [[users, 'users-upgrade-v1-to-v2-'], [bots, 'bots-upgrade-v1-to-v2-']])
      assert.ok(
        text.split('\n').some((line) => line.includes('cp -p ') && line.includes(backup) && line.endsWith(' ' + file)),
        '读得出、读不出的都列出来：' + text,
      );
    assert.equal(text.includes('没有找到还要换回的'), false, '不能说成没有备份');
    assert.match(text, /服务保持停止/);
  } finally {
    dirs.close();
  }
});

test('旧程序没有换回命令：补丁后没有配置库真升级过就照常回滚，有就停住转人工并列出这几个文件', async (t) => {
  quietLog(t);
  const dirs = serverDirs();
  try {
    // 升级失败退回的库还是旧版本，留下的升级前备份不算
    dirs.upgrade(join(dirs.data, 'security', 'users.sqlite'), { fail: true });
    const plain = rollbackRun(dirs, oldErpSh);
    assert.equal(await plain.run(), true);
    assert.deepEqual(plain.calls, ['读业务库版本'], '旧程序没有命令，不去调');
    assert.match(plain.text(), /没有配置库升级到新版本，不用换回/);

    const settings = join(dirs.config, 'ai', 'settings.sqlite');
    dirs.upgrade(settings);
    const stuck = rollbackRun(dirs, oldErpSh);
    assert.equal(await stuck.run(), false);
    assert.deepEqual(stuck.calls, ['读业务库版本'], '服务保持停止，不恢复业务库');
    const text = stuck.text();
    assert.match(text, /旧程序打不开它们/);
    assert.ok(text.includes(`${settings}（第 1 版升到第 2 版`), text);
    assert.equal(text.includes('users-upgrade'), false, '升级失败的不列');

    dirs.setVersion(settings, null);
    const unreadable = rollbackRun(dirs, oldErpSh);
    assert.equal(await unreadable.run(), false, '读不出库的版本就转人工');
    assert.match(unreadable.text(), /查配置库要不要换回时出错：读不出 \S+ 的版本/);

    const unknown = rollbackRun(dirs, oldErpSh, { roots: [dirs.data, null] });
    assert.equal(await unknown.run(), false, '定不下配置目录就查不清，转人工');
    assert.match(unknown.text(), /定不下配置目录/);
  } finally {
    dirs.close();
  }
});

/** 补丁锁文件的内容 */
const lockHolder = (file: string) =>
  z.looseObject({ pid: z.number(), patch: z.string().optional() }).parse(JSON.parse(readFileSync(file, 'utf8')));

test('补丁回滚：结构版本变了才恢复数据库，判断不了就要求手动处理', async () => {
  const { rollbackPlan, manualSteps, parseBackupDir, parseEnv, patchTarget } = await patchLogic();
  const v18 = { exists: true, versions: Array.from({ length: 18 }, (_, i) => i + 1) };
  const v19 = { exists: true, versions: [...v18.versions, 19] };
  const backupDir = '/var/lib/yongle-carton-erp/backups/full-2026-11-08T00-00-00-000Z-abcdef';
  assert.equal(rollbackPlan({ before: v18, after: { ...v18, versions: [...v18.versions] }, backupDir }).action, 'files-only');
  assert.equal(rollbackPlan({ before: v18, after: v18, backupDir: null }).action, 'files-only', '没升级时不需要备份');
  const restore = rollbackPlan({ before: v18, after: v19, backupDir });
  assert.equal(restore.action, 'restore-db');
  assert.match(restore.reason, /第 18 版变成第 19 版/);
  assert.equal(rollbackPlan({ before: v18, after: v19, backupDir: null }).action, 'manual');
  assert.equal(rollbackPlan({ before: v18, after: null, backupDir }).action, 'manual');
  assert.equal(rollbackPlan({ before: null, after: v19, backupDir }).action, 'manual');
  assert.equal(rollbackPlan({ before: v18, after: { exists: false, versions: [] }, backupDir }).action, 'manual');
  const steps = manualSteps({ backupDir, backupRoot: '/var/lib/yongle-carton-erp/backups', port: '3001' }).join('\n');
  assert.match(steps, /systemctl stop yongle-carton-erp/);
  assert.match(steps, new RegExp('erp\\.sh restore ' + backupDir));
  assert.match(steps, /不要直接启动旧程序/);
  assert.match(manualSteps({ backupDir: null, backupRoot: '/b', port: '3001' }).join('\n'), /ls -dt \/b\/full-\*/);
  assert.equal(
    parseBackupDir('完整备份已生成：/var/lib/yongle-carton-erp/backups/full-x\n共9个文件，含业务库。\n请另存一份到其他磁盘。'),
    '/var/lib/yongle-carton-erp/backups/full-x',
  );
  assert.equal(parseBackupDir('别的输出'), null);
  assert.deepEqual(parseEnv('PORT=3101\n# 注释\nDB_PATH="/srv/x/erp.sqlite"\r\nERP_BACKUP_DIR=/srv/b\n'), {
    PORT: '3101',
    DB_PATH: '/srv/x/erp.sqlite',
    ERP_BACKUP_DIR: '/srv/b',
  });
  for (const bad of ['data/erp.sqlite', 'backups/x', '../etc/passwd', '/etc/passwd', 'runtime/node/bin/node', 'node_modules/x', '.release-package', 'server/../../x'])
    assert.equal(patchTarget(bad), null, bad);
  assert.equal(patchTarget('server/index.ts'), '/opt/yongle-carton-erp/server/index.ts');
});

test('补丁锁：同时只能一个；持有进程不在了视为遗留锁；只释放自己的锁', async () => {
  const { acquireLock } = await patchLogic();
  const dir = mkdtempSync(join(tmpdir(), 'erp-audit-lock-'));
  try {
    const lock = join(dir, 'patch.lock');
    const release = acquireLock(lock, { patch: '20261108T000000-aaaaaaaa' }, () => true);
    assert.equal(lockHolder(lock).pid, process.pid);
    assert.throws(() => acquireLock(lock, { patch: 'b' }, () => true), /另一个补丁正在应用.*20261108T000000-aaaaaaaa/);
    release();
    assert.equal(existsSync(lock), false);
    writeFileSync(lock, JSON.stringify({ pid: 999999, patch: 'old' }));
    const takeover = acquireLock(lock, { patch: 'new' }, () => false);
    assert.equal(lockHolder(lock).patch, 'new');
    writeFileSync(lock, JSON.stringify({ pid: process.pid + 1, patch: 'someone-else' }));
    takeover();
    assert.ok(existsSync(lock), '别人的锁不删');
    writeFileSync(lock, '');
    assert.throws(() => acquireLock(lock, {}, () => false), /另一个补丁正在应用/, '刚建还没写内容的锁也算有人持有');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    acquireLock(lock, {}, () => false)();
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
