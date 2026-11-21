// 发布前检查：补丁和整包的文件清单、补丁脚本能单独运行、版本探针、命令行备份（只调纯函数的回滚判断和补丁锁在 tests/patch-rollback.test.ts）。改业务代码用不着每次跑，发布时跑 npm run test:release。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../server/core/db.js';
import { createFullBackup, restoreFullBackup } from '../../server/core/backup.js';
import { supportedDatabaseVersions } from '../../server/core/backup-check.js';
import { readBackupManifest } from '../../server/core/backup-manifest.js';
import { customerSchema } from '../../shared/core/domain.js';
import { errorMessage } from '../../shared/core/error-message.js';
import { load, patchLogic, patchRollback, projectRoot } from '../patch-scripts-fixture.js';

type Stray = { untracked: string[]; ignored: string[] };
type PatchServer = {
  applyScripts: string[];
  resultCheckHint: (host: string, id: string) => string[];
  localManifest: (root: string, scope: string[]) => Map<string, Buffer>;
  strayFiles: (root: string, scope: string[]) => Stray;
  strayProblems: (stray: Stray) => string[];
  contentProblems: (manifest: Map<string, Buffer>) => string[];
  distManifest: (dir: string) => Map<string, Buffer>;
  trackedFiles: (root: string, scope: readonly string[]) => { mode: string; stage: string; path: string }[];
};
type ReleaseScan = { scanTree: (root: string) => string[]; scanFileList: (entries: Map<string, Buffer>) => string[] };
const patchServer = () =>
  load<PatchServer>('scripts/patch-server.mjs', {
    applyScripts: 'array',
    resultCheckHint: 'function',
    localManifest: 'function',
    strayFiles: 'function',
    strayProblems: 'function',
    contentProblems: 'function',
    distManifest: 'function',
    trackedFiles: 'function',
  });

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

// ---------- 完整备份不拒绝更新的库；版本探针 ----------

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

test('服务账号读取版本的探针脚本：业务库的结构版本、配置库的 user_version 读得出，库不存在时如实说明、不新建', async () => {
  const { schemaProbe, parseSchema } = await patchLogic();
  const { versionProbe, parseVersion } = await patchRollback();
  const dir = mkdtempSync(join(tmpdir(), 'erp-audit-probe-'));
  try {
    const file = join(dir, 'erp.sqlite');
    new Store(file).close();
    const read = (probe: string, path: string) => spawnSync(process.execPath, ['--no-warnings', '-e', probe, path], { encoding: 'utf8' }).stdout;
    const missing = join(dir, 'missing.sqlite');
    assert.deepEqual(parseSchema(read(schemaProbe, file)), { exists: true, versions: supportedDatabaseVersions });
    assert.deepEqual(parseSchema(read(schemaProbe, missing)), { exists: false, versions: [] });
    assert.equal(parseSchema('不是 JSON'), null);
    assert.equal(parseSchema('{"exists":true,"versions":["x"]}'), null);
    const config = join(dir, 'config.sqlite');
    const db = new DatabaseSync(config);
    db.exec('CREATE TABLE fictional(id INTEGER PRIMARY KEY); PRAGMA user_version=3');
    db.close();
    assert.equal(parseVersion(read(versionProbe, config)), 3);
    assert.equal(parseVersion(read(versionProbe, missing)), null);
    assert.equal(parseVersion('不是 JSON'), null);
    assert.equal(existsSync(missing), false, '探针不新建数据库');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 断线不中断、日志 ----------

test('应用补丁脚本：导入不执行；只拿上传的那几个文件放一个目录也能运行，先检查 root；忽略挂断信号、输出出错不退出、写日志', async () => {
  // 导入时要是执行了主流程，没有 root 会直接退出进程，这条测试就跑不完
  await import(pathToFileURL(join(projectRoot, 'scripts/linux/apply-patch.mjs')).href);
  const { applyScripts, resultCheckHint } = await patchServer();
  const script = join(projectRoot, 'scripts/linux/apply-patch.mjs');
  if (process.platform === 'win32' || process.getuid?.() !== 0) {
    // 和服务器上一样：只有 patch-server 上传的那几个文件在同一个目录里，拆出去的文件漏传就会加载失败
    const uploaded = mkdtempSync(join(tmpdir(), 'erp-audit-upload-'));
    try {
      for (const name of applyScripts) writeFileSync(join(uploaded, name), readFileSync(join(projectRoot, 'scripts/linux', name)));
      const r = spawnSync(process.execPath, [join(uploaded, 'apply-patch.mjs'), join(tmpdir(), 'no-such-patch.json.gz')], { encoding: 'utf8' });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /补丁未应用：需要 root/);
    } finally {
      rmSync(uploaded, { recursive: true, force: true });
    }
  }
  const source = readFileSync(script, 'utf8');
  assert.match(source, /process\.on\('SIGHUP'/);
  assert.match(source, /stream\.on\('error'/);
  assert.match(source, /apply\.log/);
  assert.match(source, /\/usr\/bin\/setsid/);
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
