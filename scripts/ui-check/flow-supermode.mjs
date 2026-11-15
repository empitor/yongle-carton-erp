// 从域名访问时改全员共用的设置要先进超级管理员模式：账号管理、设置的 API 配置 / 提示词 / 消息接入 / 高级，
// 没进模式时顶上一句提示和“进入超级管理员模式”、写按钮不在；点它弹出系统维护窗口，输本人密码后窗口关掉、写按钮出现。
// 请求带 X-Forwarded-For，服务器不当成本机管理员（和 operations 的域名模式同一个做法）。电脑和手机宽度各看一遍。
import { BASE, SP, fail, login, ok, openChrome, passwordOf } from './lib.mjs';

const pages = [
  { name: '账号管理', hash: '#accounts', what: '新建和修改账号', write: (p) => p.locator('main').getByRole('button', { name: '新建账号' }) },
  { name: 'API 配置', hash: '#ai-settings?tab=api', what: '改密钥和识别设置', write: (p) => p.locator('section[aria-label="DeepSeek 密钥"] input') },
  { name: '提示词', hash: '#ai-settings?tab=prompts', what: '改提示词', write: (p) => p.getByRole('button', { name: '新建提示词预设' }) },
  { name: '消息接入', hash: '#ai-settings?tab=channels', what: '填写或更换机器人凭据', write: (p) => p.locator('main').getByRole('button', { name: /保存并/ }) },
  { name: '高级', hash: '#ai-settings?tab=tools', what: '启停工具', write: (p) => p.locator('main input[role="switch"]:not([disabled])') },
];
const remote = { extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.9' } };

/** 页面上一眼能看出的排版毛病：提示条横向超出、提示里的按钮出了提示条、每块区域实心主按钮多于一个 */
const layout = (page) =>
  page.evaluate(() => {
    const problems = [];
    const notice = [...document.querySelectorAll('main .form-message')].find((el) => el.textContent.includes('进入超级管理员模式'));
    if (notice) {
      const box = notice.getBoundingClientRect(),
        button = notice.querySelector('button')?.getBoundingClientRect();
      if (box.right > innerWidth + 1) problems.push('提示条超出屏幕右边');
      if (button && (button.right > box.right + 1 || button.bottom > box.bottom + 1)) problems.push('提示里的按钮出了提示条');
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push('页面横向溢出 ' + (document.documentElement.scrollWidth - innerWidth) + 'px');
    for (const area of document.querySelectorAll('main section, main article, main header, main .page-heading')) {
      const own = [...area.querySelectorAll('button.primary')].filter((b) => b.offsetParent && b.closest('section, article, header, .page-heading') === area);
      if (own.length > 1) problems.push('一块区域 ' + own.length + ' 个实心主按钮：' + own.map((b) => b.textContent.trim()).join('、'));
    }
    return problems;
  });

// 进了模式就看不到没进时的样子：一个窗口里每页先看电脑宽度、再缩到手机宽度看一遍，最后再进模式
const sizes = [['电脑', { width: 1440, height: 900 }], ['手机', { width: 390, height: 844 }]];
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900, ...remote });
const shot = (tag, label) => page.screenshot({ path: `${SP}/m-${tag}-${label}.png`, fullPage: true });
await login(page);
const state = await page.evaluate(async () => (await fetch('/api/auth/state')).json());
if (state.actor?.localAdministrator) throw new Error('模拟从域名访问没有生效：还是本机管理员');
// API 配置那一页藏着不显示时也在页面里，只看看得见的
const notice = () => page.locator('main .form-message:visible', { hasText: '进入超级管理员模式' });
/** 打开这一页，两种宽度各看一次 */
const visit = async (p, look) => {
  await page.goto(BASE + p.hash);
  await page.locator('main h1, main [role=tabpanel]:not([hidden])').first().waitFor();
  await page.waitForTimeout(600);
  for (const [tag, size] of sizes) {
    await page.setViewportSize(size);
    await page.waitForTimeout(200);
    await look(tag);
  }
};
for (const p of pages)
  await visit(p, async (tag) => {
    const text = await notice().first().innerText({ timeout: 5000 }).catch(() => '');
    if (!text.includes(p.what)) fail(tag + p.name + '没进模式时顶上没有说明和入口：' + text);
    if (await p.write(page).count()) fail(tag + p.name + '没进模式就露出了写按钮');
    for (const bad of await layout(page)) fail(tag + p.name + '（没进模式）' + bad);
    await shot(tag, p.name + '-没进模式');
  });
ok('五页没进模式时：电脑、手机宽度都有提示和入口，写按钮不在');
// 在最后一页（手机宽度）点提示里的入口：弹出的就是账号菜单里那个“系统维护”窗口
await notice().getByRole('button', { name: '进入超级管理员模式' }).click();
const box = page.locator('[role="dialog"][aria-modal="true"]').last();
await box.getByLabel('本人密码').waitFor();
await shot('手机', '系统维护窗口');
await box.getByLabel('本人密码').fill(passwordOf('虚构管理员'));
await box.getByRole('button', { name: '进入超级管理员模式' }).click();
await box.waitFor({ state: 'detached', timeout: 8000 });
ok('从页面提示进入超级管理员模式，窗口关掉');
for (const p of pages)
  await visit(p, async (tag) => {
    const shown = await p.write(page).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
    if (await notice().count()) fail(tag + p.name + '进了模式还显示“进入超级管理员模式”');
    if (!shown) fail(tag + p.name + '进了模式写按钮还没出来');
    for (const bad of await layout(page)) fail(tag + p.name + '（进了模式）' + bad);
    await shot(tag, p.name + '-进了模式');
  });
ok('进了模式后五页的写按钮都出来了，提示不再显示');
const real = [...new Set(consoleErrors)].filter((e) => !/status of (401|403)/.test(e));
if (real.length) fail('控制台报错：' + real.join(' | ').slice(0, 300));
await context.close();

// 远程只读账号打开 #ai-settings 和 #ai-settings?tab=prompts：零 4xx 请求、不显示“提示词”页签、无报错红条
const viewer = await openChrome({ width: 1440, height: 900, ...remote });
const badStatuses = [];
viewer.page.on('response', (res) => {
  if (res.url().includes('/api/') && res.status() >= 400) badStatuses.push(`${res.status()} ${res.url()}`);
});
await login(viewer.page, '虚构只读');
for (const hash of ['#ai-settings', '#ai-settings?tab=prompts']) {
  await viewer.page.goto(BASE + hash);
  await viewer.page.locator('main [role="tablist"]').waitFor();
  await viewer.page.locator('main [role="tabpanel"]:not([hidden])').first().waitFor();
  await viewer.page.waitForTimeout(400);
  if (await viewer.page.getByRole('tab', { name: '提示词' }).count()) fail('只读账号仍显示“提示词”页签：' + hash);
  if (await viewer.page.locator('main .form-message.error').count()) fail('只读账号打开设置出现红条报错：' + hash);
}
if (badStatuses.length) fail('只读账号打开设置触发了 4xx 请求：' + badStatuses.join(' | '));
ok('远程只读账号打开设置页与 tab=prompts 零 4xx、不显示提示词页签');
await viewer.context.close();
