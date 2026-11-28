// 没有财务权限的账号：导航不显示财务，直接打开地址有明确提示，今日页不发到期提醒请求。顺带确认按需加载的页面都能打开。
// 设置：业务员只有“单据模板”页签，从提示词、API 配置、高级的旧链接进来也落到单据模板，不发越权请求；
// 助手“更多”里没有插件与工具、管理提示词，自己的记忆照常加、改、删。管理员照常看到全部页签。
import { BASE, SP, fail, go, login, ok, openAssistant, openChrome } from './lib.mjs';
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });

/** 打开今日页（整页载入），等分组出来再多等一会儿，记下这期间发出的“近期到期应收应付”请求（src/records/useTodayData.ts） */
async function dueSoonRequests(p) {
  const sent = [];
  const watch = (req) => req.url().includes('/api/finance/due-soon') && sent.push(new URL(req.url()).pathname);
  p.on('request', watch);
  // 登录后多半已经停在 #dashboard，只改 hash 不会重新载入，所以再整页刷新一次
  await p.goto(BASE + '#dashboard');
  await p.reload();
  await p.locator('.td-groups').waitFor();
  await p.waitForTimeout(800);
  p.off('request', watch);
  return sent;
}

await login(page, '虚构业务员');
// 今日页：没有财务权限的业务员不发到期提醒请求（发了就是一条 403 进控制台）；管理员那边在文件末尾看一定发
const staffDue = await dueSoonRequests(page);
if (staffDue.length) fail('业务员打开今日页发了到期提醒请求：' + staffDue.join(' | '));
else ok('业务员打开今日页不发到期提醒请求');
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

/** 设置页最上面那一排页签（单据模板页里还有自己的分类页签） */
const TABS = 'main nav[aria-label="设置分类"]';
/** 打开设置的各个链接，记下看到的页签、选中的页签和这期间回 4xx 的请求 */
async function settingsTabs(hashes) {
  const denied = [];
  const watch = (res) => res.url().includes('/api/') && res.status() >= 400 && denied.push(res.status() + ' ' + new URL(res.url()).pathname);
  page.on('response', watch);
  const seen = [];
  for (const hash of hashes) {
    await go(page, hash);
    await page.locator(TABS).waitFor();
    await page.waitForTimeout(500);
    const tabs = (await page.locator(TABS + ' [role="tab"]').allInnerTexts()).map((t) => t.trim());
    const selected = (await page.locator(TABS + ' [role="tab"][aria-selected="true"]').innerText()).trim();
    seen.push({ hash, tabs, selected });
  }
  page.off('response', watch);
  return { seen, denied };
}
const staffSettings = await settingsTabs(['#ai-settings', '#ai-settings?tab=prompts', '#ai-settings?tab=api', '#ai-settings?tab=tools']);
for (const { hash, tabs, selected } of staffSettings.seen)
  if (tabs.join('、') !== '单据模板' || selected !== '单据模板') fail('业务员打开 ' + hash + ' 看到的页签：' + tabs.join('、') + '（选中 ' + selected + '）');
if (staffSettings.denied.length) fail('业务员打开设置触发了 4xx 请求：' + staffSettings.denied.join(' | '));
await go(page, '#ai-settings?tab=prompts');
await page.locator('main [role="tabpanel"]').first().waitFor();
await page.screenshot({ path: SP + '/permission-业务员设置.png' });
ok('业务员的设置只有单据模板，tab=prompts 等旧链接落到单据模板，零 4xx');

// 助手按需加载后要能打开；“更多”里没有去管理员页签的入口，记忆照常
const box = await openAssistant(page);
console.log('助手 ok');
const panel = page.locator('[data-global-assistant] .ga-panel');
await panel.locator('.ga-header .more-menu > summary').click();
const items = (await panel.locator('.ga-header .more-menu-list [role=menuitem]').allInnerTexts()).map((t) => t.trim());
for (const hidden of ['插件与工具', '管理提示词']) if (items.includes(hidden)) fail('业务员的助手“更多”里还有' + hidden);
if (!items.includes('记忆')) fail('业务员的助手“更多”里没有记忆：' + items.join('、'));
await panel.locator('.ga-header .more-menu-list [role=menuitem]', { hasText: '记忆' }).click();
const memory = panel.locator('section[aria-label="记忆"]');
const note = '虚构：客户甲的报价以后都按含税算 ' + Date.now();
await memory.getByLabel('手动加一条记忆').fill(note);
await memory.getByRole('button', { name: '记住' }).click();
const row = memory.locator('.ga-memory-item', { hasText: note });
await row.waitFor({ timeout: 8000 });
await row.getByRole('button', { name: '改' }).click();
await memory.getByLabel('编辑这条记忆').fill(note + '（改过）');
await memory.getByRole('button', { name: '保存' }).click();
const changed = memory.locator('.ga-memory-item', { hasText: '（改过）' });
await changed.waitFor({ timeout: 8000 });
await page.screenshot({ path: SP + '/permission-业务员记忆.png' });
await changed.getByRole('button', { name: '删' }).click();
await changed.waitFor({ state: 'detached', timeout: 8000 });
await memory.getByRole('button', { name: '返回聊天' }).click();
await box.waitFor();
ok('业务员的助手“更多”里没有插件与工具、管理提示词；自己的记忆加、改、删都成');
const real = [...new Set(consoleErrors)].filter((e) => !/status of (403|503)/.test(e));
if (real.length) fail('控制台报错 ' + real.join(' | ').slice(0, 300));
await context.close();

// 管理员照常看到设置的全部页签
const admin = await openChrome({ width: 1440, height: 900 });
await login(admin.page, '虚构管理员', BASE);
await go(admin.page, '#ai-settings?tab=prompts');
await admin.page.locator(TABS).waitFor();
const adminTabs = (await admin.page.locator(TABS + ' [role="tab"]').allInnerTexts()).map((t) => t.trim());
if (adminTabs.join('、') !== 'API 配置、提示词、单据模板、消息接入、高级') fail('管理员的设置页签不全：' + adminTabs.join('、'));
const adminSelected = (await admin.page.locator(TABS + ' [role="tab"][aria-selected="true"]').innerText()).trim();
if (adminSelected !== '提示词') fail('管理员打开 tab=prompts 选中的是 ' + adminSelected);
await admin.page.screenshot({ path: SP + '/permission-管理员设置.png' });
ok('管理员的设置五个页签都在，tab=prompts 打开提示词');
// 对照：能看财务的管理员打开今日页照常取到期提醒（上面业务员那条不发才有意义）
if (!(await dueSoonRequests(admin.page)).length) fail('管理员打开今日页没有取到期提醒');
else ok('管理员打开今日页照常取到期提醒');
await admin.context.close();
