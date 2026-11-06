// Claude 这边的界面补测：没点过的财务操作 + 设置页 + 全站深色窄窗口。全部虚构数据。
import { readFileSync, mkdirSync } from 'node:fs';
import { openChrome, BASE, SP, SERVER_SOURCE, go } from './lib.mjs';
const out = SP + '/ui4-shots';
mkdirSync(out, { recursive: true });
const seed = readFileSync(SERVER_SOURCE, 'utf8');
const [, name, password] = /add\('(虚构管理员)',\s*'([^']+)'/.exec(seed);
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
await page.goto(BASE);
await page.locator('.login-screen input').nth(0).fill(name);
await page.locator('.login-screen input').nth(1).fill(password);
await page.locator('.login-screen input').nth(1).press('Enter');
await page.locator('.shell').waitFor();
const log = (...a) => console.log(...a);
let n = 0;
const shot = async (label) => {
  await page.waitForTimeout(500);
  const errs = await page.locator('.fin-page .error,.detail-panel .error,main .error').allInnerTexts();
  await page.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${label}.png` });
  log(`[${n}] ${label}`, errs.length ? 'ERR: ' + errs.join(' | ').slice(0, 260) : 'ok');
};
const dlg = () => page.locator('[role="dialog"][aria-modal="true"]').last();
const field = (label) => dlg().locator('label.field', { hasText: label }).first();
const text = (label, v) => field(label).locator('input,textarea').first().fill(String(v));
const pick = (label, v) => field(label).locator('select').first().selectOption(v);
const combo = async (label, v) => {
  const i = field(label).locator('input').first();
  await i.click();
  if (v) await i.fill(v);
  await page.waitForTimeout(200);
  await i.press('ArrowDown');
  await i.press('Enter');
  await page.waitForTimeout(200);
};
const save = async (label = '保存') => {
  await dlg().getByRole('button', { name: label, exact: true }).click();
  await page.waitForTimeout(1000);
  const open = await page.locator('[role="dialog"][aria-modal="true"]').count();
  if (open) {
    log('  dialog error:', (await dlg().locator('.form-error,.error').allInnerTexts()).join('|').slice(0, 300));
    await page.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-dialog-error.png` });
    await dlg().getByRole('button', { name: '取消', exact: true }).click();
  }
  return !open;
};
const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const postAll = async () => {
  await go(page, '#finance-ledger?tab=vouchers');
  await page.waitForTimeout(500);
  for (const label of [/提交本页/, /审核本页/, /记账本页/]) {
    const b = page.getByRole('button', { name: label });
    if (await b.count()) {
      await b.click();
      await page.waitForTimeout(1500);
    }
  }
};

// A 启用：带期初余额明细
await go(page, '#finance-settings');
await page.getByRole('button', { name: '开始启用' }).click();
await page.waitForTimeout(300);
await pick('纳税人身份', 'general');
await dlg().getByRole('button', { name: '加一行' }).click();
await dlg().getByRole('button', { name: '加一行' }).click();
await dlg().getByLabel('期初科目').nth(0).selectOption('1002');
await dlg().getByLabel('debit', { exact: true }).nth(0).fill('5000');
await dlg().getByLabel('期初科目').nth(1).selectOption('3001');
await dlg().getByLabel('credit', { exact: true }).nth(1).fill('5000');
await shot('enable-with-opening');
await save('确认启用');
await shot('enabled');
// 一个人用
await page.getByRole('button', { name: '修改', exact: true }).click();
await page.waitForTimeout(300);
await field('制单和审核必须不同人').locator('input').uncheck();
await text('城建税率 %', '7');
await shot('settings-edit');
await save('保存');
await shot('settings-saved');
// 资金账户
await go(page, '#finance-cash?tab=accounts');
await page.getByRole('button', { name: '新建资金账户' }).click();
await page.waitForTimeout(300);
await text('名称', '虚构基本户');
await combo('对应科目', '1002');
await save('保存');
await shot('accounts');

// B 票据
await go(page, '#finance-cash?tab=notes');
await page.getByRole('button', { name: '新增票据' }).click();
await page.waitForTimeout(400);
await combo('往来单位', '');
await text('票号', 'FICT-NOTE-1');
await text('承兑行', '虚构银行');
await text('到期日', inDays(90));
await text('金额', '500');
await shot('note-dialog');
await save('保存');
await shot('note-added');
await postAll();
await go(page, '#finance-cash?tab=notes');
await page.waitForTimeout(500);
await page.getByRole('button', { name: '变更', exact: true }).first().click();
await page.waitForTimeout(400);
await pick('变更为', 'matured');
await pick('资金账户', { index: 1 });
await text('原因', '虚构到期');
await shot('note-status-dialog');
await save('保存');
await shot('note-matured');
await postAll();

