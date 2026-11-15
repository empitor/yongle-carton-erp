// 用本机 Chrome 打开隔离实例，临时配置目录，不碰用户的 Chrome 配置和真实数据。
// 流程中途出错（没接住的异常）时，把每个打开着的页面截图、存 Playwright trace（npx playwright show-trace 回放），再退出。
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright-core');
export const BASE = 'http://127.0.0.1:' + (process.env.UI_CHECK_PORT || '3199') + '/';
export const SP = process.env.UI_CHECK_DIR;
export const SERVER_SOURCE = new URL('./server.mts', import.meta.url);

export const fail = (message) => console.log('ERR: ' + message);
export const ok = (message) => console.log('ok ' + message);
export const dialogOf = (page) => page.locator('[role="dialog"][aria-modal="true"]').last();

const opened = new Set();
export async function openChrome({ width = 1440, height = 900, deviceScaleFactor = 1, ...device } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'erp-chrome-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'),
    headless: true,
    viewport: { width, height },
    deviceScaleFactor,
    ...device,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  opened.add(context);
  context.on('close', () => opened.delete(context));
  const page = context.pages()[0] || (await context.newPage());
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  return { context, page, consoleErrors };
}

// 中途出错的出口：打印哪一步错了、截图、存 trace，然后退出码 1（run.mjs 记成“中途失败”）
const flowName = basename(process.argv[1] || 'flow').replace(/\.m?js$/, '');
let failing = false;
async function failHard(error) {
  if (failing) return;
  failing = true;
  const lines = String(error?.stack || error).split('\n');
  fail(flowName + ' 中途出错：' + lines[0]);
  console.log(lines.slice(1, 6).join('\n'));
  const out = SP || tmpdir();
  let i = 0;
  for (const context of opened) {
    i++;
    for (const page of context.pages()) {
      console.log('  出错时的地址：' + page.url());
      const errors = await page.locator('.error, .form-error, [role=alert]').allInnerTexts().catch(() => []);
      if (errors.length) console.log('  页面上的报错：' + errors.join(' | ').slice(0, 300));
      await page.screenshot({ path: `${out}/FAIL-${flowName}-${i}.png`, timeout: 5000 }).catch(() => {});
    }
    await context.tracing.stop({ path: `${out}/FAIL-${flowName}-${i}.zip` }).catch(() => {});
    console.log('  现场：' + `${out}/FAIL-${flowName}-${i}.png`.replaceAll('\\', '/') + '，trace：' + `FAIL-${flowName}-${i}.zip`);
    await context.close().catch(() => {});
  }
  process.exit(1);
}
process.on('uncaughtException', failHard);
process.on('unhandledRejection', failHard);

/** 控制台报错算问题；allow 是这个流程故意造出来的（比如拦截回的状态码），不算 */
export function checkConsole(errors, allow = /status of 401/) {
  const real = [...new Set(errors)].filter((e) => !allow.test(e));
  if (real.length) fail('控制台报错：' + real.join(' | ').slice(0, 300));
}

