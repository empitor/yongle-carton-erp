// 启动入口（server/index.ts）：遇到旧库按提示退出并放掉运行锁；被别的模块 import 时什么都不做。
// 这两条只有起子进程才测得到，放 tests/release/；目录都指到临时目录、端口随机（PORT=0），碰不到真实数据和正式实例。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { legacyDatabase, sha256, workspace } from '../schema-fixture.js';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const entry = join(projectRoot, 'server/index.ts');

/** 在临时目录里起一个 node 进程（各个数据目录都指进去），等它结束 */
const run = (dir: string, args: string[], timeout: number) =>
  new Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }>((done) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), ...args], {
      cwd: dir,
      env: {
        ...process.env,
        DB_PATH: join(dir, 'erp.sqlite'),
        PORT: '0',
        ERP_BACKUP_DIR: join(dir, 'backups'),
        ERP_CONFIG_DIR: join(dir, 'config'),
        LOCALAPPDATA: dir,
      },
    });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    const timer = setTimeout(() => ((timedOut = true), child.kill()), timeout);
    child.on('close', (status) => (clearTimeout(timer), done({ status, stdout, stderr, timedOut })));
  });

// 两个进程在第一条测试开始时一起起，各条测试只等自己那个
const old = workspace('erp-entry-old-'), imported = workspace('erp-entry-import-');
let runs: { refused: ReturnType<typeof run>; loaded: ReturnType<typeof run>; hash: string } | undefined;
const started = () =>
  (runs ??= (() => {
    legacyDatabase(old.path);
    return {
      hash: sha256(old.path),
      refused: run(old.dir, [entry], 120_000),
      // 万一入口检查失效：监听了端口进程就不会自己结束，按超时判失败
      loaded: run(imported.dir, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log('只加载、没启动');`], 60_000),
    };
  })());
after(async () => {
  if (runs) await Promise.all([runs.refused, runs.loaded]);
  old.close();
  imported.close();
});

test('启动入口遇到旧库：原样打出提示、以非零码退出、不打堆栈，旧库不动、运行锁放掉', async () => {
  const { refused: running, hash } = started();
  const refused = await running;
  assert.equal(refused.status, 1, refused.stderr + refused.stdout);
  assert.match(refused.stderr, /这是 0\.9\.0 以前的旧业务数据库（第 19 版）：/);
  assert.match(refused.stderr, /import-archive 目录/);
  // 堆栈行：缩进的 “at 某处 (文件:行:列)”
  const stackLine = (line: string) => /^\s+at /.test(line) && line.includes('(') && /:\d+:\d+\)$/.test(line);
  assert.equal(refused.stderr.split('\n').some(stackLine), false, '不打堆栈');
  assert.doesNotMatch(refused.stderr, /SchemaError|node:internal/);
  assert.equal(sha256(old.path), hash);
  assert.deepEqual(readdirSync(old.dir).filter((name) => name.endsWith('.running')), [], '运行锁已经放掉');
});

test('启动入口被别的文件 import 时什么都不做：不打开任何库、不写运行锁、不监听端口，进程自己结束', async () => {
  const loaded = await started().loaded;
  assert.equal(loaded.timedOut, false, '进程自己结束了，没有挂着监听端口');
  assert.equal(loaded.status, 0, loaded.stderr + loaded.stdout);
  assert.match(loaded.stdout, /只加载、没启动/);
  assert.doesNotMatch(loaded.stdout, /管理系统：http/);
  assert.deepEqual(readdirSync(imported.dir), [], '业务库、运行锁、配置目录、备份目录一个都没建');
});