// C 预算
await go(page, '#finance-reports?tab=budget');
await page.getByRole('button', { name: '设预算' }).click();
await page.waitForTimeout(400);
await combo('科目', '560201');
await text('金额', '1000');
await save('保存');
await shot('budget');

// D 员工借还款
await go(page, '#finance-costs?tab=expenses');
await page.getByRole('button', { name: '员工借还款' }).click();
await page.waitForTimeout(400);
await text('员工工号', 'E001');
await text('员工姓名', '虚构员工');
await pick('资金账户', { index: 1 });
await text('金额', '200');
await text('说明', '虚构借款');
await shot('advance-dialog');
await save('保存');
await shot('advance-done');
await postAll();

// E 固定资产新增 → 处置
await go(page, '#finance-costs?tab=assets');
await page.getByRole('button', { name: '新增资产' }).click();
await page.waitForTimeout(400);
await text('编号', 'FICT-A1');
await text('名称', '虚构设备');
await text('类别', '设备');
await text('部门', '虚构部门');
await text('原值', '1200');
await text('使用月数', '12');
await combo('折旧费用科目', '560205');
await combo('付款科目', '1002');
await save('保存');
await postAll();
await go(page, '#finance-costs?tab=assets');
await page.waitForTimeout(500);
await page.locator('.fin-table tbody tr.record-row', { hasText: '虚构设备' }).first().click();
await page.waitForTimeout(500);
await shot('asset-panel');
await page.locator('.detail-panel').getByRole('button', { name: '处置' }).click();
await page.waitForTimeout(400);
await text('处置收入', '100');
await pick('资金账户', { index: 1 });
await text('原因', '虚构处置');
await shot('asset-dispose-dialog');
await save('保存');
await shot('asset-disposed');
await postAll();

// F 蓝票 → 红票
await go(page, '#finance-cash?tab=invoices');
await page.getByRole('button', { name: '录入发票' }).click();
await page.waitForTimeout(500);
await text('票号', 'FICT-BLUE');
await combo('往来单位', '');
await text('不含税', '100');
await text('税率 %', '13');
await text('税额', '13');
await text('价税合计', '113');
await save('保存');
await page.waitForTimeout(500);
await shot('invoice-blue');
await page.keyboard.press('Escape');
const blue = await page.evaluate(async () => (await (await fetch('/api/finance/invoices?direction=sale&pageSize=5')).json()).rows[0].id);
await page.getByRole('button', { name: '录入发票' }).click();
await page.waitForTimeout(500);
await text('票号', 'FICT-RED');
await combo('往来单位', '');
await text('不含税', '-100');
await text('税率 %', '13');
await text('税额', '-13');
await text('价税合计', '-113');
await text('红票对应的蓝票编号', blue);
await shot('invoice-red-dialog');
await save('保存');
await shot('invoice-red');

// G 设置页逐个点
await page.keyboard.press('Escape');
await go(page, '#ai-settings');
await shot('settings-api');
for (const t of await page.locator('.ai-settings-tabs [role=tab], .ai-settings-tabs button').all()) {
  const label = (await t.innerText()).trim();
  await t.click();
  await page.waitForTimeout(500);
  await shot('settings-tab-' + label.slice(0, 6));
}

// H 全站深色和窄窗口
const pages = ['dashboard', 'inbox', 'ai-import', 'orders', 'customers', 'products', 'purchases', 'suppliers', 'production', 'warehouse', 'warehouse?arrivals=1', 'warehouse?deliveries=1&kind=finished', 'warehouse?flow=1', 'trash', 'guide'];
await page.emulateMedia({ colorScheme: 'dark' });
for (const p of pages) {
  await go(page, '#' + p);
  await shot('dark-' + p.split('?')[0] + (p.includes('?') ? '-' + p.split('?')[1].slice(0, 8).replace(/\W/g, '') : ''));
}
await page.emulateMedia({ colorScheme: 'light' });
await page.setViewportSize({ width: 900, height: 800 });
for (const p of pages) {
  await go(page, '#' + p);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 0) log('  横向溢出', p, over);
  await shot('narrow-' + p.split('?')[0] + (p.includes('?') ? '-' + p.split('?')[1].slice(0, 8).replace(/\W/g, '') : ''));
}
await context.close().catch(() => {});
log('console errors:', [...new Set(consoleErrors)].slice(0, 12));
