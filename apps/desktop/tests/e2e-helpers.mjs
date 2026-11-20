// 端到端测试的准备代码：启动测试版、用 WebView2 的调试接口操作网页、读 Windows 窗口状态、用真的鼠标拖动。
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { SITE_PORT } from './test-site-server.mjs';

const tauriDir = new URL('../src-tauri/', import.meta.url);
const testConfig = JSON.parse(readFileSync(new URL('tauri.test.conf.json', tauriDir), 'utf8'));

/**
 * 测试版的启动器（node scripts/build-test.mjs http://127.0.0.1:8788/ 打出来的；核心 dll、config\、pages\ 在它旁边）。
 * tauri build 会按 mainBinaryName 给 cargo 编出的启动器改名，测试版的名字在 tauri.test.conf.json。
 */
export const EXE = fileURLToPath(new URL(`target/release/${testConfig.mainBinaryName}.exe`, tauriDir));
/** 核心 dll（Cargo.toml 里 [lib] 的名字） */
const CORE_DLL = 'yongle_erp_core.dll';
export const HOME = `http://127.0.0.1:${SITE_PORT}/`;
export const TITLE = '甬勒ERP';
const DEBUG_PORT = 9339;
const win32Script = fileURLToPath(new URL('./win32.ps1', import.meta.url));

export const exeBuilt = () => existsSync(EXE);

/** 启动测试版：WebView2 的数据放在给定的临时目录，开调试端口 */
export function launch(dataDir) {
  return spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT}`,
    },
    stdio: 'ignore',
  });
}

/**
 * 把测试版（启动器、核心、config\、pages\）复制到 appDir 再从那里启动，args 是命令行参数（如开机自启的 --autostart）。
 * 要点托盘图标时用它：这台开发机上从 ERP 项目文件夹里运行的程序加不上托盘图标，换个目录就正常；
 * 从副本启动时调试端口连不上（原因没查清），所以这样启动的只看窗口、点托盘，不操作网页
 */
export function launchCopy(appDir, dataDir, args) {
  const exeName = basename(EXE);
  for (const name of [exeName, CORE_DLL, 'config', 'pages']) cpSync(join(dirname(EXE), name), join(appDir, name), { recursive: true });
  return spawn(join(appDir, exeName), args, { env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: dataDir }, stdio: 'ignore' });
}

/** 每 250 毫秒查一次，查到真值就返回；超时报出等的是什么 */
export async function waitFor(check, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  throw new Error('等不到：' + what);
}

export async function pages() {
  const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then(
    (r) => r.json(),
    () => [],
  );
  return list.filter((t) => t.type === 'page');
}

/** 等到网址对得上、且已经加载完的页面（没加载完就去点，点击会丢） */
export const pageAt = (match, what) =>
  waitFor(async () => {
    const page = (await pages()).find((p) => match(p.url));
    if (!page) return undefined;
    const state = await evaluate(page, 'document.readyState').catch(() => undefined);
    return state === 'complete' ? page : undefined;
  }, what);

/** 连上某个页面的调试接口，按顺序发几条命令，返回各自的结果 */
async function devtools(page, commands) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((open, fail) => {
    socket.onopen = open;
    socket.onerror = () => fail(new Error('连不上页面的调试接口'));
  });
  const waiting = new Map();
  socket.onmessage = (message) => {
    const data = JSON.parse(String(message.data));
    waiting.get(data.id)?.(data.result);
  };
  try {
    const results = [];
    for (const [index, [method, params]] of commands.entries()) {
      const reply = new Promise((done) => waiting.set(index + 1, done));
      socket.send(JSON.stringify({ id: index + 1, method, params }));
      results.push(await reply);
    }
    return results;
  } finally {
    socket.close();
  }
}

/** 在某个页面里执行一段脚本，取回结果 */
export async function evaluate(page, expression) {
  const [result] = await devtools(page, [['Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }]]);
  return result?.result?.value;
}

/**
 * 用鼠标点页面上的某个元素：按下、松开两个真实的输入事件，网页把它当成人点的
 * （脚本里调 click() 会被弹窗拦截和“网站要下载多个文件”的保护挡下）
 */
export async function clickElement(page, id) {
  const where = `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
  const { x, y } = await evaluate(page, where);
  const mouse = (type) => ['Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }];
  await devtools(page, [mouse('mousePressed'), mouse('mouseReleased')]);
}

/** 调 win32.ps1；extra 里的每一项变成一个 -名字 值 参数 */
export function win32(action, pid = 0, extra = {}) {
  const options = Object.entries(extra).flatMap(([name, value]) => ['-' + name, String(value)]);
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', win32Script, '-Action', action, '-ProcessId', String(pid), '-Title', TITLE, ...options];
  const result = spawnSync('powershell.exe', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('win32.ps1 失败：' + result.stderr);
  return JSON.parse(result.stdout.trim());
}

/**
 * 拖动的起点、终点在屏幕上的位置（物理像素）：主窗口切到前台，客户区左上角 + 元素中心的页面坐标 × 缩放，
 * 起点可以再往右挪 dx。确认这两点露出来的都是外壳的窗口，被别的窗口挡住就报出来
 */
export async function dragPoints(page, pid, from, to) {
  const where = `(() => { const at = (id) => { const r = document.getElementById(id).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
    return { scale: devicePixelRatio, from: at(${JSON.stringify(from.id)}), to: at(${JSON.stringify(to.id)}) }; })()`;
  const layout = await evaluate(page, where);
  const origin = win32('client', pid);
  const screen = (point, dx) => ({ x: Math.round(origin.x + point.x * layout.scale) + dx, y: Math.round(origin.y + point.y * layout.scale) });
  const points = { from: screen(layout.from, from.dx ?? 0), to: screen(layout.to, 0) };
  const shown = win32('client', pid, { FromX: points.from.x, FromY: points.from.y, ToX: points.to.x, ToY: points.to.y });
  if (shown.fromOwner !== pid || shown.toOwner !== pid) throw new Error('拖动的起点或终点被别的窗口挡住了：' + JSON.stringify(shown));
  return points;
}

/** 进程结束时兑现，带超时 */
export function exited(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return Promise.race([
    new Promise((done) => child.once('exit', (code) => done(code))),
    sleep(timeoutMs).then(() => {
      throw new Error('进程没有按时退出');
    }),
  ]);
}
