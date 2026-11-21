// 设置和数据管理（自己一组）：设置页逐个页签、三家机器人连假服务端显示已连接；数据管理报错写在出错那格、
// 完工单修改历史叫“修改”、订单批量归档失败的提示标点、AI 导入归档恢复后导航数字马上变；单据模板改了保存、下载测试样张。
// 全站深色和 900 宽的巡检在 flow-mobile。全部虚构数据。
import { readFileSync, mkdirSync } from 'node:fs';
import { BASE, SP, checkConsole, fail, go, login, ok, openChrome } from './lib.mjs';
const out = SP + '/settings-shots';
mkdirSync(out, { recursive: true });
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
await login(page);
const log = (...a) => console.log(...a);
let n = 0;
const shot = async (label) => {
  await page.waitForTimeout(500);
  const errs = await page.locator('.fin-page .form-message.tone-danger,.detail-panel .form-message.tone-danger,main .form-message.tone-danger').allInnerTexts();
  await page.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${label}.png` });
  log(`[${n}] ${label}`, errs.length ? 'ERR: ' + errs.join(' | ').slice(0, 260) : 'ok');
};
const dlg = () => page.locator('[role="dialog"][aria-modal="true"]').last();
/** 详情“更多”里的操作 */
const panelMore = async (t) => {
  await page.locator('.detail-panel .more-menu summary').first().click();
  await page.getByRole('menuitem', { name: t, exact: true }).click();
};

await go(page, '#ai-settings');
await shot('settings-api');
for (const t of await page.locator('.ai-settings-tabs [role=tab], .ai-settings-tabs button').all()) {
  const label = (await t.innerText()).trim();
  await t.click();
  await page.waitForTimeout(500);
  await shot('settings-tab-' + label.slice(0, 6));
}
// 单据模板：改页脚文字点“保存模板设置”，页面说已保存；重新打开还是新值；下载测试 Word、Excel 样张
{
  await page.goto(BASE + '#ai-settings?tab=templates');
  const footer = page.getByRole('textbox', { name: /^页脚文字/ });
  const text = '虚构页脚 ' + Date.now();
  await footer.fill(text);
  await page.getByRole('button', { name: '保存模板设置' }).click();
  const said = page.locator('main [role=status]', { hasText: '模板设置已保存' });
  const saved = await said.waitFor({ timeout: 8000 }).then(() => true, () => false);
  await shot('单据模板已保存');
  await page.reload();
  const kept = await page.getByRole('textbox', { name: /^页脚文字/ }).inputValue({ timeout: 8000 });
  if (!saved) fail('单据模板点保存后页面没说已保存');
  else if (kept !== text) fail('单据模板保存后重新打开，页脚文字不是新值：' + kept);
  else ok('单据模板改页脚文字保存，重新打开还在');
  for (const [button, ext] of [['下载测试Word', 'docx'], ['下载测试Excel', 'xlsx']]) {
    // 下载测试样张收在样张那块的“…”菜单里
    await page.locator('details', { has: page.locator('button', { hasText: button }) }).locator('summary').first().click();
    const [file] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('menuitem', { name: button }).click()]);
    if (!file.suggestedFilename().endsWith('.' + ext)) fail(button + '下载的不是 .' + ext + '：' + file.suggestedFilename());
    else ok(button + '：' + file.suggestedFilename());
  }
}
// 消息接入：三家都连本机假服务端（server.mts 接的 tests/bot-fakes.ts），填虚构凭据要显示“已连接”，每张卡片一个主按钮
{
  const fake = readFileSync(new URL('../../tests/bot-fakes-http.ts', import.meta.url), 'utf8');
  const [, appId, secret] = /appId: '([^']+)', secret: '([^']+)'/.exec(fake);
  await go(page, '#ai-settings?tab=channels');
  for (const label of ['企业微信机器人', '飞书机器人', '钉钉机器人']) {
    const card = page.locator('.channel-settings', { has: page.getByRole('heading', { name: label }) });
    await card.locator('input').nth(0).fill(appId);
    await card.locator('input').nth(1).fill(secret);
    await card.getByRole('button', { name: /保存并/ }).click();
    const ok = await card.locator('.channel-state', { hasText: '已连接' }).waitFor({ timeout: 8000 }).then(() => true, () => false);
    if (!ok) log('  ERR: ' + label + ' 没有显示已连接：' + (await card.locator('.channel-head, .form-message').allInnerTexts()).join(' | '));
    if ((await card.locator('button.primary').count()) !== 1) log('  ERR: ' + label + ' 卡片的主按钮不是一个');
  }
  await shot('settings-channels-connected');
}

// I 数据管理和列表：报错写在出错那格下面、服务端报错滚进视野且是中文整句；
//   完工单修改历史里下层记的那条叫“修改”；批量归档失败的提示没有“。；”。不对就打 ERR（run.mjs 按它算问题）
const bad = (what) => log('  ERR: ' + what);
const inView = (loc) =>
  loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
  });
const openDataManagement = async (module) => {
  await page.locator('.oi-account').click();
  await page.locator('.account-menu').getByRole('menuitem', { name: '数据管理' }).click();
  await dlg().getByRole('heading', { name: '业务数据管理' }).waitFor();
  await dlg().getByLabel('数据管理业务模块').selectOption(module);
  await page.waitForTimeout(800);
  return dlg();
};
const closeDataManagement = async () => {
  await page.getByRole('button', { name: '关闭窗口' }).last().click();
  await page.waitForTimeout(300);
};
await page.keyboard.press('Escape');
// I-1 订单预估成本：格式不对写在那一格下面并聚焦；服务端退回的原因滚到能看见、用中文冒号
{
  const dm = await openDataManagement('orders');
  await dm.locator('tbody tr').first().getByRole('button', { name: '编辑', exact: true }).click();
  await page.waitForTimeout(500);
  // 编辑窗换掉列表窗口，不叠在“业务数据管理”上面
  if ((await page.locator('[role="dialog"][aria-modal="true"]').count()) !== 1) bad('数据管理的编辑窗叠在列表窗口上面');
  const rec = dlg();
  const material = rec.getByLabel('数据管理 材料成本（元）', { exact: true });
  await material.fill('1.234');
  await rec.getByRole('button', { name: /^保存/ }).click();
  await page.waitForTimeout(500);
  // 这一格外面那层 label.form-field（has 里的定位是相对 label 找的，不能用从窗口起头的 material）
  const cell = material.locator('xpath=ancestor::label[contains(@class,"form-field")][1]');
  const note = await cell.locator('.form-field-error').innerText({ timeout: 3000 }).catch(() => '');
  if (!/最多两位小数/.test(note)) bad('数据管理成本报错没写在“材料成本（元）”下面：' + (note || '（没有）'));
  if ((await material.getAttribute('aria-invalid')) !== 'true') bad('出错的“材料成本（元）”没标红');
  if ((await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) !== '数据管理 材料成本（元）')
    bad('点保存后光标没放到出错的那一格');
  if (!(await inView(cell))) bad('出错的那一格不在视野里');
  await shot('dm-cost-field-error');
  // 只填一项、估算依据空着：服务端退回，原因在顶上
  await material.fill('1');
  await rec.getByLabel('数据管理 估算依据', { exact: true }).fill('');
  await rec.getByRole('button', { name: /^保存/ }).click();
  await page.waitForTimeout(1200);
  const top = rec.locator('.form-message');
  if (!(await top.count())) bad('只填一项成本时服务端没有退回原因');
  else {
    const said = await top.first().innerText();
    if (!(await inView(top.first()))) bad('服务端退回的原因不在视野里：' + said);
    if (/: |预估成本 /.test(said) || !/估算依据：/.test(said)) bad('服务端退回的原因写法不对：' + said);
  }
  await shot('dm-cost-server-error');
  await rec.getByRole('button', { name: '取消', exact: true }).click();
  await page.waitForTimeout(300);
  await closeDataManagement();
}
// I-2 数据管理改已入库的完工单：“编辑”打开和完工详情同一个说明编辑窗，修改历史叫“改说明”，看不到“数据管理修改”
{
  const dm = await openDataManagement('production');
  const row = dm.locator('tbody tr', { hasText: '已入库' }).first();
  if (!(await row.count())) bad('数据管理里没有已入库的完工单，查不了修改历史的动作名');
  else {
    const number = (await row.locator('strong').first().innerText()).trim();
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    await page.waitForTimeout(500);
    await dlg().getByLabel('批次备注', { exact: true }).fill('界面检查改批次备注 ' + Date.now());
    await dlg().getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForTimeout(1500);
    await closeDataManagement();
    await go(page, '#production?view=production');
    await page.waitForTimeout(800);
    await page.locator('tbody tr', { hasText: number }).first().click();
    await page.locator('.detail-panel').waitFor();
    await panelMore('关联记录与修改历史');
    await page.waitForTimeout(800);
    const history = await dlg().innerText();
    if (history.includes('数据管理修改')) bad('完工单修改历史里还有“数据管理修改”');
    const edits = await dlg().locator('li', { hasText: '编辑说明' }).count();
    if (edits < 1) bad('完工单修改历史里没有这次“改说明”');
    await shot('history-production-edit');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
}
// I-3 订单批量归档：两张都没发完货，都没能归档，提示里几条原因连起来不出现“。；”
{
  await go(page, '#orders');
  await page.waitForTimeout(800);
  const open = page
    .locator('tbody tr')
    .filter({ has: page.locator('input[type="checkbox"]') })
    .filter({ hasNotText: /已发货|已取消|已归档/ });
  if ((await open.count()) < 2) bad('订单列表里没发完货的不到两张，查不了批量归档的提示');
  else {
    for (const i of [0, 1]) await open.nth(i).locator('input[type="checkbox"]').check();
    await page.locator('.selection-bar summary[aria-label="更多批量操作"]').click();
    await page.getByRole('menuitem', { name: '批量归档', exact: true }).click();
    await page.waitForTimeout(1500);
    const hint = page.locator('[role="alert"]', { hasText: '没能归档' }).first();
    const said = (await hint.count()) ? await hint.innerText() : '';
    if (!said) bad('批量归档没办成时没有提示');
    else if (/。；|。。|；。/.test(said) || !/。$/.test(said.trim())) bad('批量归档失败的提示标点不对：' + said);
    await shot('orders-batch-archive-failed');
    await page.locator('.selection-bar').getByRole('button', { name: '清除选择' }).click().catch(() => {});
  }
}

// I-4 识别文件归档、恢复以后，导航上“AI 导入”的数字马上跟着变，不等定时重新取（导航每 15 秒才自己取一次）
{
  const badge = async () => Number((await page.locator('.nav-count.ai').first().textContent().catch(() => '')) || 0);
  const waitBadge = async (want) => {
    for (let i = 0; i < 30; i++) {
      if ((await badge()) === want) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
  await go(page, '#ai-import');
  await page.waitForTimeout(1500);
  const before = await badge();
  const file = page.locator('input[aria-label^="选择文件 "]').first();
  if (!before || !(await file.count())) bad('AI 导入里没有识别文件，查不了导航数字');
  else {
    const name = (await file.getAttribute('aria-label')).replace('选择文件 ', '');
    await file.check();
    await page.locator('.selection-bar summary').first().click();
    await page.getByRole('menuitem', { name: '归档', exact: true }).click();
    await page.locator('[role="dialog"][aria-modal="true"]').getByRole('button', { name: '归档', exact: true }).click();
    if (!(await waitBadge(before - 1))) bad('归档识别文件后 3 秒内导航上 AI 导入的数字没有少一个：' + before + ' → ' + (await badge()));
    else log('  归档后导航数字 ' + before + ' → ' + (before - 1));
    await shot('ai-import-archived-badge');
    await page.locator('.page-heading summary, main header summary').filter({ hasText: '更多' }).first().click();
    await page.getByRole('menuitem', { name: '历史与归档' }).click();
    await page.locator('[role="dialog"][aria-modal="true"] li', { hasText: name }).first().getByRole('button', { name: '恢复' }).click();
    if (!(await waitBadge(before))) bad('恢复识别文件后 3 秒内导航上 AI 导入的数字没有加回来：' + (await badge()));
    else log('  恢复后导航数字回到 ' + before);
    await page.keyboard.press('Escape');
    await shot('ai-import-restored-badge');
  }
}

await context.close().catch(() => {});
checkConsole(consoleErrors, /status of (400|401)/);
