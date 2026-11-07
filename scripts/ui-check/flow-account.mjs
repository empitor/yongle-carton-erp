// 账号流程：登录页版式、申请账号、管理员审批、切换账号、忘记密码、临时密码强制改密、手机菜单。虚构数据。
// 只动这里新建的账号，不改种子账号的密码，其他流程还要用。
import { readFileSync } from 'node:fs';
import { BASE, SERVER_SOURCE, SP, openChrome } from './lib.mjs';

const seed = readFileSync(SERVER_SOURCE, 'utf8');
const [, adminName, adminPassword] = /add\('(虚构管理员)',\s*'([^']+)'/.exec(seed);
const newName = '虚构新员工';
const newPassword = 'Fictional-Applicant-2026';
const finalPassword = 'Fictional-Changed-2026';
const fail = (message) => console.log('ERR: ' + message);

const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
let shots = 0;
const shot = (label) => page.screenshot({ path: `${SP}/a${String(++shots).padStart(2, '0')}-${label}.png` });
const card = page.locator('.login-card');
const dialog = () => page.locator('[role="dialog"][aria-modal="true"]').last();
const fillLogin = async (name, password) => {
  await page.locator('.login-screen input').nth(0).fill(name);
  await page.locator('.login-screen input').nth(1).fill(password);
  await card.getByRole('button', { name: '登录', exact: true }).click();
};
const openMenu = async () => {
  await page.locator('.oi-account').click();
  await page.locator('.account-menu').waitFor();
};
const menuItem = (name) => page.locator('.account-menu').getByRole('menuitem', { name });
const switchAccount = async () => {
  await openMenu();
  await menuItem('切换账号').click();
  await dialog().getByRole('button', { name: '切换账号' }).click();
  await page.locator('.login-card').waitFor();
};

await page.goto(BASE);
await card.waitFor();
await shot('登录页');
if (!(await card.locator('svg.brand-logo').count())) fail('登录页没有商标');
const favicon = await page.evaluate(async () => {
  const response = await fetch(document.querySelector('link[rel="icon"]').href);
  return response.ok && (await response.text()).includes('<svg');
});
if (!favicon) fail('标签页图标加载失败');

// 版式：标签和输入框、字段之间、输入框和按钮之间都要有间距
const gaps = await page.evaluate(() => {
  const r = (e) => e.getBoundingClientRect();
  const labels = [...document.querySelectorAll('.login-card form label')];
  const [a, b] = labels;
  const submit = document.querySelector('.login-card form button.primary');
  return {
    labelToInput: r(a.querySelector('input')).top - (r(a).top + 16),
    fieldToField: r(b).top - r(a).bottom,
    fieldToButton: r(submit).top - r(b).bottom,
    sameWidth: Math.abs(r(a.querySelector('input')).width - r(submit).width) < 1,
  };
});
if (gaps.fieldToField < 12) fail('字段之间太挤 ' + gaps.fieldToField);
if (gaps.fieldToButton < 12) fail('输入框和按钮太挤 ' + gaps.fieldToButton);
if (!gaps.sameWidth) fail('输入框和按钮不一样宽');
console.log('登录页版式 ok');

// 短密码也只说“用户名或密码错误”，显示密码按钮能切换
await page.locator('.login-screen input').nth(0).fill(adminName);
await page.locator('.login-screen input').nth(1).fill('short');
const passwordInput = page.locator('.login-screen input').nth(1);
await card.getByRole('button', { name: '显示密码' }).click();
if ((await passwordInput.getAttribute('type')) !== 'text') fail('显示密码按钮不起作用');
await card.getByRole('button', { name: '隐藏密码' }).click();
if ((await passwordInput.getAttribute('type')) !== 'password') fail('隐藏密码按钮不起作用');
await card.getByRole('button', { name: '登录', exact: true }).click();
await card.getByRole('alert').waitFor();
if ((await card.getByRole('alert').innerText()).trim() !== '用户名或密码错误。') fail('短密码的提示不对');
await shot('登录错误');

// 申请账号：全小写的密码提交不了
await card.getByRole('button', { name: '申请账号' }).click();
await shot('申请账号');
const applyInputs = page.locator('.login-screen input');
await applyInputs.nth(0).fill(newName);
await applyInputs.nth(1).fill('alllowercase');
await card.getByRole('button', { name: '提交申请' }).click();
await page.waitForTimeout(300);
if (await card.getByText('申请已提交').count()) fail('全小写的密码也能提交');
if (await applyInputs.nth(1).evaluate((e) => e.validity.valid)) fail('输入框没有拦下全小写的密码');
await applyInputs.nth(1).fill(newPassword);
await applyInputs.nth(2).fill('虚构仓库');
await card.getByRole('button', { name: '提交申请' }).click();
await card.getByText('申请已提交').waitFor();
await shot('申请已提交');
await card.getByRole('button', { name: '返回登录' }).click();

