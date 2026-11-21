// 网页最底部的备案号（src/FilingLine.tsx）：本机打开不显示；模拟从域名访问（带转发头，server.mts 补虚构备案号）时
// 登录页最底部和登录后的页脚都有、链到工信部备案查询、不多出滚动条（电脑、手机宽度）；安卓 App、Windows 客户端里不显示。虚构数据。
import { BASE, SP, fail, ok, openChrome, signIn, step } from './lib.mjs';

const DOMAIN = { extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.9' } };
const ICP = '虚构ICP备00000000号';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 16; V2359A) AppleWebKit/537.36 Chrome/156.0 Mobile Safari/537.36 YongleErpAndroid/0.1.0';
const desktop = { width: 1440, height: 900 },
  phone = { width: 375, height: 812, isMobile: true, hasTouch: true };

/** 打开登录页，返回页面；init 是页面脚本加载前先跑的（模拟 Windows 客户端注入的标记） */
async function openLogin(options, init) {
  const chrome = await openChrome(options);
  if (init) await chrome.page.addInitScript(init);
  await chrome.page.goto(BASE);
  await chrome.page.locator('.login-card').waitFor();
  return chrome;
}
/** 等登录状态读到、页面画完再数（备案号跟着登录状态出来） */
const settled = (page) => page.waitForLoadState('networkidle');

async function expectNone(what, options, init) {
  const { context, page } = await openLogin(options, init);
  await step(page, what, async () => {
    await settled(page);
    if (await page.locator('.filing-line').count()) fail(what + '：不该显示备案号');
    else ok(what + '：不显示备案号');
  });
  await context.close();
}

async function expectShown(label, options) {
  const { context, page, consoleErrors } = await openLogin({ ...options, ...DOMAIN });
  await step(page, label + '登录页最底部有备案号', async () => {
    const link = page.locator('.login-screen .filing-line a');
    await link.waitFor();
    if ((await link.innerText()) !== ICP) fail('备案号的字不对：' + (await link.innerText()));
    if ((await link.getAttribute('href')) !== 'https://beian.miit.gov.cn/') fail('ICP 备案号没有链到工信部备案查询');
    if ((await link.getAttribute('target')) !== '_blank') fail('备案号链接没有在新标签页打开');
    const box = await page.locator('.filing-line').boundingBox(),
      card = await page.locator('.login-card').boundingBox();
    if (!box || !card || box.y < card.y + card.height) fail('备案号不在登录卡片下面');
    const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    if (overflow > 0) fail(`登录页因为备案号多出了滚动条（多 ${overflow}px）`);
    await page.screenshot({ path: `${SP}/filing-${label}-登录页.png` });
    ok(label + '登录页最底部显示备案号，没有多出滚动条');
  });
  await step(page, label + '登录后页脚有备案号', async () => {
    await signIn(page);
    const line = page.locator('main > footer .filing-line');
    await line.waitFor();
    await line.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SP}/filing-${label}-页脚.png` });
    ok(label + '登录后页脚显示备案号');
  });
  if (consoleErrors.length) fail(label + '控制台报错：' + consoleErrors.join(' | ').slice(0, 300));
  await context.close();
}

await expectNone('本机打开', desktop);
await expectShown('电脑', desktop);
await expectShown('手机', phone);
await expectNone('安卓 App 里', { ...phone, ...DOMAIN, userAgent: ANDROID_UA });
await expectNone('Windows 客户端里', { ...desktop, ...DOMAIN }, () => {
  // Tauri 往 Windows 客户端打开的每个网页注入的对象（docs/架构说明.md“网页怎么认出两个外壳”）
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {} });
});
