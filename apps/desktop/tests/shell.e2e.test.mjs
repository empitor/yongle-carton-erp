// Windows 外壳端到端测试：真启动测试版，像人一样点网页、拖东西、点 ×、再双击一次、点托盘图标，断言看得见的结果。
// 先打测试版：node scripts/build-test.mjs http://127.0.0.1:8788/ ；再跑：node --test --test-concurrency=1 tests/shell.e2e.test.mjs
// 是一个按顺序走的流程（后一步用前一步留下的窗口和页面），不能单独跑其中一步。
// 会真的打开系统默认浏览器一次（外部网页）、真的移动鼠标拖三次，会在“下载”文件夹里写四个带编号的测试文件，测完删掉。
// 不点托盘菜单里的“开机自动启动”，不改这台电脑的开机启动项。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import {
  HOME,
  clickElement,
  dragPoints,
  evaluate,
  exeBuilt,
  exited,
  launch,
  launchCopy,
  pageAt,
  pages,
  waitFor,
  win32,
} from './e2e-helpers.mjs';
import { startSite } from './test-site-server.mjs';

/** 外壳自带的离线页（pages::offline_url()） */
const OFFLINE = 'http://yl.localhost/index.html';
const run = Date.now().toString(36);
const files = {
  blob: `yongle-shell-blob-${run}.txt`,
  export: `送货单-yongle-shell-${run}.xlsx`,
  http: `yongle-shell-http-${run}.bin`,
  popup: `yongle-shell-http-${run}popup.bin`,
};
let site;
let app;
let dataDir;
let appCopy;
let downloads;
let dropped;

/** 主窗口里的测试首页（带不带 ?run= 编号都算；新窗口里的第二页不算） */
const atHome = (url) => url === HOME || url.startsWith(HOME + '?');
const home = () => pageAt(atHome, '测试首页');
const click = async (id) => clickElement(await home(), id);
const savedFile = (name) => waitFor(() => existsSync(join(downloads, name)), '下载文件 ' + name, 30000);
const visible = () => win32('state', app.pid).visible;
const drops = async () => evaluate(await home(), 'window.drops.join()');
/** 启动画面最多放这么久就该收尾（动画 1.5 秒加关窗）；收尾晚了说明加载结果没赶上，要等 8 秒的上限 */
const SPLASH_DONE_MS = 4000;
/**
 * 启动画面和主窗口标题一样：只剩一个窗口、而且看得见，就是启动画面关了、主窗口露面了。
 * 从页面有了结果（加载好或落到离线页）算起，SPLASH_DONE_MS 内要做到
 */
const revealed = (what) =>
  waitFor(() => {
    const state = win32('state', app.pid);
    return state.count === 1 && state.visible === 1;
  }, what, SPLASH_DONE_MS);

/** 等一会儿再看：主窗口还停在测试首页，没有落到离线页 */
async function staysHome(what) {
  await sleep(1500);
  const urls = (await pages()).map((p) => p.url);
  assert.ok(urls.some(atHome), what + '：主窗口还在测试首页');
  assert.ok(!urls.some((url) => url.startsWith(OFFLINE)), what + '：没有落到离线页');
}

before(async () => {
  assert.ok(exeBuilt(), '先打测试版：node scripts/build-test.mjs http://127.0.0.1:8788/');
  site = await startSite();
  dataDir = mkdtempSync(join(tmpdir(), 'yongle-desktop-e2e-'));
  appCopy = mkdtempSync(join(tmpdir(), 'yongle-desktop-e2e-app-'));
  dropped = join(dataDir, `yongle-shell-drop-${run}.txt`);
  writeFileSync(dropped, 'YONGLE-SHELL-DROP-TEST\n');
  downloads = win32('downloads').path;
  app = launch(dataDir);
});

