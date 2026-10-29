import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { checkHealth, runLauncher, waitForReady } from '../scripts/start-system.mjs';

const pending = () => {
  let resolveDone;
  const promise = new Promise((r) => {
    resolveDone = r;
  });
  return { promise, resolve: resolveDone };
};
const forever = new Promise(() => {});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), '纸序 启动验收-'));
  mkdirSync(join(dir, 'node_modules'));
  return dir;
}

test('已运行时直接打开，不构建、不启动第二套服务', async () => {
  let opened;
  await runLauncher({
    check: async () => true,
    start() {
      assert.fail('不应创建进程');
    },
    open: async (url) => {
      opened = url;
    },
    log() {},
  });
  assert.equal(opened, 'http://127.0.0.1:3001');
});

test('构建完成后异步启动，健康检查多次就绪后才打开，且保持等待后端', async () => {
  const directory = fixture(),
    done = pending(),
    events = [];
  let probes = 0;
  try {
    await runLauncher({
      directory,
      env: {},
      pollMs: 1,
      timeoutMs: 500,
      check: async () => {
        events.push('health');
        return ++probes === 4;
      },
      start(_cmd, args) {
        const command = args.at(-1);
        events.push(command);
        return {
          child: {},
          done: command.endsWith('run build')
            ? Promise.resolve({ failed: false, code: 0 })
            : done.promise,
        };
      },
      open: async () => {
        events.push('browser');
        assert.equal(probes, 4);
        done.resolve({ failed: false, code: 0 });
      },
      log() {},
    });
    assert.deepEqual(events, [
      'health',
      'call npm.cmd run build',
      'call npm.cmd start',
      'health',
      'health',
      'health',
      'browser',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('安装或构建失败立刻退出，不启动后端、不打开网页', async () => {
  for (const dependencies of [true, false]) {
    const directory = fixture(),
      calls = [];
    if (!dependencies) rmSync(join(directory, 'node_modules'), { recursive: true });
    try {
      await assert.rejects(
        runLauncher({
          directory,
          env: {},
          check: async () => false,
          start(_cmd, args) {
            calls.push(args.at(-1));
            return { child: {}, done: Promise.resolve({ failed: true, code: 12 }) };
          },
          open() {
            assert.fail('失败时不能打开浏览器');
          },
          log() {},
        }),
        /npm .*执行失败/,
      );
      assert.deepEqual(calls, [dependencies ? 'call npm.cmd run build' : 'call npm.cmd ci']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('后端立即退出时不等到超时，后端挂起时停止本次启动并报超时', async () => {
  const directory = fixture();
  try {
    for (const early of [true, false]) {
      let stopped = false;
      await assert.rejects(
        runLauncher({
          directory,
          env: {},
          timeoutMs: early ? 30000 : 25,
          pollMs: 2,
          check: async () => false,
          start(_cmd, args) {
            return {
              child: {},
              done: args.at(-1).endsWith('run build')
                ? Promise.resolve({ failed: false, code: 0 })
                : early
                  ? Promise.resolve({ failed: true, code: 7 })
                  : forever,
            };
          },
          open() {
            assert.fail('失败时不能打开浏览器');
          },
          stop: async () => {
            stopped = true;
          },
          log() {},
        }),
        early ? /就绪前已退出（退出码 7）/ : /超时/,
      );
      assert.equal(stopped, true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('探测请求尚未完成时后端已退出，也立即停止等待', async () => {
  await assert.rejects(
    waitForReady({
      check: () => forever,
      done: Promise.resolve({ failed: true, code: 4 }),
      timeoutMs: 30000,
    }),
    /退出码 4/,
  );
});

test('PORT 与相对 DB_PATH 按启动目录解析；端口冲突不启动新进程', async () => {
  await runLauncher({
    directory: resolve('work'),
    env: { PORT: '3019', DB_PATH: 'temporary.sqlite' },
    check: async (url, lock) => {
      assert.equal(url, 'http://127.0.0.1:3019');
      assert.equal(lock, resolve('work/temporary.sqlite.running'));
      return true;
    },
    open: async () => {},
    log() {},
  });
  await assert.rejects(runLauncher({ env: { PORT: '3001&echo injected' } }), /PORT/);
  await assert.rejects(
    runLauncher({
      check: async () => {
        throw new Error('其他实例');
      },
      start() {
        assert.fail('冲突时不能启动');
      },
    }),
    /其他实例/,
  );
});

test('实际 HTTP 健康检查必须成功且服务 PID 匹配运行锁；503 继续等待', async () => {
  const dir = fixture(),
    lock = join(dir, 'test.running');
  let status = 200,
    body = { ok: true, app: 'carton-workshop-erp', processId: process.pid };
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    writeFileSync(lock, String(process.pid));
    assert.equal(await checkHealth(url, lock), true);
    status = 503;
    assert.equal(await checkHealth(url, lock), false);
    status = 200;
    writeFileSync(lock, '1');
    await assert.rejects(checkHealth(url, lock), /其他项目或数据库/);
    body = { ok: true, app: 'other-service', processId: process.pid };
    await assert.rejects(checkHealth(url, lock), /不是就绪的宁波甬勒包装制品有限公司管理系统/);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(await checkHealth(url, lock), false);
});

test(
  'Windows CMD 实际执行：npm start 不阻塞健康轮询，包含空格中文路径正常',
  { skip: process.platform !== 'win32' },
  async () => {
    const dir = fixture(),
      eventsFile = join(dir, 'events.txt');
    let child;
    // 独立虚构服务及运行锁；不启动真实 ERP，不接触业务库或 AI 设置。
    const allocator = createServer();
    await new Promise((r) => allocator.listen(0, '127.0.0.1', r));
    const port = allocator.address().port;
    await new Promise((r) => allocator.close(r));
    const launcher = pathToFileURL(resolve('scripts/start-system.mjs')).href;
    const command = readFileSync('启动系统.cmd', 'utf8');
    writeFileSync(join(dir, '启动系统.cmd'), command);
    writeFileSync(
      join(dir, 'node.cmd'),
      `@echo off\r\n"${process.execPath}" "%~dp0harness.mjs"\r\nexit /b %errorlevel%\r\n`,
    );
    writeFileSync(
      join(dir, 'npm.cmd'),
      `@echo off\r\nif "%1"=="start" goto backend\r\necho build>>"%~dp0events.txt"\r\nexit /b 0\r\n:backend\r\n"${process.execPath}" "%~dp0fixture-server.mjs"\r\nexit /b %errorlevel%\r\n`,
    );
    writeFileSync(
      join(dir, 'harness.mjs'),
      `import {runLauncher} from ${JSON.stringify(launcher)};import{appendFileSync}from'node:fs';await runLauncher({directory:process.cwd(),pollMs:10,timeoutMs:5000,open:async url=>{appendFileSync('events.txt','browser-open\\n');await fetch(url+'/stop');}});`,
    );
    writeFileSync(
      join(dir, 'fixture-server.mjs'),
      `import{createServer}from'node:http';import{existsSync,writeFileSync,appendFileSync,mkdirSync}from'node:fs';mkdirSync('data',{recursive:true});const s=createServer((q,r)=>{if(q.url==='/stop'){r.end('ok');s.close();return;}const ready=existsSync('ready.signal');appendFileSync('events.txt',ready?'health-ready\\n':'health-pending\\n');r.writeHead(ready?200:503,{'Content-Type':'application/json'});r.end(JSON.stringify({ok:ready,app:'carton-workshop-erp',processId:process.pid}));});s.listen(Number(process.env.PORT),'127.0.0.1',()=>{writeFileSync('data/erp.sqlite.running',String(process.pid));appendFileSync('events.txt','server-listening\\n');});`,
    );
    try {
      child = spawn(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', 'call "' + join(dir, '启动系统.cmd') + '"'],
        {
          cwd: dir,
          env: { ...process.env, PORT: String(port), DB_PATH: '' },
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (b) => {
        output += b.toString();
      });
      child.stderr.on('data', (b) => {
        output += b.toString();
      });
      const exited = pending();
      child.once('exit', (code) => exited.resolve(code));
      child.once('error', (e) => exited.resolve(e.message));
      let seenPending = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        let events = '';
        try {
          events = readFileSync(eventsFile, 'utf8');
        } catch {}
        if (events.includes('health-pending')) {
          seenPending = true;
          assert.ok(!events.includes('browser-open'));
          break;
        }
        if (child.exitCode !== null) break;
        await delay(10);
      }
      assert.ok(seenPending, output);
      writeFileSync(join(dir, 'ready.signal'), 'ready');
      const code = await Promise.race([exited.promise, delay(7000).then(() => 'timeout')]);
      assert.equal(code, 0, output);
      const events = readFileSync(eventsFile, 'utf8');
      assert.ok(events.indexOf('build') < events.indexOf('server-listening'));
      assert.ok(events.indexOf('health-pending') < events.indexOf('health-ready'));
      assert.ok(events.indexOf('health-ready') < events.indexOf('browser-open'));
    } finally {
      if (child?.pid && child.exitCode === null) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        await new Promise((r) => {
          killer.once('exit', r);
          killer.once('error', r);
        });
      }
      // Windows可能在子进程退出后短暂保留其工作目录句柄；仅重试本测试创建的临时目录。
      const target = resolve(dir);
      assert.ok(target.startsWith(resolve(tmpdir()) + sep));
      assert.ok(basename(target).startsWith('纸序 启动验收-'));
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
