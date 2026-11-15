// 档案和数据管理点到底：新建客户、新建供应商（列表多一条、页面提示）；归档一个客户再到归档页恢复；
// 归档页永久删除一家客户；数据管理“初始化业务数据”看清理影响后真的清空（放在 records 组最后，清完订单、客户列表是空的）。全部虚构数据。
import { BASE, SP, call, fail, login, notice, ok, openChrome, step as stepOn } from './lib.mjs';
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
const dialog = () => page.locator('[role="dialog"][aria-modal="true"]').last();
let shots = 0;
const shot = (label) => page.screenshot({ path: `${SP}/r${String(++shots).padStart(2, '0')}-${label}.png` });
const api = (path) => page.evaluate(async (p) => (await fetch(p)).json(), path);
const step = (name, fn) => stepOn(page, name, fn);
const panel = () => page.locator('.detail-panel');
/** 这次操作的页面提示（上一步留下的不算） */
const toast = (pattern) => notice(page, pattern);
/** 详情里的操作：直接的按钮，或者“更多”里的 */
const action = async (name) => {
  const direct = panel().getByRole('button', { name, exact: true });
  if (await direct.count()) return direct.first().click();
  await panel().locator('summary', { hasText: '更多' }).first().click();
  await panel().locator('details[open]').getByRole('menuitem', { name, exact: true }).first().click();
};
await login(page);

// 客户、供应商用同一个编辑窗：只有名称必填
for (const [hash, noun, list, name] of [
  ['#customers', '客户', '/api/customers', '虚构界面新客户有限公司'],
  ['#suppliers', '供应商', '/api/suppliers', '虚构界面新纸板厂'],
]) {
  await step('新建' + noun, async () => {
    const before = (await api(list)).length;
    await page.goto(BASE + hash);
    await page.locator('main tbody tr').first().waitFor();
    await page.locator('main').getByRole('button', { name: '新建' + noun, exact: true }).first().click();
    await dialog().waitFor();
    await dialog().getByLabel(noun + '名称', { exact: true }).fill(name);
    await dialog().getByLabel('联系人', { exact: true }).fill('虚构联系人');
    await dialog().getByLabel('联系方式', { exact: true }).fill('0574-9999-0000');
    await dialog().getByRole('button', { name: '保存' + noun, exact: true }).click();
    await dialog().waitFor({ state: 'detached', timeout: 8000 });
    const said = await toast(name);
    const after = await api(list);
    const saved = after.find((r) => r.name === name);
    await page.locator('main tbody tr', { hasText: name }).first().waitFor({ timeout: 8000 }).catch(() => {});
    const shown = await page.locator('main tbody tr', { hasText: name }).count();
    await shot('新建' + noun);
    if (after.length !== before + 1 || !saved || saved.phone !== '0574-9999-0000') fail('新建' + noun + '没存上：' + before + ' → ' + after.length);
    else if (!shown) fail('新建的' + noun + '没出现在列表里');
    else if (!/已建立/.test(said)) fail('新建' + noun + '后页面没提示：' + said);
    else ok('新建' + noun + ' ' + name + '：' + said);
  });
}

