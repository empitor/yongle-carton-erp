// 网页最底部的备案号（src/FilingLine.tsx）：普通浏览器里填了就显示、链到备案查询；两个应用程序里、没填都不显示
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filingLinks } from '../src/FilingLine.js';

const browser = { navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156.0 Safari/537.36 Edg/156.0' } };
const icp = '虚构ICP备00000000号',
  police = '虚构公网安备 33020300000000号';

test('普通浏览器里填了备案号：ICP 链工信部备案查询，公安号原样显示、按号里的数字链公安备案查询', () => {
  assert.deepEqual(filingLinks({ icp, police }, browser), [
    { text: icp, href: 'https://beian.miit.gov.cn/' },
    { text: police, href: 'https://beian.mps.gov.cn/#/query/webSearch?code=33020300000000' },
  ]);
  assert.deepEqual(filingLinks({ icp }, browser), [{ text: icp, href: 'https://beian.miit.gov.cn/' }]);
});

test('没填备案号时什么都不显示', () => {
  assert.deepEqual(filingLinks(undefined, browser), []);
  assert.deepEqual(filingLinks({}, browser), []);
});

test('安卓 App（User-Agent 带标记）和 Windows 客户端（页面上有 Tauri 注入的对象）里不显示', () => {
  const android = { navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 16) Chrome/156.0 Mobile Safari/537.36 YongleErpAndroid/0.1.0' } };
  assert.deepEqual(filingLinks({ icp }, android), []);
  const windowsClient = { ...browser, __TAURI_INTERNALS__: {} };
  assert.deepEqual(filingLinks({ icp }, windowsClient), []);
});
