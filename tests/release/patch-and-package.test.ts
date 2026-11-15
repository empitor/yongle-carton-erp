// 发布前检查：补丁和整包的文件清单、补丁锁和回滚、命令行备份。改业务代码用不着每次跑，发布时跑 npm run test:release。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Store } from '../../server/core/db.js';
import { createFullBackup, restoreFullBackup } from '../../server/core/backup.js';
import { supportedDatabaseVersions } from '../../server/core/backup-check.js';
import { readBackupManifest } from '../../server/core/backup-manifest.js';
import { customerSchema } from '../../shared/core/domain.js';
import { errorMessage } from '../../shared/core/error-message.js';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// 脚本是 .mjs，没有类型声明；用变量路径动态导入，类型检查不去解析它们。
// 导入后按下面写明的形状核对点名的导出都在、种类对得上；函数的类型照脚本里的写法写。
type ExportKind = 'function' | 'string' | 'array';
const kindOf = (value: unknown) => (Array.isArray(value) ? 'array' : typeof value);
function hasExports<T>(mod: unknown, shape: Record<string, ExportKind>): mod is T {
  if (typeof mod !== 'object' || mod === null) return false;
  return Object.entries(shape).every(([name, kind]) => kindOf(Reflect.get(mod, name)) === kind);
}
async function load<T>(path: string, shape: Record<keyof T, ExportKind>): Promise<T> {
  const mod: unknown = await import(pathToFileURL(join(projectRoot, path)).href);
  if (!hasExports<T>(mod, shape)) throw new Error(path + ' 的导出和测试里写明的不一致');
  return mod;
}

type SchemaState = { exists: boolean; versions: number[] };
type Stray = { untracked: string[]; ignored: string[] };
type ApplyPatch = {
  rollbackPlan: (o: { before: SchemaState | null; after: SchemaState | null; backupDir: string | null }) => {
    action: 'files-only' | 'restore-db' | 'manual';
    reason: string;
  };
  manualSteps: (o: { backupDir: string | null; backupRoot: string; port: string }) => string[];
  parseBackupDir: (output: string) => string | null;
  parseEnv: (text: string) => Record<string, string>;
  patchTarget: (path: string) => string | null;
  schemaProbe: string;
  parseSchema: (stdout: string) => SchemaState | null;
  acquireLock: (path: string, info: Record<string, unknown>, isAlive: (pid: number) => boolean) => () => void;
};
type PatchServer = {
  resultCheckHint: (host: string, id: string) => string[];
  localManifest: (root: string, scope: string[]) => Map<string, Buffer>;
  strayFiles: (root: string, scope: string[]) => Stray;
  strayProblems: (stray: Stray) => string[];
  contentProblems: (manifest: Map<string, Buffer>) => string[];
  distManifest: (dir: string) => Map<string, Buffer>;
  trackedFiles: (root: string, scope: readonly string[]) => { mode: string; stage: string; path: string }[];
};
type ReleaseScan = { scanTree: (root: string) => string[]; scanFileList: (entries: Map<string, Buffer>) => string[] };
const applyPatch = () =>
  load<ApplyPatch>('scripts/linux/apply-patch.mjs', {
    rollbackPlan: 'function',
    manualSteps: 'function',
    parseBackupDir: 'function',
    parseEnv: 'function',
    patchTarget: 'function',
    schemaProbe: 'string',
    parseSchema: 'function',
    acquireLock: 'function',
  });
const patchServer = () =>
  load<PatchServer>('scripts/patch-server.mjs', {
    resultCheckHint: 'function',
    localManifest: 'function',
    strayFiles: 'function',
    strayProblems: 'function',
    contentProblems: 'function',
    distManifest: 'function',
    trackedFiles: 'function',
  });
/** 补丁锁文件的内容 */
const lockHolder = (file: string) =>
  z.looseObject({ pid: z.number(), patch: z.string().optional() }).parse(JSON.parse(readFileSync(file, 'utf8')));

const customerNames = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT name FROM customers ORDER BY id').all().map((r) => String(r.name));
  } finally {
    db.close();
  }
};

// ---------- 补丁的本机程序文件只取 git 跟踪的文件 ----------

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), 'erp-audit-repo-'));
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q');
  const put = (path: string, text: string | Buffer) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('.gitignore', '*.xlsx\n*.key\n');
  put('server/index.ts', 'export const a = 1;\r\nexport const b = 2;\r\n');
  put('shared/util.ts', 'export const c = 3;\n');
  put('启动系统.cmd', '@echo off\r\n');
  git('add', '.gitignore', 'server/index.ts', 'shared/util.ts', '启动系统.cmd');
  return { root, git, put, close: () => rmSync(root, { recursive: true, force: true }) };
}