after(async () => {
  app?.kill();
  await site?.close();
  if (downloads) for (const name of Object.values(files)) rmSync(join(downloads, name), { force: true });
  // 等 WebView2 子进程放开数据目录、程序放开副本再删
  await sleep(1000);
  for (const dir of [dataDir, appCopy]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

test('Windows 外壳按顺序走一遍', async (t) => {
  await t.test('冷启动先出启动画面，页面加载好后放完动画就关掉、露出主窗口', async () => {
    const splash = await waitFor(async () => (await pages()).some((p) => p.url.endsWith('/splash.html')), '启动画面', 5000);
    assert.ok(splash);
    await home();
    await revealed('页面加载好后启动画面关掉、主窗口露面');
    assert.ok(!(await pages()).some((p) => p.url.endsWith('/splash.html')));
  });

  await t.test('打开配置的测试网址，窗口可见', async () => {
    await home();
    const state = await waitFor(() => visible() === 1 && win32('state', app.pid), '窗口出现');
    assert.equal(state.count, 1);
  });

  await t.test('页内拖动能放到接收区（Tauri 自己的拖放接管已关）', async () => {
    const { from, to } = await dragPoints(await home(), app.pid, { id: 'card' }, { id: 'dropzone' });
    win32('drag', 0, { FromX: from.x, FromY: from.y, ToX: to.x, ToY: to.y });
    await waitFor(async () => (await drops()).includes('text:card'), '页内拖动放下', 5000);
  });

  await t.test('从外面拖文件进来，网页收到这个文件；拖到没有接收区的地方，窗口也不去打开它', async () => {
    // 起点在接收区右边，测试工具在那里开一个小窗口当拖放的来源
    const { from, to } = await dragPoints(await home(), app.pid, { id: 'dropzone', dx: 600 }, { id: 'dropzone' });
    win32('drag', 0, { File: dropped, FromX: from.x, FromY: from.y, ToX: to.x, ToY: to.y });
    await waitFor(async () => (await drops()).includes('file:' + basename(dropped)), '文件放下', 5000);
    // 卡片不接收拖放：文件放上去，WebView2 会去打开 file:///，导航规则拦下
    const loose = await dragPoints(await home(), app.pid, { id: 'card', dx: 600 }, { id: 'card' });
    win32('drag', 0, { File: dropped, FromX: loose.from.x, FromY: loose.from.y, ToX: loose.to.x, ToY: loose.to.y });
    await staysHome('拖文件进来之后');
  });

  await t.test('网页调不动外壳接口（几个插件和核心的命令都试一遍，都被拒）', async () => {
    // 只试读的命令：万一放开了也不改这台电脑（不试开机自启的 enable）
    const commands = ['plugin:opener|open_url', 'plugin:updater|check', 'plugin:autostart|is_enabled', 'plugin:app|version'];
    const call = `Promise.all(${JSON.stringify(commands)}.map((cmd) =>
      typeof window.__TAURI_INTERNALS__ === 'undefined' ? 'absent'
        : window.__TAURI_INTERNALS__.invoke(cmd, { url: 'https://example.invalid/' }).then(() => 'allowed', () => 'denied')))`;
    const results = await evaluate(await home(), call);
    assert.equal(results.length, commands.length);
    for (const [index, result] of results.entries()) assert.ok(['absent', 'denied'].includes(result), commands[index]);
  });

  await t.test('站内跳转留在窗口里，网页后退能回来', async () => {
    await click('to-page2');
    await pageAt((url) => url === HOME + 'page2.html', '第二页');
    await evaluate(await pageAt((url) => url.endsWith('page2.html'), '第二页'), 'history.back()');
    await pageAt((url) => url === HOME, '回到首页');
  });

  await t.test('外部网页交给系统浏览器，主窗口仍停在测试首页、不落到离线页', async () => {
    await click('external');
    await waitFor(() => site.requests.some((r) => r.host.startsWith('localhost:') && r.path === '/external.html'), '系统浏览器打开外部网页');
    await staysHome('点外部链接之后');
  });

  for (const [id, what] of [['popup', '站内新窗口'], ['popup-noreferrer', '带 rel="noreferrer" 的站内新窗口']]) {
    await t.test(`${what}在外壳里打开，网页自己关掉时整个窗口一起关`, async () => {
      const opened = (await pages()).length;
      await click(id);
      await waitFor(async () => (await pages()).length > opened, '新窗口出现');
      assert.equal(visible(), 2, '外壳进程里多了一个看得见的窗口');
      await evaluate(await pageAt((url) => url === HOME + 'page2.html', '新窗口里的第二页'), 'window.close()');
      await waitFor(async () => (await pages()).length === opened, '新窗口里的网页关掉');
      await waitFor(() => visible() === 1, '新窗口本身也关掉', 5000);
    });
  }

  await t.test('blob: 下载真的存进“下载”文件夹', async () => {
    await evaluate(await home(), `location.href = ${JSON.stringify(HOME + '?run=' + run)}`);
    await pageAt((url) => url === HOME + '?run=' + run, '带编号的首页');
    await click('blob');
    await savedFile(files.blob);
    assert.equal(readFileSync(join(downloads, files.blob), 'utf8'), 'YONGLE-SHELL-BLOB-TEST\n');
  });

  await t.test('照 ERP 写法导出的送货单（Blob 加 a.download、中文文件名）直接存进“下载”，不弹框、不落到离线页', async () => {
    await click('export');
    await savedFile(files.export);
    assert.equal(readFileSync(join(downloads, files.export), 'utf8'), 'YONGLE-SHELL-EXPORT-TEST\n');
    // WebView2 要人点允许的权限框是一个 edge:// 页面；另存为对话框不会弹（文件已经不经人点就落盘了）
    assert.ok(!(await pages()).some((p) => p.url.startsWith('edge://')), '没有弹出要人点的框');
    assert.equal(visible(), 1, '外壳没多出窗口');
    await staysHome('导出之后');
  });

  await t.test('普通下载也真的存进“下载”文件夹，主窗口不落到离线页', async () => {
    await click('http-download');
    await savedFile(files.http);
    assert.equal(readFileSync(join(downloads, files.http), 'utf8'), 'YONGLE-SHELL-HTTP-TEST\n');
    await staysHome('下载之后');
  });

  await t.test('新窗口里打开的下载也存进“下载”，不留下空白窗口', async () => {
    await click('popup-download');
    await savedFile(files.popup);
    await waitFor(() => visible() === 1, '只剩主窗口', 10000);
  });

  await t.test('点 × 收进托盘：进程还在，窗口不见了', async () => {
    win32('close', app.pid);
    await waitFor(() => visible() === 0, '窗口隐藏');
    assert.equal(app.exitCode, null);
    assert.equal(win32('state', app.pid).count, 1);
  });

  await t.test('再次启动只唤起原来的窗口，不开第二个', async () => {
    const second = launch(dataDir);
    await exited(second, 15000);
    await waitFor(() => visible() === 1, '原来的窗口重新显示');
    assert.equal(app.exitCode, null);
  });

  await t.test('ERP 服务停着时落到离线页，起来后点“重试”恢复', async () => {
    app.kill();
    await exited(app, 10000);
    await site.close();
    app = launch(dataDir);
    // 外壳自带的页面还有启动画面 splash.html，只认离线页
    const offline = await pageAt((url) => url.startsWith(OFFLINE), '离线页');
    // 连不上的结果来得很快（可能早于启动画面建好），启动画面照样马上收尾、露出主窗口，不用等 8 秒
    await revealed('落到离线页后启动画面关掉、主窗口露面');
    await waitFor(async () => (await evaluate(offline, 'document.body.innerText')).includes('暂时无法连接 ERP'), '离线提示');
    site = await startSite();
    await evaluate(offline, `document.querySelector('.retry').click()`);
    await home();
  });

  await t.test('带开机自启参数启动：不出启动画面和主窗口，点托盘图标后出现', async () => {
    app.kill();
    await exited(app, 10000);
    // 要点托盘图标，从副本启动（见 launchCopy）；启动画面和主窗口标题一样，窗口一直只有一个、看不见就是两个都没出
    app = launchCopy(appCopy, dataDir, ['--autostart']);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const state = win32('state', app.pid);
      assert.ok(state.count <= 1 && state.visible === 0, '开机自启时冒出了窗口：' + JSON.stringify(state));
      await sleep(250);
    }
    assert.equal(win32('state', app.pid).count, 1, '主窗口在后台建好了');
    assert.equal(win32('tray-click', app.pid).clicked, 1, '找到托盘图标的窗口');
    await waitFor(() => visible() === 1, '点托盘图标后主窗口出现', 5000);
  });
});