/** 一步一步走：这一步出错只记一条 ERR、截图，接着走下一步 */
export async function step(page, name, fn) {
  try {
    await fn();
  } catch (e) {
    fail(name + ' 中途出错：' + String(e.message).split('\n')[0]);
    await page.screenshot({ path: `${SP || tmpdir()}/出错-${flowName}-${name}.png` }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  }
}

/** 用 server.mts 里的虚构账号登录，默认虚构管理员。 */
export async function login(page, name = '虚构管理员', base = BASE) {
  await page.goto(base);
  await page.locator('.login-screen input').nth(0).fill(name);
  await page.locator('.login-screen input').nth(1).fill(passwordOf(name));
  await page.locator('.login-screen input').nth(1).press('Enter');
  await page.locator('.shell').waitFor();
}
export function passwordOf(name) {
  const account = new RegExp("add\\('" + name + "',\\s*'([^']+)'").exec(readFileSync(SERVER_SOURCE, 'utf8'));
  if (!account) throw new Error('server.mts 里没有账号 ' + name);
  return account[1];
}

/**
 * 打开助手面板，等输入框出来。助手是按需加载的：先等它挂上页面再按 Ctrl+J（手机点底部“助手”），
 * 不和代码加载抢。
 */
export async function openAssistant(page, { mobile = false } = {}) {
  const assistant = page.locator('[data-global-assistant]');
  await assistant.waitFor({ state: 'attached' });
  if (mobile) await page.locator('.mobile-tabbar').getByRole('button', { name: '助手', exact: true }).tap();
  else await page.keyboard.press('Control+j');
  const box = assistant.locator('.ga-panel textarea').first();
  await box.waitFor();
  return box;
}

/**
 * 等这次操作的页面提示（底部提示、列表上方的结果）：只认新出现或文字变了的那条，上一步留下还没消失的不算。
 * 读到后把页面上现有的提示都记成看过。pattern 只认文字对得上的。一直没有新的返回“（没有新的提示）”。
 */
export async function notice(page, pattern) {
  for (let i = 0; i < 80; i++) {
    const text = await page.evaluate((source) => {
      const all = [...document.querySelectorAll('.toast, .success-banner, .business-result')];
      const fresh = all.filter((el) => el.textContent.trim() && el.dataset.uiSeen !== el.textContent && (!source || new RegExp(source).test(el.textContent)));
      if (!fresh.length) return '';
      for (const el of all) el.dataset.uiSeen = el.textContent;
      return fresh.map((el) => el.textContent.trim()).join(' | ');
    }, pattern ? new RegExp(pattern).source : '');
    if (text) return text;
    await page.waitForTimeout(100);
  }
  return '（没有新的提示）';
}

/** 助手确认卡片核对区的按钮不能超出助手窗口、文字不能被截断（停靠时窗口窄） */
export async function reviewButtonsFit(page) {
  const bad = await page.evaluate(() => {
    const panel = document.querySelector('[data-global-assistant] .ga-panel').getBoundingClientRect();
    return [...document.querySelectorAll('[data-global-assistant] .ga-review-actions button')]
      .filter((b) => b.getBoundingClientRect().right > panel.right + 0.5 || b.scrollWidth > b.clientWidth + 1)
      .map((b) => b.textContent);
  });
  if (bad.length) fail('核对区按钮超出助手窗口或文字被截断：' + bad.join('、'));
}

export async function go(page, hash) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  // 留一会儿给列表取数；按需加载的页面再等“正在打开页面”消失
  await page.waitForTimeout(300);
  await page.getByText('正在打开页面').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

/**
 * 对当前页面跑 axe 无障碍检查，返回每处违规的目标和说明。
 * 只查 WCAG 2.1 A/AA 的规则（axe 的 wcag2a、wcag2aa、wcag21a、wcag21aa 标签）。
 */
export async function a11yViolations(page) {
  const { AxeBuilder } = require('@axe-core/playwright');
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return violations.map((v) => ({
    rule: v.id,
    impact: v.impact ?? '未标',
    help: v.help,
    nodes: v.nodes.map(({ target, html, failureSummary }) => ({ target, html, failureSummary })),
  }));
}

/** 业务日期按北京时间，和程序 shared/core/domain.ts 的 today() 同一算法；days 往后数几天 */
export const businessDay = (days = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(Date.now() + days * 86400000),
  );

/** 带登录防伪令牌调接口（和页面上 call() 发的一样）；出错返回 { error, status } */
export const call = (page, method, path, body) =>
  page.evaluate(
    async ([m, p, b]) => {
      const { csrf } = await (await fetch('/api/auth/state')).json();
      const r = await fetch('/api' + p, {
        method: m,
        headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': csrf },
        ...(m === 'GET' ? {} : { body: JSON.stringify(b ?? {}) }),
      });
      const value = await r.json().catch(() => ({}));
      return r.ok ? value : { error: value.message || value.error || String(r.status), status: r.status };
    },
    [method, path, body],
  );
