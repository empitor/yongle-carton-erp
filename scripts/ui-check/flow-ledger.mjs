// 接着 finance-ui.mjs 的状态，走完补税→制单→记账→核销→撤销→报表→结账。
import { readFileSync } from 'node:fs';
import { openChrome, BASE, SP, SERVER_SOURCE, go } from './lib.mjs';
const out = SP + '/finance-shots';
const seed = readFileSync(SERVER_SOURCE, 'utf8');
const [, name, password] = /add\('(虚构管理员)',\s*'([^']+)'/.exec(seed);
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
await page.goto(BASE);
await page.locator('.login-screen input').nth(0).fill(name);
await page.locator('.login-screen input').nth(1).fill(password);
await page.locator('.login-screen input').nth(1).press('Enter');
await page.locator('.shell').waitFor();
const log = (...a) => console.log(...a);
let n = 100;
const shot = async (label) => {
  await page.waitForTimeout(600);
  const errs = await page.locator('.error,[role=alert]').allInnerTexts();
  await page.screenshot({ path: `${out}/${++n}-${label}.png` });
  log(`[${n}] ${label}`, errs.length ? 'ERR: ' + errs.join(' | ').slice(0, 300) : 'ok');
};
const dlg = () => page.locator('[role="dialog"][aria-modal="true"]').last();
const field = (label) => dlg().locator('label.field', { hasText: label }).first();
const close = async () => {
  await page.waitForTimeout(800);
  const c = await page.locator('[role="dialog"][aria-modal="true"]').count();
  if (c) log('  still open:', (await dlg().locator('.form-error,.error').allInnerTexts()).join('|'));
  return !c;
};
const api = (path) =>
  page.evaluate(async (p) => (await fetch('/api/finance' + p)).json(), path);
const period = await page.evaluate(() => new Date().toISOString().slice(0, 7));

// A 关掉审核分离（一个人用的时候必须关）
await go(page, '#finance-settings');
await page.getByRole('button', { name: '修改', exact: true }).click();
await page.waitForTimeout(300);
await field('制单和审核必须不同人').locator('input').uncheck();
await dlg().getByRole('button', { name: '保存', exact: true }).click();
await close();
await shot('settings-saved');

// B 批量补税
await go(page, '#finance-flow?missing=1');
await page.waitForTimeout(800);
await shot('flow-missing');
await page.getByRole('button', { name: '全选本页待补' }).click();
await page.getByRole('button', { name: /补选中/ }).click();
await page.waitForTimeout(300);
await field('税率 %').locator('input').fill('13');
await field('口径').locator('select').selectOption('未税');
await shot('batch-dialog');
await dlg().getByRole('button', { name: '保存', exact: true }).click();
await close();
await shot('flow-after-batch');
log('monthly', JSON.stringify(await api('/monthly-report?period=' + period)).slice(0, 220));
log('readiness', JSON.stringify(await api('/reports/readiness?period=' + period)).slice(0, 160));

// C 生成凭证并记账
await go(page, '#finance-ledger?tab=events');
await page.waitForTimeout(800);
await shot('events-ready');
const gen = page.getByRole('button', { name: /全部生成凭证/ });
if (await gen.count()) {
  await gen.click();
  await page.waitForTimeout(1500);
}
await shot('events-generated');
await go(page, '#finance-ledger?tab=vouchers');
await page.waitForTimeout(600);
await shot('vouchers-draft');
for (const label of [/提交本页/, /审核本页/, /记账本页/]) {
  const b = page.getByRole('button', { name: label });
  if (await b.count()) {
    await b.click();
    await page.waitForTimeout(1500);
  } else log('  no button', String(label));
}
await shot('vouchers-posted');
const firstVoucher = page.locator('.fin-table tbody tr.record-row').first();
await firstVoucher.click();
await shot('voucher-panel');
await page.keyboard.press('Escape');
await page.locator('.detail-panel').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});

// D 收款核销，再撤销
await go(page, '#finance-cash?tab=documents');
await page.getByRole('button', { name: '新建收付款' }).click();
await page.waitForTimeout(800);
const obs = await api('/obligations?kind=receivable&pageSize=5');
const target = obs.rows.find((r) => r.balance > 0);
log('receivable', target?.party_name, target?.balance, target?.due_date);
const pi = field('往来单位').locator('input').first();
await pi.click();
await pi.fill(target.party_name);
await page.waitForTimeout(200);
await pi.press('ArrowDown');
await pi.press('Enter');
await field('金额').locator('input').fill(String(target.balance / 100));
await field('说明').locator('input').fill('虚构收款');
await dlg().getByRole('button', { name: '保存', exact: true }).click();
await close();
await page.locator('.detail-panel').getByRole('button', { name: '确认', exact: true }).click();
await page.waitForTimeout(800);
await shot('allocate-with-lines');
await dlg().getByRole('button', { name: '确认', exact: true }).click();
await close();
await shot('confirmed-with-allocation');
log('after receipt', JSON.stringify((await api('/monthly-report?period=' + period)).sources));
await go(page, '#finance-ledger?tab=vouchers');
await page.waitForTimeout(500);
for (const label of [/提交本页/, /审核本页/, /记账本页/]) {
  const b = page.getByRole('button', { name: label });
  if (await b.count()) {
    await b.click();
    await page.waitForTimeout(1200);
  }
}
await go(page, '#finance-cash?tab=documents');
await page.waitForTimeout(500);
await page.locator('.fin-table tbody tr.record-row').first().click();
await page.waitForTimeout(500);
await page.locator('.detail-panel').getByRole('button', { name: '撤销', exact: true }).first().click();
await page.waitForTimeout(300);
await shot('cancel-or-revoke');
await context.close().catch(() => {});
log('console errors:', [...new Set(consoleErrors)].slice(0, 10));