// ---------- 完整备份不拒绝更新的库；补丁回滚判断 ----------

test('完整备份接受比程序新的数据库版本并写进清单；恢复仍然拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'erp-audit-newer-'));
  try {
    const data = join(root, 'data');
    const store = new Store(join(data, 'erp.sqlite'));
    store.saveCustomer(customerSchema.parse({ name: '虚构新版客户' }));
    const max = Math.max(...supportedDatabaseVersions);
    const normal = await createFullBackup({ dataDir: data, backupRoot: join(root, 'normal') });
    const normalManifest = readBackupManifest(normal.dir);
    assert.equal(normalManifest.schemaVersion, max);
    assert.equal(normalManifest.newerSchema, undefined);
    // 将来的版本怎么编号当前程序不知道：这里故意跳一号，备份照样要能做
    store.db.exec(`INSERT INTO schema_migrations(version,name,applied_at,app_version) VALUES(${max + 1},'虚构的将来版本',datetime('now'),'9.9.9'); INSERT INTO schema_migrations(version,name,applied_at,app_version) VALUES(${max + 3},'虚构的将来版本',datetime('now'),'9.9.9')`);
    store.close();
    const backup = await createFullBackup({ dataDir: data, backupRoot: join(root, 'backups'), prefix: 'auto' });
    assert.equal(backup.schemaVersion, max + 3);
    assert.equal(backup.newerSchema, true);
    const manifest = readBackupManifest(backup.dir);
    assert.equal(manifest.schemaVersion, max + 3);
    assert.equal(manifest.newerSchema, true);
    assert.deepEqual(customerNames(join(backup.dir, 'erp.sqlite')), ['虚构新版客户']);
    const target = join(root, 'target');
    assert.throws(() => restoreFullBackup(backup.dir, target), /不支持此数据库版本.*最高支持/);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('命令行 backup 遇到更新的库照样备份并提示；restore 仍然拒绝（整份备份和单个业务库文件都拒绝）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-audit-cli-'));
  try {
    const dbPath = join(dir, 'data', 'erp.sqlite'),
      backups = join(dir, 'backups');
    const store = new Store(dbPath);
    store.saveCustomer(customerSchema.parse({ name: '虚构命令行客户' }));
    const max = Math.max(...supportedDatabaseVersions);
    store.db.exec(`INSERT INTO schema_migrations(version,name,applied_at,app_version) VALUES(${max + 1},'虚构的将来版本',datetime('now'),'9.9.9')`);
    store.close();
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(projectRoot, 'server/maintenance.ts'), ...args], {
        cwd: dir,
        env: { ...process.env, DB_PATH: dbPath, ERP_BACKUP_DIR: backups, ERP_CONFIG_DIR: join(dir, 'config'), LOCALAPPDATA: dir },
        encoding: 'utf8',
      });
    const full = run('backup');
    assert.equal(full.status, 0, full.stderr + full.stdout);
    assert.match(full.stdout, /^完整备份已生成：/, '补丁脚本按这一行找备份目录');
    assert.match(full.stdout, new RegExp(`第 ${max + 1} 版，比当前程序新`));
    const backupDir = join(backups, readdirSync(backups)[0]);
    for (const source of [backupDir, join(backupDir, 'erp.sqlite')]) {
      const restored = run('restore', source);
      assert.equal(restored.status, 1, source);
      assert.match(restored.stderr, /不支持此数据库版本/);
    }
    assert.deepEqual(customerNames(dbPath), ['虚构命令行客户']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('补丁回滚：结构版本变了才恢复数据库，判断不了就要求手动处理', async () => {
  const { rollbackPlan, manualSteps, parseBackupDir, parseEnv, patchTarget } = await applyPatch();
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

test('服务账号读取结构版本的探针脚本：读得出版本，库不存在时如实说明', async () => {
  const { schemaProbe, parseSchema } = await applyPatch();
  const dir = mkdtempSync(join(tmpdir(), 'erp-audit-probe-'));
  try {
    const file = join(dir, 'erp.sqlite');
    new Store(file).close();
    const read = (path: string) => spawnSync(process.execPath, ['--no-warnings', '-e', schemaProbe, path], { encoding: 'utf8' });
    const found = parseSchema(read(file).stdout);
    assert.deepEqual(found, { exists: true, versions: supportedDatabaseVersions });
    assert.deepEqual(parseSchema(read(join(dir, 'missing.sqlite')).stdout), { exists: false, versions: [] });
    assert.equal(existsSync(join(dir, 'missing.sqlite')), false, '探针不新建数据库');
    assert.equal(parseSchema('不是 JSON'), null);
    assert.equal(parseSchema('{"exists":true,"versions":["x"]}'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 断线不中断、锁、日志 ----------

test('补丁锁：同时只能一个；持有进程不在了视为遗留锁；只释放自己的锁', async () => {
  const { acquireLock } = await applyPatch();
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

test('应用补丁脚本：导入不执行；直接运行时先检查 root；忽略挂断信号、输出出错不退出、写日志', async () => {
  const mod = await applyPatch();
  assert.equal(typeof mod.rollbackPlan, 'function');
  const script = join(projectRoot, 'scripts/linux/apply-patch.mjs');
  if (process.platform === 'win32' || process.getuid?.() !== 0) {
    const r = spawnSync(process.execPath, [script, join(tmpdir(), 'no-such-patch.json.gz')], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /补丁未应用：需要 root/);
  }
  const source = readFileSync(script, 'utf8');
  assert.match(source, /process\.on\('SIGHUP'/);
  assert.match(source, /stream\.on\('error'/);
  assert.match(source, /apply\.log/);
  assert.match(source, /\/usr\/bin\/setsid/);
  const { resultCheckHint } = await patchServer();
  const hint = resultCheckHint('yongle-erp', '20261108T000000-aaaaaaaa').join('\n');
  assert.match(hint, /ssh yongle-erp sudo tail -n 40 \/var\/backups\/yongle-carton-erp-patches\/20261108T000000-aaaaaaaa\/apply\.log/);
  assert.match(hint, /patch-server -- --check/);
});

test('本机程序文件只取 git 跟踪的文件；未纳入 git 和被忽略的文件列出来拒绝', async () => {
  const { localManifest, strayFiles, strayProblems } = await patchServer();
  const repo = tempRepo();
  try {
    const scope = ['server', 'shared', '启动系统.cmd'];
    repo.put('server/虚构客户资料.xlsx', '虚构客户表格');
    repo.put('server/config/虚构.key', '虚构密钥');
    repo.put('server/new-file.ts', 'export {};\n');
    const manifest = localManifest(repo.root, scope);
    assert.deepEqual([...manifest.keys()].sort(), ['server/index.ts', 'shared/util.ts', '启动系统.cmd'].sort());
    assert.equal(manifest.get('server/index.ts')?.toString(), 'export const a = 1;\nexport const b = 2;\n', '换行统一成 LF');
    assert.equal(manifest.get('启动系统.cmd')?.toString(), '@echo off\r\n', '.cmd 保持 CRLF');
    const stray = strayFiles(repo.root, scope);
    assert.deepEqual(stray.untracked, ['server/new-file.ts']);
    assert.deepEqual(stray.ignored.sort(), ['server/config/虚构.key', 'server/虚构客户资料.xlsx']);
    const problems = strayProblems(stray).join('\n');
    assert.match(problems, /没纳入 git.*server\/new-file\.ts/);
    assert.match(problems, /\.gitignore 忽略.*虚构客户资料\.xlsx/);
    assert.deepEqual(strayFiles(repo.root, ['shared']), { untracked: [], ignored: [] });
    assert.throws(() => localManifest(repo.root, [...scope, 'scripts/linux']), /缺少程序文件（没有纳入 git）：scripts\/linux/);
    rmSync(join(repo.root, 'shared/util.ts'));
    assert.throws(() => localManifest(repo.root, scope), /git 里有，本机没有.*shared\/util\.ts/);
  } finally {
    repo.close();
  }
});

test('符号链接（git 里的链接条目或本机链接）一律拒绝', async (t) => {
  const { localManifest } = await patchServer();
  const repo = tempRepo();
  try {
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo.root, input: '../outside', encoding: 'utf8' }).stdout.trim();
    repo.git('update-index', '--add', '--cacheinfo', `120000,${blob},server/link.ts`);
    assert.throws(() => localManifest(repo.root, ['server']), /不能是符号链接：server\/link\.ts/);
    repo.git('rm', '-q', '--cached', 'server/link.ts');
    const outside = mkdtempSync(join(tmpdir(), 'erp-audit-outside-'));
    try {
      writeFileSync(join(outside, 'secret.ts'), '虚构外部文件');
      try {
        rmSync(join(repo.root, 'shared'), { recursive: true });
        symlinkSync(outside, join(repo.root, 'shared'), 'junction');
      } catch (error) {
        t.diagnostic('本机不能建目录链接，跳过本机链接检查：' + errorMessage(error));
        return;
      }
      writeFileSync(join(outside, 'util.ts'), 'export const c = 3;\n');
      assert.throws(() => localManifest(repo.root, ['shared']), /经由链接指向了别处：shared\/util\.ts/);
    } finally {
      // 只删链接本身，不顺着链接删目标。
      const link = join(repo.root, 'shared');
      try {
        fs.unlinkSync(link);
      } catch {
        try {
          fs.rmdirSync(link);
        } catch {
          // 链接没建成或已经删掉：没有要删的
        }
      }
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    repo.close();
  }
});

test('补丁和整包用同一套文件名和内容检查', async () => {
  const { contentProblems, distManifest } = await patchServer();
  const { scanTree, scanFileList } = await load<ReleaseScan>('scripts/release-scan.mjs', { scanTree: 'function', scanFileList: 'function' });
  const fakeKey = 'sk-' + 'Q'.repeat(30);
  const manifest = new Map<string, Buffer>([
    ['server/ok.ts', Buffer.from('const key = "sk-fictional-' + 'x'.repeat(30) + '";')],
    ['server/leak.ts', Buffer.from('const key = "' + fakeKey + '";')],
    ['server/pk.txt', Buffer.from('-----BEGIN ' + 'PRIVATE KEY-----')],
    ['server/data.sqlite', Buffer.from('x')],
    ['server/.env', Buffer.from('X=1')],
    ['tests/x.ts', Buffer.from('x')],
    ['.env.example', Buffer.from('PORT=3001')],
  ]);
  const problems = contentProblems(manifest);
  assert.deepEqual(problems.sort(), [
    '不该打包的文件：server/.env',
    '不该打包的文件：server/data.sqlite',
    '不该打包的目录：tests',
    '疑似密钥：server/leak.ts',
    '疑似密钥：server/pk.txt',
  ].sort());
  assert.deepEqual(scanFileList(manifest), contentProblems(manifest));
  const stage = mkdtempSync(join(tmpdir(), 'erp-audit-stage-'));
  try {
    for (const [path, bytes] of manifest) {
      mkdirSync(join(stage, path, '..'), { recursive: true });
      writeFileSync(join(stage, path), bytes);
    }
    mkdirSync(join(stage, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(stage, 'node_modules/pkg/readme.md'), fakeKey);
    writeFileSync(join(stage, 'node_modules/pkg/test.pem'), 'x');
    const tree = scanTree(stage);
    assert.deepEqual(tree.filter((p) => !p.includes('node_modules')).sort(), problems.sort(), '整包和补丁对同样的文件结论相同');
    assert.ok(tree.includes('不该打包的文件：node_modules/pkg/test.pem'), '第三方目录照样查文件名');
    assert.equal(tree.some((p) => p.includes('node_modules/pkg/readme.md')), false, '第三方目录不查内容');
    const dist = mkdtempSync(join(tmpdir(), 'erp-audit-dist-'));
    try {
      mkdirSync(join(dist, 'assets'));
      writeFileSync(join(dist, 'index.html'), '<html>\r\n</html>');
      writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
      const built = distManifest(dist);
      assert.deepEqual([...built.keys()].sort(), ['dist/assets/app.js', 'dist/index.html']);
      assert.equal(built.get('dist/index.html')?.toString(), '<html>\n</html>');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test('当前项目的发布清单都由 git 跟踪（只读检查）', async () => {
  const { trackedFiles } = await patchServer();
  const { releaseFiles } = await load<{ releaseFiles: string[] }>('scripts/release-files.mjs', { releaseFiles: 'array' });
  const entries = trackedFiles(projectRoot, releaseFiles);
  assert.ok(entries.some((e) => e.path === 'server/core/backup.ts'));
  assert.equal(entries.some((e) => /^(data|backups)\//.test(e.path)), false);
  assert.equal(entries.some((e) => e.mode === '120000'), false, '发布清单里没有符号链接');
});
