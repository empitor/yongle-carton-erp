// 出纳这类纯财务账号：导航只有财务和使用说明，打开业务页面的地址会回到财务概览，手机底部是财务入口。
import { openChrome, BASE, SP, go } from './lib.mjs';
const fail = (message) => console.log('ERR: ' + message);
const run = async (viewport, label) => {
  const { context, page, consoleErrors } = await openChrome(viewport);
  await page.goto(BASE);
  await page.locator('.login-screen input').nth(0).fill('虚构出纳');
  await page.locator('.login-screen input').nth(1).fill('Fictional-Cashier-2026');
  await page.locator('.login-screen input').nth(1).press('Enter');
  await page.locator('.shell').waitFor();
  await page.waitForTimeout(800);
  const landed = await page.evaluate(() => location.hash);
  if (landed !== '#finance') fail(label + ' 登录后没有落到财务概览：' + landed);
  for (const hash of ['#orders', '#dashboard', '#inbox', '#ai-import']) {
    await go(page, hash);
    await page.waitForTimeout(500);
    const now = await page.evaluate(() => location.hash);
    if (now !== '#finance') fail(label + ' 打开 ' + hash + ' 没有回到财务概览：' + now);
  }
  if (await page.locator('.top-search').count()) fail(label + ' 出纳顶栏还有业务搜索');
  if (await page.locator('.top-new').count()) fail(label + ' 出纳顶栏还有新建');
  await page.screenshot({ path: `${SP}/c-${label}.png` });
  const real = [...new Set(consoleErrors)].filter((e) => !/status of (403|503)/.test(e));
  if (real.length) fail(label + ' 控制台报错 ' + real.join(' | ').slice(0, 300));
  return { context, page };
};
{
  const { context, page } = await run({ width: 1440, height: 900 }, '电脑');
  const nav = await page.locator('.erp-nav').innerText();
  for (const text of ['财务概览', '资金发票', '应收应付']) if (!nav.includes(text)) fail('导航缺少' + text);
  for (const text of ['订单', '收件箱', 'AI 导入', '今日', '库存']) if (nav.includes(text)) fail('出纳导航出现了' + text);
  const footer = await page.locator('.nav-footer').innerText();
  if (!footer.includes('使用说明') || footer.includes('设置') || footer.includes('归档'))
    fail('出纳导航底部应只有使用说明：' + footer.replace(/\s+/g, ' '));
  console.log('出纳电脑导航 ok');
  await context.close();
}
{
  const { context, page } = await run({ width: 390, height: 844, isMobile: true, hasTouch: true }, '手机');
  const tabs = await page.locator('.mobile-tabbar').innerText();
  for (const text of ['概览', '应收应付', '资金', '凭证']) if (!tabs.includes(text)) fail('手机底部缺少' + text);
  for (const text of ['今日', '订单', '生产', '仓库']) if (tabs.includes(text)) fail('手机底部出现了' + text);
  console.log('出纳手机导航 ok');
  await context.close();
}
