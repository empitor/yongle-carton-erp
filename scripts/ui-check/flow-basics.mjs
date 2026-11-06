// 财务页面实测：隔离实例 + 虚构数据，登录虚构管理员。
import { readFileSync, mkdirSync } from 'node:fs';
import { openChrome, BASE, SP, SERVER_SOURCE, go } from './lib.mjs';
const out = SP + '/finance-shots';
mkdirSync(out, { recursive: true });
const seed = readFileSync(SERVER_SOURCE, 'utf8');
const [, name, password] = /add\('(虚构管理员)',\s*'([^']+)'/.exec(seed);
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
await page.goto(BASE);
await page.locator('.login-screen input').nth(0).fill(name);
await page.locator('.login-screen input').nth(1).fill(password);
await page.locator('.login-screen input').nth(1).press('Enter');
await page.locator('.shell').waitFor();
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
    const sel = await page.locator('.fin-tabs button.selected').allInnerTexts();
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
const period = new Date().toISOString().slice(0, 7);

// 1 未启用
await visit('#finance', 'overview-not-enabled');
await visit('#finance-flow', 'flow-not-enabled');
await visit('#finance-reports', 'reports-not-enabled');
await visit('#finance-ledger', 'ledger-not-enabled');
await visit('#finance-settings', 'settings-not-enabled');

// 2 启用
if (await page.getByRole('button', { name: '开始启用' }).count()) { await page.getByRole('button', { name: '开始启用' }).click();
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
await submit('保存');
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
await page.getByRole('button', { name: /设置客户账期/ }).click();
await page.waitForTimeout(800);
const partyInput = dlg().locator('label.field', { hasText: '客户' }).first().locator('input');
await partyInput.click();
await partyInput.press('ArrowDown');
await partyInput.press('Enter');
await page.waitForTimeout(800);
await setSelect('压货款方式', 'monthly');

await setText('压几个月 *', '3');
await setText('每月几号付 *', '25');
await setText('每月几号截止', '25');
await dlg().getByRole('button', { name: '加一档优惠' }).click();
await dlg().getByLabel('优惠比例').fill('2');
await shot('terms-dialog');
await submit('保存');
await shot('terms-one');

// 6 所有页签
for (const t of ['items', 'held', 'plan', 'soon', 'discount', 'aging', 'statement', 'deposits', 'interest'])
  await visit('#finance-ar?tab=' + t, 'ar-' + t);
for (const t of ['bank', 'notes', 'invoices', 'matching', 'tax'])
  await visit('#finance-cash?tab=' + t, 'cash-' + t);
for (const t of ['expenses', 'assets', 'payroll', 'costing', 'margin'])
  await visit('#finance-costs?tab=' + t, 'costs-' + t);
for (const t of ['vouchers', 'events', 'books', 'templates', 'audit'])
  await visit('#finance-ledger?tab=' + t, 'ledger-' + t);
for (const t of ['balance', 'profit', 'cashflow', 'trial', 'closing', 'dashboard', 'budget'])
  await visit('#finance-reports?tab=' + t, 'reports-' + t);
for (const t of ['accounts', 'periods']) await visit('#finance-settings?tab=' + t, 'settings-' + t);

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
await submit('保存');
await shot('cash-draft-panel');
await page.locator('.detail-panel').getByRole('button', { name: '确认', exact: true }).click();
await page.waitForTimeout(600);
await shot('cash-allocate-dialog');
await dlg().getByRole('button', { name: '确认', exact: true }).click();
await page.waitForTimeout(800);
await shot('cash-confirmed-panel');
await go(page, '#finance');
await shot('overview-after-receipt');
log('console errors:', [...new Set(consoleErrors)].slice(0, 20));
await context.close();