// 归档刚建的客户（没有订单，能归档），列表里没了；到归档页“客户”里恢复，回到客户列表
await step('归档再恢复客户', async () => {
  const name = '虚构界面新客户有限公司';
  const customer = (await api('/api/customers')).find((c) => c.name === name);
  if (!customer) throw new Error('上一步没建出客户');
  await page.goto(BASE + '#customers');
  await page.getByRole('button', { name: '查看 ' + name }).first().click();
  await panel().waitFor();
  await action('归档');
  await toast(/归档/);
  await page.locator('main tbody tr', { hasText: name }).first().waitFor({ state: 'detached', timeout: 8000 });
  const archived = !(await api('/api/customers')).some((c) => c.id === customer.id);
  await page.goto(BASE + '#trash');
  const pickerLabel = await page.evaluate(() => {
    const span = document.querySelector('.recycle-picker span');
    const r = span?.getBoundingClientRect();
    return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
  });
  if (!pickerLabel || pickerLabel.h > 28 || pickerLabel.w < 24) {
    fail('归档页“查看”标签被挤成竖排换行：' + JSON.stringify(pickerLabel));
  }
  await page.getByLabel('查看哪一类已归档记录').selectOption('customers');
  const row = page.getByRole('button', { name: '查看 ' + name }).first();
  await row.waitFor({ timeout: 8000 });
  await shot('归档页里的客户');
  await row.click();
  await panel().waitFor();
  await action('恢复');
  const said = await toast(/恢复/);
  await row.waitFor({ state: 'detached', timeout: 8000 });
  const back = (await api('/api/customers')).some((c) => c.id === customer.id);
  await page.goto(BASE + '#customers');
  const listed = await page.locator('main tbody tr', { hasText: name }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
  if (!archived) fail('归档后客户还在在用列表里');
  else if (!back || !listed) fail('归档页点恢复后客户没回到客户列表');
  else ok('客户归档后从归档页恢复：' + said);
});

// 归档页永久删除：归档一家虚构客户，在归档页打开它，“更多 → 删除”，影响清单只列这一家，删完归档页和接口里都没有了
await step('归档页永久删除', async () => {
  const name = '虚构待删客户';
  const made = await call(page, 'POST', '/customers', { name, contact: '', phone: '', address: '', notes: '' });
  if (made.error) throw new Error('建客户失败：' + made.error);
  await page.goto(BASE + '#customers');
  await page.getByRole('button', { name: '查看 ' + name }).first().click();
  await action('归档');
  await toast(/归档/);
  await page.goto(BASE + '#trash');
  await page.getByLabel('查看哪一类已归档记录').selectOption('customers');
  const row = page.getByRole('button', { name: '查看 ' + name }).first();
  await row.click();
  await action('删除');
  const box = page.getByRole('dialog', { name: '删除客户' });
  await box.getByText('会删除 1').waitFor({ timeout: 8000 });
  const impact = (await box.textContent()) || '';
  await shot('归档页永久删除');
  if (!impact.includes(name) || !/删除后不能恢复/.test(impact)) fail('永久删除的影响清单不对：' + impact.slice(0, 160));
  await box.getByRole('button', { name: '删除客户', exact: true }).click();
  await box.waitFor({ state: 'detached', timeout: 8000 });
  const said = await toast(/删除/);
  await row.waitFor({ state: 'detached', timeout: 8000 });
  const left = await api('/api/customers?archived=1');
  if ((Array.isArray(left) ? left : []).some((c) => c.id === made.id)) fail('永久删除后客户还在');
  else ok('归档页永久删除客户：' + said);
});

// 初始化业务数据：只有本机最高管理员能用；先看清理影响（条数和接口给的一致），再永久清空，订单和客户都清掉
await step('初始化业务数据', async () => {
  const preview = await api('/api/management/reset-preview?scope=business');
  const total = Object.values(preview.tables || {}).reduce((a, b) => a + Number(b), 0);
  if (!total) throw new Error('清理影响里没有业务数据，这一步没测到');
  await page.goto(BASE + '#dashboard');
  await page.locator('.oi-account').click();
  await page.locator('.account-menu').getByRole('menuitem', { name: '数据管理' }).click();
  await dialog().getByRole('heading', { name: '业务数据管理' }).waitFor();
  await dialog().locator('summary', { hasText: '初始化业务数据' }).click();
  await dialog().getByLabel('初始化数据范围').selectOption('business');
  await dialog().getByRole('button', { name: '查看清理影响' }).click();
  const impact = dialog().locator('.adm-reset-impact');
  await impact.waitFor({ timeout: 8000 });
  const text = await impact.innerText();
  await impact.scrollIntoViewIfNeeded();
  await shot('初始化清理影响');
  if (!text.includes('将清空' + total + '条业务数据')) fail('清理影响写的条数和接口不一致（接口 ' + total + ' 条）：' + text.slice(0, 120));
  await impact.getByRole('button', { name: '永久清空所选范围' }).click();
  const message = dialog().locator('.adm-reset-message');
  await message.waitFor({ timeout: 15000 });
  const said = await message.innerText();
  const [orders, customers] = [await api('/api/orders'), await api('/api/customers')];
  await shot('初始化之后');
  if (!/^已按实际范围清理 \d+ 条/.test(said)) fail('清空后没说清清了多少：' + said);
  else if (orders.length || customers.length) fail('清空后还有订单 ' + orders.length + ' 张、客户 ' + customers.length + ' 家');
  else ok('初始化业务数据：影响 ' + total + ' 条，' + said);
  await page.getByRole('button', { name: '关闭窗口' }).last().click();
});

const real = [...new Set(consoleErrors)].filter((e) => !/status of (403|409)/.test(e));
if (real.length) fail('控制台报错：' + real.join(' | ').slice(0, 300));
await context.close();
