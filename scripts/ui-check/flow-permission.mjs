// 没有财务权限的账号：导航不显示财务，直接打开地址有明确提示。顺带确认按需加载的页面都能打开。
import { fail, go, login, openAssistant, openChrome } from './lib.mjs';
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
await login(page, '虚构业务员');
if (await page.getByRole('button', { name: '财务', exact: true }).count()) fail('无权限账号看到了财务导航');
await go(page, '#finance');
await page.waitForTimeout(500);
if (!(await page.getByText('当前账号没有财务权限').count())) fail('无权限账号打开财务地址没有提示');
// 按需加载的页面：内容要出来，不能停在加载提示上
for (const [hash, text] of [
  ['#production', '生产任务'],
  ['#warehouse', '库存'],
  ['#purchases', '采购单'],
  ['#suppliers', '供应商'],
  ['#ai-import', 'AI 导入'],
  ['#ai-settings', '设置'],
  ['#orders', '订单'],
]) {
  await go(page, hash);
  await page.waitForTimeout(800);
  const main = await page.locator('main').innerText();
  if (main.includes('正在打开页面') || !main.includes(text)) fail(hash + ' 没有正常显示');
  else console.log(hash, 'ok');
}
// 助手按需加载后要能打开
await openAssistant(page);
console.log('助手 ok');
const real = [...new Set(consoleErrors)].filter((e) => !/status of (403|503)/.test(e));
if (real.length) fail('控制台报错 ' + real.join(' | ').slice(0, 300));
await context.close();
