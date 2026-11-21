// 服务器正忙（429、代码 busy）时页面自己停一下再发一次，按钮一直是“正在……”，第二次还忙才显示“服务器正忙，请稍后再试。”。
// 用路由拦截造“正忙”：登录（第一次忙第二次成、两次都忙）、从域名访问进超级管理员模式（第一次忙第二次成）、改密码（两次都忙，密码没改）。
import { BASE, SP, fail, login, ok, openChrome, passwordOf } from './lib.mjs';

const BUSY = '服务器正忙，请稍后再试。';
/** 拦住 path 的前 times 次请求回“正忙”，返回实际收到几次 */
async function busy(page, path, times) {
  const seen = { count: 0 };
  await page.route('**' + path, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    seen.count++;
    if (seen.count <= times)
      return route.fulfill({ status: 429, contentType: 'application/json', headers: { 'Retry-After': '1' }, body: JSON.stringify({ code: 'busy', message: BUSY }) });
    return route.continue();
  });
  return seen;
}
/** 点下去以后半秒：按钮还在“正在……”、页面上没有报错 */
async function midway(page, scope, label) {
  await page.waitForTimeout(500);
  const text = await scope.locator('button.primary').last().innerText();
  const alerts = (await scope.locator('[role=alert], .form-alert, .form-message.tone-danger').allInnerTexts()).join(' ');
  if (!/^正在/.test(text.trim())) fail(label + '等着自动再试时按钮不是“正在……”：' + text);
  if (alerts.includes(BUSY)) fail(label + '第一次正忙就显示了报错');
}

const typeLogin = async (page) => {
  await page.goto(BASE);
  await page.locator('.login-screen input').nth(0).fill('虚构管理员');
  await page.locator('.login-screen input').nth(1).fill(passwordOf('虚构管理员'));
  await page.locator('.login-screen input').nth(1).press('Enter');
};

// 登录：第一次正忙、第二次成功
{
  const { context, page } = await openChrome();
  const seen = await busy(page, '/api/auth/login', 1);
  await typeLogin(page);
  await midway(page, page.locator('.login-screen'), '登录');
  const inside = await page.locator('.shell').waitFor({ timeout: 8000 }).then(() => true, () => false);
  if (!inside || seen.count !== 2) fail('登录第一次正忙后没自动再试进去：' + JSON.stringify({ inside, sent: seen.count }));
  else ok('登录第一次正忙：停一下自动再发，进去了');
  await context.close();
}
// 登录：两次都正忙，才显示
{
  const { context, page } = await openChrome();
  const seen = await busy(page, '/api/auth/login', 2);
  await typeLogin(page);
  await midway(page, page.locator('.login-screen'), '登录');
  const said = page.locator('.login-screen').getByText(BUSY);
  const shown = await said.waitFor({ timeout: 8000 }).then(() => true, () => false);
  await page.screenshot({ path: `${SP}/busy-登录两次正忙.png` });
  if (!shown || seen.count !== 2) fail('登录两次正忙应显示“' + BUSY + '”：' + JSON.stringify({ shown, sent: seen.count }));
  else if (!(await page.locator('.login-screen button.primary').last().isEnabled())) fail('两次正忙后登录按钮还是不能点');
  else ok('登录两次正忙：只发两次，显示“' + BUSY + '”，按钮能再点');
  await context.close();
}
// 从域名访问进超级管理员模式：第一次正忙、第二次成功
{
  const { context, page } = await openChrome({ extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.9' } });
  await login(page);
  const seen = await busy(page, '/api/auth/super-admin/enter', 1);
  await page.getByRole('button', { name: /^账号菜单/ }).click();
  await page.getByRole('menuitem', { name: '系统维护' }).click();
  const box = page.locator('[role="dialog"][aria-modal="true"]').last();
  await box.getByLabel('本人密码').fill(passwordOf('虚构管理员'));
  await box.getByRole('button', { name: '进入超级管理员模式' }).click();
  await midway(page, box, '进超级管理员模式');
  const closed = await box.waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false);
  if (!closed || seen.count !== 2 || !(await page.locator('.super-mode-banner').count()))
    fail('进超级管理员模式第一次正忙后没自动再试进去：' + JSON.stringify({ closed, sent: seen.count }));
  else ok('进超级管理员模式第一次正忙：自动再发，窗口关掉、横幅出来');
  await context.close();
}
// 改密码：两次都正忙，显示正忙，密码没改（还能用原密码登录）
{
  const { context, page } = await openChrome();
  await login(page);
  const seen = await busy(page, '/api/auth/password', 2);
  await page.getByRole('button', { name: /^账号菜单/ }).click();
  await page.getByRole('menuitem', { name: '修改密码' }).click();
  const box = page.locator('[role="dialog"][aria-modal="true"]').last();
  await box.getByLabel('当前密码').fill(passwordOf('虚构管理员'));
  await box.getByLabel('新密码', { exact: true }).fill('Fictional-Busy-2026');
  await box.getByRole('button', { name: '保存新密码' }).click();
  await page.waitForTimeout(500);
  const label = (await box.getByRole('button', { name: /保存新密码|正在/ }).innerText()).trim();
  if (!/^正在/.test(label)) fail('改密码等着自动再试时按钮不是“正在……”：' + label);
  const shown = await box.getByText(BUSY).waitFor({ timeout: 8000 }).then(() => true, () => false);
  await page.screenshot({ path: `${SP}/busy-改密码两次正忙.png` });
  if (!shown || seen.count !== 2) fail('改密码两次正忙应显示“' + BUSY + '”：' + JSON.stringify({ shown, sent: seen.count }));
  else ok('改密码两次正忙：只发两次，窗口里显示“' + BUSY + '”');
  await context.close();
  const again = await openChrome();
  await login(again.page);
  ok('改密码没办成，原密码照样能登录');
  await again.context.close();
}
