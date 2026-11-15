// 财务的其他操作（自己一组，全新实例）：带期初余额启用、改设置、资金账户；票据新建到到期；预算；员工借款；
// 固定资产新增到处置；蓝票和红票。给后面准备数据的记账走接口（点按钮记账那一遍在 flow-ledger）。全部虚构数据。
import { businessDay, checkConsole, go, login, openChrome } from './lib.mjs';
import { financeKit, shotsDir } from './finance-kit.mjs';
const out = shotsDir;
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
await login(page);
const { dlg, field, text, pick, combo, save, postAll } = financeKit(page);
const log = (...a) => console.log(...a);
let n = 400;
const shot = async (label) => {
  await page.waitForTimeout(500);
  const errs = await page.locator('.fin-page .error,.detail-panel .error,main .error').allInnerTexts();
  await page.screenshot({ path: `${out}/${++n}-${label}.png` });
  log(`[${n}] ${label}`, errs.length ? 'ERR: ' + errs.join(' | ').slice(0, 260) : 'ok');
};
const inDays = (d) => businessDay(d);
/** 详情“更多”里的操作（处置这类危险项都在里面） */
const panelMore = async (t) => {
  await page.locator('.detail-panel .more-menu summary').first().click();
  await page.getByRole('menuitem', { name: t, exact: true }).click();
};

// A 启用：带期初余额明细
await go(page, '#finance-settings');
await page.getByRole('button', { name: '启用财务' }).click();
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
await page.getByRole('button', { name: '编辑设置', exact: true }).click();
await page.waitForTimeout(300);
await field('制单和审核必须不同人').locator('input').uncheck();
await text('城建税率 %', '7');
await shot('settings-edit');
await save('保存设置');
await shot('settings-saved');
// 资金账户
await go(page, '#finance-cash?tab=accounts');
await page.getByRole('button', { name: '新建资金账户' }).click();
await page.waitForTimeout(300);
await text('名称', '虚构基本户');
await combo('对应科目', '1002');
await save('保存账户');
await shot('accounts');

// B 票据
await go(page, '#finance-cash?tab=notes');
await page.getByRole('button', { name: '新建票据' }).click();
await page.waitForTimeout(400);
await combo('往来单位', '');
await text('票号', 'FICT-NOTE-1');
await text('承兑行', '虚构银行');
await text('到期日', inDays(90));
await text('金额', '500');
await shot('note-dialog');
await save('保存票据');
await shot('note-added');
await postAll();
await go(page, '#finance-cash?tab=notes');
await page.waitForTimeout(500);
await page.locator('.fin-table tbody tr.record-row', { hasText: 'FICT-NOTE-1' }).first().click();
await page.waitForTimeout(400);
await page.locator('.detail-panel').getByRole('button', { name: '变更状态', exact: true }).click();
await page.waitForTimeout(400);
await pick('变更为', 'matured');
await pick('资金账户', { index: 1 });
await text('原因', '虚构到期');
await shot('note-status-dialog');
await save('确认变更');
await shot('note-matured');
await postAll();

// C 预算
await go(page, '#finance-reports?tab=budget');
await page.getByRole('button', { name: '新建预算' }).click();
await page.waitForTimeout(400);
await combo('科目', '560201');
await text('金额', '1000');
await save('保存预算');
await shot('budget');

// D 员工借还款
await go(page, '#finance-costs?tab=expenses');
// 员工借还款在页头“更多”里
await page.locator('.page-actions .more-menu summary').first().click();
await page.getByRole('menuitem', { name: '新建员工借还款', exact: true }).click();
await page.waitForTimeout(400);
await text('员工工号', 'E001');
await text('员工姓名', '虚构员工');
await pick('资金账户', { index: 1 });
await text('金额', '200');
await text('说明', '虚构借款');
await shot('advance-dialog');
await save('保存借还款');
await shot('advance-done');
await postAll();

// E 固定资产新增 → 处置
await go(page, '#finance-costs?tab=assets');
await page.getByRole('button', { name: '新建固定资产' }).click();
await page.waitForTimeout(400);
await text('编号', 'FICT-A1');
await text('名称', '虚构设备');
await text('类别', '设备');
await text('部门', '虚构部门');
await text('原值', '1200');
await text('使用月数', '12');
await combo('折旧费用科目', '560205');
await combo('付款科目', '1002');
await save('保存资产');
await postAll();
await go(page, '#finance-costs?tab=assets');
await page.waitForTimeout(500);
await page.locator('.fin-table tbody tr.record-row', { hasText: '虚构设备' }).first().click();
await page.waitForTimeout(500);
await shot('asset-panel');
await panelMore('处置');
await page.waitForTimeout(400);
await text('处置收入', '100');
await pick('资金账户', { index: 1 });
await text('原因', '虚构处置');
await shot('asset-dispose-dialog');
await save('确认处置');
await shot('asset-disposed');
await postAll();

// F 蓝票 → 红票
await go(page, '#finance-cash?tab=invoices');
await page.getByRole('button', { name: '新建发票' }).click();
await page.waitForTimeout(500);
await text('票号', 'FICT-BLUE');
await combo('往来单位', '');
await text('不含税', '100');
await text('税率 %', '13');
await text('税额', '13');
await text('价税合计', '113');
await save('保存发票');
await page.waitForTimeout(500);
await shot('invoice-blue');
await page.keyboard.press('Escape');
const blue = await page.evaluate(async () => (await (await fetch('/api/finance/invoices?direction=sale&pageSize=5')).json()).rows[0].id);
await page.getByRole('button', { name: '新建发票' }).click();
await page.waitForTimeout(500);
await text('票号', 'FICT-RED');
await combo('往来单位', '');
await text('不含税', '-100');
await text('税率 %', '13');
await text('税额', '-13');
await text('价税合计', '-113');
await text('红票对应的蓝票编号', blue);
await shot('invoice-red-dialog');
await save('保存发票');
await shot('invoice-red');

await context.close().catch(() => {});
checkConsole(consoleErrors);