// 还没批准，登录不了
await fillLogin(newName, newPassword);
await card.getByRole('alert').waitFor();
console.log('未批准不能登录 ok');

// 管理员登录，右上角和待处理
await fillLogin(adminName, adminPassword);
await page.locator('.shell').waitFor();
if (!(await page.locator('.sidebar svg.brand-logo').count())) fail('左上角没有商标');
const trigger = await page.locator('.oi-account').innerText();
if (!trigger.includes(adminName) || !trigger.includes('管理员')) fail('右上角没有显示账号和级别：' + trigger);
await page.waitForTimeout(300);
await openMenu();
await shot('账号菜单');
if (!(await menuItem('账号管理').locator('.nav-count').count())) fail('菜单没有待处理数量');
await menuItem('账号管理').click();
await page.locator('.accounts-page').waitFor();
await page.getByRole('heading', { name: '待处理' }).waitFor();
await shot('账号管理');
const row = page.locator('.accounts-section tr', { hasText: newName });
await row.getByRole('button', { name: '通过并选级别' }).click();
await shot('通过申请');
await dialog().getByLabel('级别').selectOption('viewer');
await dialog().getByRole('button', { name: '通过', exact: true }).click();
await dialog().waitFor({ state: 'detached' });
await page.locator('.record-row', { hasText: newName }).waitFor();
console.log('审批通过 ok');

// 点行打开右侧面板，自己的账号没有重置和停用
await page.locator('.record-row', { hasText: adminName }).click();
await page.locator('.detail-panel').waitFor();
if (await page.locator('.detail-panel').getByRole('button', { name: '停用' }).count()) fail('可以停用自己');
await page.getByRole('button', { name: '关闭详情' }).click();
await page.locator('.record-row', { hasText: newName }).click();
await page.locator('.detail-panel').getByRole('button', { name: '重置密码' }).waitFor();
await shot('账号面板');
await page.getByRole('button', { name: '关闭详情' }).click();

// 系统维护：原来账号弹窗里的本机数据管理搬到了这里
await openMenu();
await menuItem('系统维护').click();
await dialog().getByRole('button', { name: '打开数据管理' }).waitFor();
await shot('系统维护');
await dialog().getByRole('button', { name: '关闭窗口' }).click();
console.log('系统维护 ok');

// 切换账号：登录页列出这台设备用过的账号，不带密码
await switchAccount();
await card.getByText('选择账号').waitFor();
await shot('选择账号');
if ((await page.evaluate(() => location.hash)) !== '#dashboard') fail('切换后没有回到首页');
const stored = await page.evaluate(() => JSON.stringify(localStorage));
if (/Fictional-|password/i.test(stored)) fail('本地存储里有密码');
await card.getByRole('button', { name: '使用其他账号' }).click();
await fillLogin(newName, newPassword);
await page.locator('.shell').waitFor();
const viewer = await page.locator('.oi-account').innerText();
if (!viewer.includes(newName) || !viewer.includes('只读')) fail('只读账号右上角显示不对：' + viewer);
await openMenu();
if (await menuItem('账号管理').count()) fail('只读账号看到了账号管理');
if (await menuItem('系统维护').count()) fail('只读账号看到了系统维护');
await page.keyboard.press('Escape');
await page.evaluate(() => (location.hash = '#accounts'));
await page.getByText('只有管理员能管理账号').waitFor();
console.log('切换账号和权限 ok');

// 修改密码弹窗能打开
await openMenu();
await menuItem('修改密码').click();
await shot('修改密码');
await dialog().getByRole('button', { name: '关闭窗口' }).click();

// 忘记密码
await openMenu();
await menuItem('退出登录').click();
await card.getByText('选择账号').waitFor();
await card.getByRole('button', { name: '忘记密码' }).click();
await shot('忘记密码');
await page.locator('.login-screen input').nth(0).fill(newName);
await card.getByRole('button', { name: '提交申请' }).click();
await card.getByText('请联系管理员').waitFor();
await card.getByRole('button', { name: '返回登录' }).click();

