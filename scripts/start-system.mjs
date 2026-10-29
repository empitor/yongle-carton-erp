// 仅负责启动。不会读取或修改 ERP 业务数据和 AI 配置。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';

export async function checkHealth(url, lockFile, timeoutMs = 1500) {
  let response;
  try {
    response = await fetch(url + '/api/health', {
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
      redirect: 'error',
      cache: 'no-store',
    });
  } catch {
    return false;
  }
  if ([502, 503, 504].includes(response.status)) return false;
  let health;
  try {
    health = await response.json();
  } catch {
    /* 返回普通网页也不能当作 ERP 已就绪 */
  }
  if (
    !response.ok ||
    health?.ok !== true ||
    health.app !== 'carton-workshop-erp' ||
    !Number.isInteger(health.processId) ||
    health.processId <= 0
  )
    throw new Error('端口已有服务响应，但不是就绪的宁波甬勒包装制品有限公司管理系统。请检查端口占用及服务输出。');
  let lockPid;
  try {
    lockPid = Number(readFileSync(lockFile, 'utf8').trim());
  } catch {
    /* 下方统一提示 */
  }
  if (lockPid !== health.processId)
    throw new Error('检测到其他项目或数据库实例正在使用此端口。请先停止该实例；未启动第二套服务。');
  return true;
}

// process.done 在创建子进程后立即订阅，因此不会漏掉服务快速退出。
export function startProcess(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    // CMD 自己解析命令文本；禁止 Node 再把内部引号改成反斜杠引号。
    windowsVerbatimArguments: process.platform === 'win32' && /(?:^|[\\/])cmd\.exe$/i.test(command),
  });
  const done = new Promise((resolveDone) => {
    child.once('error', () =>
      resolveDone({ failed: true, message: '无法创建启动进程，请检查 Node.js、npm 和执行权限。' }),
    );
    child.once('exit', (code, signal) => resolveDone({ failed: code !== 0, code, signal }));
  });
  return { child, done };
}

export async function waitForReady({ check, done, timeoutMs = 30000, pollMs = 500 }) {
  const deadline = performance.now() + timeoutMs;
  const exited = done.then((result) => ({ kind: 'exit', result }));
  while (performance.now() < deadline) {
    const remaining = deadline - performance.now();
    const result = await Promise.race([
      check(Math.min(1500, remaining)).then((ready) => ({ kind: 'health', ready })),
      exited,
    ]);
    if (result.kind === 'exit')
      throw new Error(
        `后端在就绪前已退出${result.result.code == null ? '' : `（退出码 ${result.result.code}）`}。请查看上方启动错误。`,
      );
    if (result.ready) return;
    const waited = await Promise.race([
      delay(Math.max(0, Math.min(pollMs, deadline - performance.now()))).then(() => null),
      exited,
    ]);
    if (waited?.kind === 'exit')
      throw new Error(
        `后端在就绪前已退出${waited.result.code == null ? '' : `（退出码 ${waited.result.code}）`}。请查看上方启动错误。`,
      );
  }
  throw new Error(
    `等待后端就绪超时（${timeoutMs / 1000} 秒）。未打开浏览器，请检查上方日志及端口占用后重试。`,
  );
}

async function openBrowser(url) {
  const result = await startProcess(shell, ['/d', '/s', '/c', `start "" "${url}"`], root).done;
  if (result.failed) console.error('ERP 已就绪，但无法自动打开浏览器。请手动访问：' + url);
}

// 只清理本启动器创建的进程树，不扫描或终止其他 Node 进程。
async function stopOwnedProcess(backend) {
  if (!backend?.child.pid || backend.child.exitCode !== null || backend.child.signalCode !== null)
    return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(backend.child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise((resolveDone) => {
      killer.once('exit', resolveDone);
      killer.once('error', resolveDone);
    });
  } else backend.child.kill('SIGTERM');
}

export async function runLauncher({
  directory = root,
  env = process.env,
  check = checkHealth,
  start = startProcess,
  open = openBrowser,
  stop = stopOwnedProcess,
  log = console.log,
  timeoutMs = 30000,
  pollMs = 500,
} = {}) {
  const portText = env.PORT || '3001';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535)
    throw new Error('PORT 必须是 1 至 65535 的端口号。');
  const url = `http://127.0.0.1:${Number(portText)}`;
  const lockFile = resolve(directory, env.DB_PATH || 'data/erp.sqlite') + '.running';
  if (await check(url, lockFile)) {
    log('宁波甬勒包装制品有限公司 · 管理系统已在运行，正在打开网页。');
    await open(url);
    return;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 15) throw new Error('请安装 Node.js 24.15 或更高的 24 LTS 版本。');
  const npm = async (args) => {
    const result = await start(shell, ['/d', '/s', '/c', 'call npm.cmd ' + args], directory).done;
    if (result.failed) throw new Error(`npm ${args} 执行失败。请检查上方错误；尚未打开浏览器。`);
  };
  if (!existsSync(resolve(directory, 'node_modules'))) await npm('ci');
  await npm('run build');
  log('正在启动宁波甬勒包装制品有限公司 · 管理系统，等待 /api/health 确认就绪（最多 30 秒）…');
  // spawn 非阻塞启动 npm；不能在 CMD 中直接 call npm start 后再轮询。
  const backend = start(shell, ['/d', '/s', '/c', 'call npm.cmd start'], directory);
  const interrupt = () => {
    void stop(backend).finally(() => process.exit(130));
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await waitForReady({
      check: (remaining) => check(url, lockFile, remaining),
      done: backend.done,
      timeoutMs,
      pollMs,
    });
    log('宁波甬勒包装制品有限公司 · 管理系统已就绪，正在打开：' + url);
    await open(url);
    log('请保留此窗口；按 Ctrl+C 停止服务，也可使用“停止系统.cmd”。');
    const result = await backend.done;
    if (result.failed) throw new Error('ERP 服务异常退出，请查看上方错误。');
    log('ERP 服务已正常关闭。');
  } catch (error) {
    await stop(backend);
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runLauncher().catch((error) => {
    console.error('启动失败：' + error.message);
    process.exitCode = 1;
  });
}
