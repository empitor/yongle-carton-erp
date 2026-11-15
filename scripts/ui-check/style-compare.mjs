// 样式改前改后比对：同一批页面和状态（style-scenes.mjs），电脑和手机宽度、浅色和深色，
// 每个状态截图、导出每个元素计算后的样式（只留和版式有关的属性）和位置大小、记下哪些样式规则命中过。
// 先存基线，改完样式再跑一次对比：哪些元素的样式变了、截图差多少像素、哪些规则从没命中。
//
// 用法：
//   node scripts/ui-check/style-compare.mjs baseline   存基线（默认跑两遍，两遍之间会变的元素和像素记成“抖动”，以后对比时跳过）
//   node scripts/ui-check/style-compare.mjs compare    再跑一遍，和基线比，结果写进 <目录>/对比结果.md；有差异时退出码 1
//   node scripts/ui-check/style-compare.mjs diff       不跑，只把已有的 current 和基线重新比一次
//   node scripts/ui-check/style-compare.mjs --list     列出全部页面和状态
// 选项：--dir 目录（默认 系统临时目录/erp-style-compare）  --modes desktop-light,mobile-dark  --only 正则（按状态名筛）
//       --once（baseline 只跑一遍，不算抖动）  --port 端口（默认 3195）
//
// 自己构建到临时目录、起隔离实例（虚构数据，和 npm run test:ui 同一套 server.mts），用完关掉。不碰真实数据和项目的 dist。
// 页面和状态清单在 style-scenes.mjs，在页面里取样式、记命中的两段在 style-page.mjs，比较和出结果在 style-diff.mjs。
// 两次要在同一天跑（种子数据里的日期跟着今天走）；改样式前后都用同一份代码跑，组件改了会算成“结构变了”。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scenes,
  setupScenes,
  enableFinance,
  ignoreSelectors,
  screenshotMask,
} from './style-scenes.mjs';
import { compare, computeUnstable } from './style-diff.mjs';
import { hitsInPage, snapshotInPage } from './style-page.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const here = fileURLToPath(new URL('./', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const command = args[0] && !args[0].startsWith('--') ? args[0] : '';
const port = option('--port', '3195');
const dir = option('--dir', join(tmpdir(), 'erp-style-compare'));
const only = option('--only') ? new RegExp(option('--only')) : null;

const MODES = {
  'desktop-light': { label: '电脑浅色', width: 1440, height: 900, colorScheme: 'light' },
  'desktop-dark': { label: '电脑深色', width: 1440, height: 900, colorScheme: 'dark' },
  'mobile-light': {
    label: '手机浅色',
    width: 390,
    height: 844,
    colorScheme: 'light',
    isMobile: true,
    hasTouch: true,
  },
  'mobile-dark': {
    label: '手机深色',
    width: 390,
    height: 844,
    colorScheme: 'dark',
    isMobile: true,
    hasTouch: true,
  },
};
const modes = (option('--modes') || Object.keys(MODES).join(','))
  .split(',')
  .filter((m) => MODES[m]);

if (args.includes('--list')) {
  for (const s of [
    ...setupScenes.map((s) => ({ ...s, modes: ['desktop-light'] })),
    { id: '登录页', hash: '' },
    ...scenes,
  ])
    console.log(s.id.padEnd(22) + (s.hash || '').padEnd(42) + (s.modes || modes).join(','));
  console.log(`共 ${setupScenes.length + 1 + scenes.length} 个状态`);
  process.exit(0);
}
if (!['baseline', 'compare', 'diff'].includes(command)) {
  console.error(
    '用法：node scripts/ui-check/style-compare.mjs baseline|compare|diff [--dir 目录] [--modes …] [--only 正则]',
  );
  process.exit(2);
}

// 和版式有关的计算样式（宽高用元素的位置大小，另记）
// prettier-ignore
const PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear', 'box-sizing', 'margin-top',
  'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style',
  'border-right-style', 'border-bottom-style', 'border-left-style', 'border-top-color', 'border-right-color',
  'border-bottom-color', 'border-left-color', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius', 'min-width', 'max-width', 'min-height', 'max-height',
  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order', 'justify-content', 'justify-items',
  'align-items', 'align-self', 'align-content', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows',
  'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end', 'grid-auto-flow', 'overflow-x',
  'overflow-y', 'visibility', 'opacity', 'transform', 'container-type', 'font-family', 'font-size', 'font-weight',
  'font-style', 'line-height', 'letter-spacing', 'font-variant-numeric', 'text-align', 'text-transform',
  'text-decoration-line', 'text-overflow', 'white-space', 'word-break', 'overflow-wrap', 'vertical-align', 'color',
  'background-color', 'background-image', 'box-shadow', 'outline-style', 'outline-width', 'outline-color', 'cursor',
  'list-style-type', 'table-layout', 'border-collapse', 'object-fit', 'filter', 'backdrop-filter', 'fill', 'stroke',
];
// prettier-ignore
const PSEUDO_PROPS = [
  'content', 'display', 'position', 'top', 'left', 'width', 'height', 'color', 'background-color', 'border-top-width',
  'border-left-width', 'border-bottom-width', 'border-top-color', 'border-left-color', 'font-size', 'transform',
];