// 管理员生成临时密码
await fillLogin(adminName, adminPassword);
await page.locator('.shell').waitFor();
await page.evaluate(() => (location.hash = '#accounts'));
await page.getByRole('heading', { name: '待处理' }).waitFor();
await page.locator('.accounts-section tr', { hasText: newName }).getByRole('button', { name: '生成临时密码' }).click();
await dialog().getByRole('button', { name: '生成临时密码' }).click();
await page.locator('.temp-password').waitFor();
await shot('临时密码');
const temporary = (await page.locator('.temp-password').innerText()).trim();
if (!/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/.test(temporary)) fail('临时密码格式不对');
await dialog().getByRole('button', { name: '完成' }).click();
await page.getByRole('heading', { name: '待处理' }).waitFor({ state: 'detached' });

// 用临时密码登录：只能先改密码
await switchAccount();
await card.locator('.login-account', { hasText: newName }).click();
const prefilled = await page.locator('.login-screen input').nth(0).inputValue();
if (prefilled !== newName) fail('选账号后用户名没有带上');
await shot('已选账号');
await fillLogin(newName, temporary);
await card.getByRole('heading', { name: '先改密码' }).waitFor();
await shot('强制改密');
if (await page.locator('.shell').count()) fail('临时密码进了系统');
const forced = page.locator('.login-screen input');
await forced.nth(0).fill(temporary);
await forced.nth(1).fill(finalPassword);
await card.getByRole('button', { name: '保存并进入系统' }).click();
await page.locator('.shell').waitFor();
console.log('临时密码强制改密 ok');

// 移除用过的账号
await openMenu();
await menuItem('退出登录').click();
await card.getByText('选择账号').waitFor();
await card.getByRole('button', { name: '从这台设备移除 ' + newName }).click();
if (await card.locator('.login-account', { hasText: newName }).count()) fail('移除账号没有生效');
await card.getByRole('button', { name: '从这台设备移除 ' + adminName }).click();
await page.locator('.login-screen input').nth(1).waitFor();
console.log('移除账号 ok');

// 深色
await page.emulateMedia({ colorScheme: 'dark' });
await page.reload();
await card.waitFor();
if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== 'dark') fail('深色没有生效');
await shot('深色登录页');
await page.emulateMedia({ colorScheme: 'light' });

const real = [...new Set(consoleErrors)].filter((e) => !/status of (400|401|403|404|409|422|429|503)/.test(e));
if (real.length) fail('控制台报错 ' + real.join(' | ').slice(0, 300));
await context.close();

// 手机：登录页和底部弹出的账号菜单
const phone = await openChrome({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = phone.page;
const phoneShot = (label) => p.screenshot({ path: `${SP}/a${String(++shots).padStart(2, '0')}-手机${label}.png` });
await p.goto(BASE);
await p.locator('.login-card').waitFor();
await phoneShot('登录页');
const sizes = await p.evaluate(() => {
  const input = document.querySelector('.login-screen input');
  return { font: getComputedStyle(input).fontSize, height: input.getBoundingClientRect().height, wide: document.documentElement.scrollWidth };
});
if (sizes.font !== '16px') fail('手机输入框字号不是 16px，iPhone 会自动放大：' + sizes.font);
if (sizes.height < 44) fail('手机输入框太矮：' + sizes.height);
if (sizes.wide > 391) fail('手机登录页超出屏幕：' + sizes.wide);
await p.locator('.login-screen input').nth(0).fill(adminName);
await p.locator('.login-screen input').nth(1).fill(adminPassword);
await p.locator('.login-screen input').nth(1).press('Enter');
await p.locator('.shell').waitFor();
await p.locator('.oi-account').tap();
await p.locator('.account-menu').waitFor();
await phoneShot('账号菜单');
const sheet = await p.locator('.account-menu').boundingBox();
if (!sheet || sheet.width < 389 || Math.abs(sheet.y + sheet.height - 844) > 1) fail('手机账号菜单没有贴底：' + JSON.stringify(sheet));
await p.locator('.account-menu').getByRole('menuitem', { name: '账号管理' }).tap();
await p.locator('.accounts-page').waitFor();
await p.waitForTimeout(400);
await phoneShot('账号管理');
const over = await p.evaluate(() => document.documentElement.scrollWidth);
if (over > 391) fail('手机账号管理超出屏幕：' + over);
await p.locator('.oi-account').tap();
await p.locator('.account-menu').waitFor();
await p.locator('.account-menu-backdrop').tap({ position: { x: 200, y: 100 } });
await p.waitForTimeout(200);
if (await p.locator('.account-menu').count()) fail('点遮罩没有关掉账号菜单');
else console.log('手机账号菜单 ok');
const phoneErrors = [...new Set(phone.consoleErrors)].filter((e) => !/status of (401|403|404|422|503)/.test(e));
if (phoneErrors.length) fail('手机控制台报错 ' + phoneErrors.join(' | ').slice(0, 300));
await phone.context.close();
