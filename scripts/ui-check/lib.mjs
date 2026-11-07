// 用本机 Chrome 打开隔离实例，临时配置目录，不碰用户的 Chrome 配置和真实数据。
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright-core');
export const BASE = 'http://127.0.0.1:3199/';
export const SP = process.env.UI_CHECK_DIR;
export const SERVER_SOURCE = new URL('./server.mts', import.meta.url);

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
  const page = context.pages()[0] || (await context.newPage());
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  return { context, page, consoleErrors };
}

export async function go(page, hash) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  await page.waitForTimeout(700);
}