// ---------- 起实例、跑一遍 ----------
async function buildAndServe(work) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const env = {
    ...process.env,
    UI_CHECK_DIR: work.replaceAll('\\', '/'),
    UI_CHECK_PORT: port,
    UI_CHECK_REMOTE: '',
    LOCALAPPDATA: join(work, 'localappdata'),
    ERP_CONFIG_DIR: join(work, 'config'),
    DB_PATH: join(work, 'never-used.sqlite'),
  };
  const alive = () =>
    fetch(`http://127.0.0.1:${port}/api/auth/state`).then(
      () => true,
      () => false,
    );
  if (await alive())
    throw new Error(`端口 ${port} 已被占用，先关掉上一个实例，或用 --port 换一个。`);
  const vite = join(root, 'node_modules/vite/bin/vite.js');
  const built = spawnSync(
    process.execPath,
    [vite, 'build', '--outDir', join(work, 'dist'), '--emptyOutDir'],
    { cwd: root, env, encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  if (built.status !== 0)
    throw new Error(
      '构建失败：\n' + (built.stdout + built.stderr).split('\n').slice(-15).join('\n'),
    );
  const server = spawn(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), join(here, 'server.mts')],
    { cwd: work, env, stdio: 'ignore' },
  );
  for (let i = 0; i < 90 && !(await alive()); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!(await alive())) {
    server.kill();
    throw new Error('隔离实例没有启动');
  }
  return async () => {
    server.kill();
    await new Promise((r) => (server.exitCode === null ? server.once('close', r) : r()));
  };
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
  // 动画停住：有限次的直接放完，循环的停在开头
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      try {
        if (a.effect?.getComputedTiming?.().iterations === Infinity) {
          a.pause();
          a.currentTime = 0;
        } else a.finish();
      } catch {
        /* 有的动画不让停，跳过 */
      }
    }
  });
  await page.mouse.move(0, 0).catch(() => {});
  await page.waitForTimeout(100);
}

/** 先取样式、记命中，最后截图：整页截图要临时改窗口大小，“更多”菜单这类遇到窗口变化会自己关掉，
 *  所以点开过东西的状态只截当前窗口，没点过的页面截整页。 */
async function capture(page, { out, known, log }, id, { fullPage = true } = {}) {
  await settle(page);
  const snap = await page.evaluate(snapshotInPage, {
    props: PROPS,
    pseudoProps: PSEUDO_PROPS,
    ignore: ignoreSelectors,
  });
  writeFileSync(join(out, id + '.json'), JSON.stringify({ url: page.url(), fullPage, ...snap }));
  const h = await page.evaluate(hitsInPage, known);
  for (const k of h.hit) known[k] = id;
  log.all ??= new Set();
  for (const k of h.all) log.all.add(k);
  log.untestable ??= new Set();
  for (const k of h.untestable) log.untestable.add(k);
  await page.screenshot({
    path: join(out, id + '.png'),
    fullPage,
    animations: 'disabled',
    caret: 'hide',
    mask: ignoreSelectors.map((s) => page.locator(s)),
    // 截图那一下把这些藏起来（只影响截图，上面导出的样式不受影响）
    style: screenshotMask.map((s) => s + ' { visibility: hidden !important; }').join('\n'),
  });
}

const firstLine = (e) =>
  String(e.message || e)
    .split('\n')[0]
    .slice(0, 160);

/** 一个状态：清掉本地存储、离开再进来、做动作、取样式截图。返回 'ok' 或造不出来的原因 */
async function captureScene(page, s, { base, sink, collectCoverage }) {
  try {
    await page.evaluate((key) => {
      const theme = localStorage.getItem(key);
      localStorage.clear();
      sessionStorage.clear();
      if (theme) localStorage.setItem(key, theme);
    }, 'zhixu-erp.theme');
    // 只差 # 后面的地址，goto 不会重新加载，上一个状态打开的菜单、详情会留着；先离开再进来
    await collectCoverage();
    await page.coverage.startCSSCoverage();
    await page.goto('about:blank');
    await page.goto(base + (s.hash || '#'));
    await page.locator('.shell').waitFor({ timeout: 10000 });
    await settle(page);
    if (s.act) await s.act(page);
    await capture(page, sink, s.id, { fullPage: !s.act });
    return 'ok';
  } catch (e) {
    return '造不出来：' + firstLine(e);
  }
}

