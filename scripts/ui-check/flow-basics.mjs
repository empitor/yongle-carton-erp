// 财务页面：未启用时的五页、启用财务、建资金账户、月度台账、客户账期、各页签都能打开、新建收款并确认。
// 隔离实例 + 虚构数据，登录虚构管理员。flow-ledger 接着这里的状态走。
import { checkConsole, fail, go, login, openChrome } from './lib.mjs';
import { shotsDir as out } from './finance-kit.mjs';
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
await login(page);
let n = 0;
const log = (...a) => console.log(...a);
const shot = async (label) => {
  await page.waitForTimeout(500);
  const errs = await page.locator('.error,[role=alert]').allInnerTexts();
  await page.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${label}.png` });
  log(`[${n}] ${label}`, errs.length ? 'ERR: ' + errs.join(' | ').slice(0, 300) : 'ok');
};
const visit = async (hash, label) => {
  await go(page, hash);
  const wanted = new URLSearchParams(hash.split('?')[1] || '').get('tab');
  if (wanted) {
    const sel = await page.locator('.fin-subbar .fin-segmented button.selected').allInnerTexts();
    log('   tab', wanted, '=>', sel.join());
  }
  await shot(label);
};
const dlg = () => page.locator('[role="dialog"][aria-modal="true"]').last();
const fillField = (label) => dlg().locator('label.field', { hasText: label }).first();
const setText = async (label, value) => fillField(label).locator('input,textarea').first().fill(String(value));
const setSelect = async (label, value) => fillField(label).locator('select').first().selectOption(value);
const setCombo = async (label, text) => {
  const input = fillField(label).locator('input').first();
  await input.click();
  await input.fill(text);
  await page.waitForTimeout(200);
  await input.press('ArrowDown').catch(() => {});
  await input.press('Enter');
  await page.waitForTimeout(100);
};
const submit = async (text) => {
  await dlg().getByRole('button', { name: text, exact: true }).click();
  await page.waitForTimeout(700);
  const open = await page.locator('[role="dialog"][aria-modal="true"]').count();
  if (open) log('  dialog still open:', (await dlg().locator('.form-error,.error').allInnerTexts()).join('|'));
};

// 1 未启用
await visit('#finance', 'overview-not-enabled');
await visit('#finance-flow', 'flow-not-enabled');
await visit('#finance-reports', 'reports-not-enabled');
await visit('#finance-ledger', 'ledger-not-enabled');
await visit('#finance-settings', 'settings-not-enabled');

// 2 启用（页头主按钮“启用财务”）
if (await page.getByRole('button', { name: '启用财务' }).count()) { await page.getByRole('button', { name: '启用财务' }).click();
await setSelect('纳税人身份', 'general');
await shot('enable-dialog');
await submit('确认启用'); }
await shot('settings-enabled');

// 3 建资金账户
await visit('#finance-cash?tab=accounts', 'accounts-empty');
await page.getByRole('button', { name: '新建资金账户' }).click();
await setText('名称', '虚构基本户');
await setCombo('对应科目', '1002');
await shot('account-dialog');
await submit('保存账户');
await shot('accounts-one');

// 4 台账与补税
await visit('#finance-flow', 'flow-enabled');
const flowRow = page.locator('.fin-table tbody tr.record-row').first();
if (await flowRow.count()) {
  await flowRow.click();
  await shot('flow-panel');
  await page.keyboard.press('Escape');
}
await visit('#finance', 'overview-enabled');

// 5 账期窗口
await visit('#finance-ar?tab=terms', 'terms-empty');
await page.getByRole('button', { name: '新建客户账期' }).click();
await page.waitForTimeout(800);
const partyInput = dlg().locator('label.field', { hasText: '客户' }).first().locator('input');
await partyInput.click();
await partyInput.press('ArrowDown');
await partyInput.press('Enter');
await page.waitForTimeout(800);
await setSelect('账期方式', 'monthly');

// 带必填星号的标签按开头找：“账期方式”下拉的选项里也有“压几个月”几个字
await setText(/^压几个月\s*\*/, '3');
await setText(/^每月几号付\s*\*/, '25');
await setText('每月几号截止', '25');
await dlg().getByRole('button', { name: '加一档优惠' }).click();
await dlg().getByLabel('优惠比例').fill('2');
await shot('terms-dialog');
await submit('保存账期');
await shot('terms-one');

// 6 所有页签（合并后的页签，加几个合并前的旧名字，确认旧链接还能落到对应那一节）：选中的页签对、页面没报错
const tabs = {
  'finance-ar': { items: '欠款明细', soon: '到期和计划', statement: '对账单', terms: '账期', held: '欠款明细', deposits: '账期', interest: '账期' },
  'finance-cash': { accounts: '账户和流水', notes: '票据', invoices: '发票', bank: '账户和流水', tax: '发票' },
  'finance-costs': { expenses: '费用报销', assets: '固定资产', payroll: '工资', costing: '成本毛利', margin: '成本毛利' },
  'finance-ledger': { vouchers: '凭证', events: '业务单据', books: '账簿', templates: '记账模板', audit: '修改记录' },
  'finance-reports': { reports: '正式报表', profit: '正式报表', closing: '结账', trial: '结账', budget: '预算' },
  'finance-settings': { accounts: '科目' },
};
for (const [where, list] of Object.entries(tabs))
  for (const [t, name] of Object.entries(list)) {
    await go(page, '#' + where + '?tab=' + t);
    const selected = await page.locator('.fin-subbar .fin-segmented button.selected').first().innerText();
    const errors = await page.locator('main .error, main [role=alert]').allInnerTexts();
    if (selected.trim() !== name) fail(where + '?tab=' + t + ' 选中的页签是“' + selected + '”，应为“' + name + '”');
    if (errors.length) fail(where + '?tab=' + t + ' 页面报错：' + errors.join(' | ').slice(0, 200));
  }
log('财务 27 个页签地址都落到对的页签 ok');
// 财务页面之间靠顶上一排页签切换
await page.locator('.fin-nav').getByRole('link', { name: '月度台账' }).click();
await page.waitForTimeout(600);
if (!(await page.evaluate(() => location.hash)).startsWith('#finance-flow')) log('ERR: 财务页签点“月度台账”没有切过去');

// 7 收款、核销、撤销
await visit('#finance-cash?tab=documents', 'cash-documents');
await page.getByRole('button', { name: '新建收付款' }).click();
await page.waitForTimeout(300);
const pi = fillField('往来单位').locator('input').first();
await pi.click();
await pi.press('ArrowDown');
await pi.press('Enter');
await setText('金额', '100.50');
await setText('说明', '虚构收款');
await shot('cash-new-dialog');
await submit('保存收付款');
await shot('cash-draft-panel');
await page.locator('.detail-panel').getByRole('button', { name: '确认', exact: true }).click();
await page.waitForTimeout(600);
await shot('cash-allocate-dialog');
await dlg().getByRole('button', { name: '确认', exact: true }).click();
await page.waitForTimeout(800);
await shot('cash-confirmed-panel');
await go(page, '#finance');
await shot('overview-after-receipt');
checkConsole(consoleErrors);
await context.close();