/** 一种模式（电脑/手机、浅色/深色）里把一组状态都截一遍，结果记进 status[mode] */
async function runMode({ base, passDir, status, openChrome, login }, mode, list, { setup = false } = {}) {
  const out = join(passDir, mode);
  mkdirSync(out, { recursive: true });
  const { label, ...device } = MODES[mode];
  const { context, page } = await openChrome({
    ...device,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  // 离开页面后 Chrome 不再报那一页样式表的覆盖率，所以每个状态离开前收一次
  const coverage = [];
  const collectCoverage = async () => {
    const cov = await page.coverage.stopCSSCoverage().catch(() => []);
    for (const c of cov) coverage.push({ url: c.url, total: c.text.length, ranges: c.ranges });
  };
  await page.coverage.startCSSCoverage();
  const sink = { out, known: {}, log: {} };
  const st = (status[mode] ??= {});
  try {
    if (!setup) {
      await page.goto(base);
      await page.locator('.login-screen').waitFor();
      if (!only || only.test('登录页')) {
        await capture(page, sink, '登录页');
        st['登录页'] = 'ok';
      }
    }
    await login(page, '虚构管理员', base);
    for (const s of list) {
      if (s.modes && !s.modes.includes(mode)) continue;
      if (only && !only.test(s.id) && !s.always) continue;
      st[s.id] = await captureScene(page, s, { base, sink, collectCoverage });
    }
    if (setup)
      await enableFinance(page).catch((e) => {
        st['启用财务'] = '没启用上：' + firstLine(e);
      });
  } finally {
    await collectCoverage();
    writeFileSync(join(out, '_coverage.json'), JSON.stringify(coverage));
    writeFileSync(
      join(out, '_hits.json'),
      JSON.stringify({
        hit: sink.known,
        all: [...(sink.log.all || [])],
        untestable: [...(sink.log.untestable || [])],
      }),
    );
    await context.close();
  }
}

async function runPass(passDir) {
  process.env.UI_CHECK_PORT = port;
  const { openChrome, login } = await import('./lib.mjs');
  const base = `http://127.0.0.1:${port}/`;
  const work = join(dir, 'instance');
  const stop = await buildAndServe(work);
  const status = {};
  const started = Date.now();
  try {
    rmSync(passDir, { recursive: true, force: true });
    const pass = { base, passDir, status, openChrome, login };
    const run = (mode, list, options) => runMode(pass, mode, list, options);
    // 准备阶段：未启用财务的样子和启用窗只在电脑浅色里截，然后启用财务
    const setupOut = join(passDir, 'desktop-light');
    await run(
      'desktop-light',
      setupScenes.map((s) => ({ ...s, always: true })),
      { setup: true },
    );
    // 准备阶段的覆盖率和命中另存，免得被正式那一轮覆盖
    for (const f of ['_coverage.json', '_hits.json']) {
      const p = join(setupOut, f);
      if (existsSync(p)) writeFileSync(join(setupOut, '_setup' + f), readFileSync(p));
    }
    status['desktop-light-setup'] = status['desktop-light'];
    delete status['desktop-light'];
    await Promise.all(modes.map((m) => run(m, scenes)));
    status['desktop-light'] = { ...status['desktop-light-setup'], ...status['desktop-light'] };
    delete status['desktop-light-setup'];
  } finally {
    await stop();
  }
  writeFileSync(join(passDir, '_status.json'), JSON.stringify(status, null, 1));
  const bad = Object.entries(status).flatMap(([m, s]) =>
    Object.entries(s)
      .filter(([, v]) => v !== 'ok')
      .map(([id, v]) => `${m} ${id} ${v}`),
  );
  console.log(
    `${passDir}：${Object.values(status).reduce((a, s) => a + Object.keys(s).length, 0)} 个状态，用了 ${Math.round((Date.now() - started) / 1000)} 秒` +
      (bad.length ? `，造不出来 ${bad.length} 个：\n  ` + bad.join('\n  ') : ''),
  );
  return status;
}

// ---------- 入口 ----------
mkdirSync(dir, { recursive: true });
if (command === 'baseline') {
  await runPass(join(dir, 'baseline'));
  if (!args.includes('--once')) {
    await runPass(join(dir, 'baseline-2'));
    const unstable = await computeUnstable(join(dir, 'baseline'), join(dir, 'baseline-2'), MODES);
    writeFileSync(join(dir, 'baseline', '_unstable.json'), JSON.stringify(unstable, null, 1));
    const n = Object.values(unstable).reduce((a, m) => a + Object.keys(m).length, 0);
    console.log(
      `基线存好了：${join(dir, 'baseline')}；两遍之间会变的状态 ${n} 个，已记成抖动，对比时跳过。`,
    );
  } else console.log(`基线存好了（只跑了一遍，没算抖动）：${join(dir, 'baseline')}`);
} else {
  if (command === 'compare') await runPass(join(dir, 'current'));
  const n = await compare({ dir, MODES, modeCount: modes.length });
  process.exitCode = n ? 1 : 0;
}
