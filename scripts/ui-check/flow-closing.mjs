// 接着 ui1、ui2 的状态：把之前没点到底的操作都走完。全部虚构数据。
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { openChrome, BASE, SP, SERVER_SOURCE, go } from './lib.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const ExcelJS = require('exceljs');
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
let n = 200;
const shot = async (label) => {
  await page.waitForTimeout(600);
  const errs = await page.locator('.fin-page .error, .detail-panel .error,[role=alert]').allInnerTexts();
  await page.screenshot({ path: `${out}/${++n}-${label}.png` });
  log(`[${n}] ${label}`, errs.length ? 'ERR: ' + errs.join(' | ').slice(0, 260) : 'ok');
};
const dlg = () => page.locator('[role="dialog"][aria-modal="true"]').last();
const field = (label) => dlg().locator('label.field', { hasText: label }).first();
const text = (label, v) => field(label).locator('input,textarea').first().fill(String(v));
const pick = (label, v) => field(label).locator('select').first().selectOption(v);
const combo = async (label, v) => {
  const i = field(label).locator('input').first();
  await i.click();
  await i.fill(v);
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
    await page.screenshot({ path: `${out}/${++n}-dialog-error.png` });
    await dlg().getByRole('button', { name: '取消', exact: true }).click();
  }
  return !open;
};
const api = (path) => page.evaluate(async (p) => (await fetch('/api/finance' + p)).json(), path);
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
const row = (t) => page.locator('.fin-table tbody tr.record-row', { hasText: t }).first();
const panelBtn = (t) => page.locator('.detail-panel').getByRole('button', { name: t, exact: true }).first();
const period = await page.evaluate(() => new Date().toISOString().slice(0, 7));
const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));

// 1 撤销核销，再撤销收款：实际收入要减回去
const m0 = await api('/monthly-report?period=' + period);
log('实收 before', m0.actualIncome);
await go(page, '#finance-cash?tab=documents');
await page.waitForTimeout(500);
await row('虚构北仑灯具').click();
await page.waitForTimeout(500);
await shot('receipt-panel');
await page.locator('.detail-panel').getByRole('button', { name: '撤销' }).last().click();
await page.waitForTimeout(300);
await text('原因', '虚构录错');
await shot('revoke-dialog');
await save('保存');
await postAll();
await go(page, '#finance-cash?tab=documents');
await page.waitForTimeout(500);
await row('虚构北仑灯具').click();
await page.waitForTimeout(500);
await panelBtn('撤销').click();
await page.waitForTimeout(300);
await text('原因', '虚构录错');
await save('确认撤销');
await shot('receipt-cancelled');
await postAll();
const m1 = await api('/monthly-report?period=' + period);
log('实收 after cancel', m1.actualIncome, '（应减少 291000）');

// 2 银行流水 CSV 导入、匹配、余额调节
await go(page, '#finance-cash?tab=bank');
const csv = SP + '/fict-bank.csv';
writeFileSync(csv, `日期,金额,对方,摘要,流水号\n${today},100.50,虚构慈溪小家电有限公司,虚构货款,FICT001\n${today},-12.00,虚构银行,虚构手续费,FICT002\n`);
await page.getByRole('button', { name: '导入流水' }).click();
await page.waitForTimeout(300);
await text('日期在第几列', 1);
await text('金额在第几列', 2);
await text('对方在第几列', 3);
await text('摘要在第几列', 4);
await text('流水号在第几列', 5);
await dlg().locator('input[type=file]').setInputFiles(csv);
await save('导入');
await shot('bank-imported');
await row('虚构慈溪').click();
await page.waitForTimeout(600);
await shot('bank-suggestions');
const match = page.locator('.detail-panel').getByRole('button', { name: '匹配', exact: true });
if (await match.count()) {
  await match.first().click();
  await page.waitForTimeout(800);
}
await page.keyboard.press('Escape');
await page.getByRole('button', { name: '余额调节' }).click();
await page.waitForTimeout(300);
await text('银行对账单余额', '88.50');
await save('生成');
await shot('bank-reconcile');

// 3 发票：录入 → 选单据关联 → 确认
await go(page, '#finance-cash?tab=invoices');
await page.getByRole('button', { name: '录入发票' }).click();
await page.waitForTimeout(500);
const recv = await api('/obligations?kind=receivable&pageSize=50');
const bill = recv.rows.find((o) => o.balance > 0 && o.voucher_id);
log('开票对象', bill.party_name, bill.source_number, bill.amount_cents);
await text('票号', 'FICT-INV-1');
await combo('往来单位', bill.party_name);
await text('不含税', (bill.amount_cents / 100).toFixed(2));
await text('税率 %', '0');
await text('税额', '0');
await text('价税合计', (bill.amount_cents / 100).toFixed(2));
await save('保存');
await page.waitForTimeout(500);
await shot('invoice-draft');
await panelBtn('关联往来单').click();
await page.waitForTimeout(800);
await shot('invoice-link-dialog');
await pick('对应的单据', String(bill.id));
await save('保存');
await panelBtn('确认').click();
await page.waitForTimeout(1000);
await shot('invoice-confirmed');
await postAll();

// 4 保证金：录入 → 记账 → 转抵（选单据）
await go(page, '#finance-ar?tab=deposits');
await page.getByRole('button', { name: '新增保证金' }).click();
await page.waitForTimeout(500);
await pick('方向', 'received');
await pick('单位类型', 'customer');
await page.waitForTimeout(300);
await combo('单位 *', bill.party_name);
await pick('资金账户', { index: 1 });
await text('金额', '10');
await text('说明', '虚构保证金');
await save('保存');
await postAll();
await go(page, '#finance-ar?tab=deposits');
await page.waitForTimeout(500);
await page.locator('.more-menu summary').first().click();
await page.getByRole('button', { name: '转抵货款' }).click();
await page.waitForTimeout(800);
await shot('deposit-apply-dialog');
await pick('抵扣哪张单子', String(bill.id));
await text('原因', '虚构转抵');
await save('保存');
await shot('deposit-applied');
await postAll();

// 5 费用：新建 → 提交 → 批准 → 付款
await go(page, '#finance-costs?tab=expenses');
await page.getByRole('button', { name: '新建费用单' }).click();
await page.waitForTimeout(500);
await text('员工工号', 'E001');
await text('员工姓名', '虚构员工');
await text('部门', '虚构部门');
await combo('费用科目', '560201');
await text('金额', '123');
await text('说明', '虚构办公费');
await save('保存');
await row('虚构办公费').click();
await page.waitForTimeout(500);
await panelBtn('提交审批').click();
await page.waitForTimeout(800);
await row('虚构办公费').click();
await page.waitForTimeout(500);
await panelBtn('批准').click();
await page.waitForTimeout(800);
await postAll();
await go(page, '#finance-costs?tab=expenses');
await page.waitForTimeout(500);
await row('虚构办公费').click();
await page.waitForTimeout(500);
await panelBtn('付款').click();
await page.waitForTimeout(400);
await pick('资金账户', { index: 1 });
await save('保存');
await shot('expense-paid');
await postAll();

// 6 固定资产
await go(page, '#finance-costs?tab=assets');
await page.getByRole('button', { name: '新增资产' }).click();
await page.waitForTimeout(500);
await text('编号', 'FICT-A1');
await text('名称', '虚构设备');
await text('类别', '设备');
await text('部门', '虚构部门');
await text('原值', '1200');
await text('使用月数', '12');
await combo('折旧费用科目', '560205');
await combo('付款科目', '1002');
await save('保存');
await shot('asset-added');
await postAll();

// 7 工资：Excel 导入
await go(page, '#finance-costs?tab=payroll');
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('工资');
ws.addRow(['工号', '姓名', '部门', '科目', '应发', '个人社保', '个人公积金', '个税', '实发', '单位社保', '单位公积金']);
ws.addRow(['E001', '虚构员工', '虚构部门', '560204', 300000, 0, 0, 0, 300000, 0, 0]);
const xlsx = SP + '/fict-payroll.xlsx';
await wb.xlsx.writeFile(xlsx);
await page.getByRole('button', { name: '导入工资表' }).click();
await page.waitForTimeout(300);
await dlg().locator('input[type=file]').setInputFiles(xlsx);
await save('导入');
await page.waitForTimeout(500);
await shot('payroll-imported');

// 8 结账全程
await go(page, '#finance-reports?tab=closing');
await page.waitForTimeout(800);
await shot('closing-start');
const closing0 = await api('/closing?period=' + period);
log('待结期间', closing0.next, 'steps', JSON.stringify(closing0.steps.map((s) => [s.key, s.ok])));
// 先填税率，这是真实用户结账前要做的
await go(page, '#finance-settings');
await page.getByRole('button', { name: '修改', exact: true }).click();
await page.waitForTimeout(300);
for (const label of ['城建税率 %', '教育费附加率 %', '地方教育附加率 %', '所得税率 %']) await text(label, '0');
await save('保存');
const clickJobs = async () => {
  await go(page, '#finance-reports?tab=closing');
  await page.waitForTimeout(800);
  for (const label of ['计提折旧', '工资计提', '税费计提']) {
    const b = page.getByRole('button', { name: label, exact: true });
    if (await b.count()) {
      await b.click();
      await page.waitForTimeout(1500);
      const e = await page.locator('.fin-page .error').allInnerTexts();
      log('  job', label, e.join('|').slice(0, 200) || 'ok');
      await postAll();
      await go(page, '#finance-reports?tab=closing');
      await page.waitForTimeout(800);
    }
  }
};
await go(page, '#finance-reports?tab=closing');
await page.waitForTimeout(800);
await page.getByRole('link', { name: '计算成本', exact: true }).click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: /计算 .* 成本/ }).click();
await page.waitForTimeout(800);
await shot('costing-dialog');
for (const input of await dlg().locator('input').all()) await input.fill('100');
await dlg().getByRole('button', { name: '计算', exact: true }).click();
await page.waitForTimeout(1500);
const stillOpen = await page.locator('[role="dialog"][aria-modal="true"]').count();
if (stillOpen) { log('  costing err:', (await dlg().locator('.error').allInnerTexts()).join('|').slice(0, 300)); await dlg().getByRole('button', { name: '取消', exact: true }).click(); }
await shot('costing-done');
await postAll();
await clickJobs();
await shot('closing-after-jobs');
const events = await api('/events?pageSize=50');
log('待处理事件', JSON.stringify(events.rows.filter((e) => ['ready','info_pending','difference','source_deleted','cost_pending','waiting_invoice','awaiting_allocation_reversal'].includes(e.status)).map((e) => [e.source_kind, e.number, e.status, e.problem]).slice(0, 12)));
await go(page, '#finance-ledger?tab=events');
await page.waitForTimeout(800);
const gen2 = page.getByRole('button', { name: /全部生成凭证/ });
if (await gen2.count()) { await gen2.click(); await page.waitForTimeout(1500); }
await postAll();
await go(page, '#finance-reports?tab=closing');
await page.waitForTimeout(800);
const profit = page.getByRole('button', { name: '结转损益', exact: true });
if (await profit.count()) { await profit.click(); await page.waitForTimeout(1200); await postAll(); }
await go(page, '#finance-reports?tab=closing');
await page.waitForTimeout(800);
await shot('closing-ready');
const c2 = await api('/closing?period=' + period);
log('结账前', c2.canClose, JSON.stringify(c2.steps));
const closeBtn = page.locator('.fin-subform').getByRole('button', { name: '结账', exact: true });
if (await closeBtn.isEnabled().catch(() => false)) {
  await closeBtn.click();
  await page.waitForTimeout(1500);
  await shot('closed');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    page.getByRole('link', { name: '下载归档文件' }).click(),
  ]);
  const archiveName = download ? download.suggestedFilename() : '无';
  log(/\.zip$/.test(archiveName) ? '归档下载 ' + archiveName : 'ERR: 归档不是 zip：' + archiveName);
  await go(page, '#finance-reports?tab=balance');
  await page.waitForTimeout(800);
  await shot('balance-sheet');
  await go(page, '#finance-reports?tab=profit');
  await page.waitForTimeout(800);
  await shot('profit-sheet');
  await go(page, '#finance-reports?tab=closing');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: '反结账' }).click();
  await page.waitForTimeout(300);
  await text('原因', '虚构反结账');
  await save('确认反结账');
  await shot('reopened');
}
// 深色模式和窄窗口
await page.emulateMedia({ colorScheme: 'dark' });
await go(page, '#finance');
await shot('dark-overview');
await go(page, '#finance-ar?tab=terms');
await page.getByRole('button', { name: /设置客户账期/ }).click();
await page.waitForTimeout(600);
await shot('dark-terms-dialog');
await dlg().getByRole('button', { name: '取消', exact: true }).click();
await go(page, '#finance-flow');
await shot('dark-flow');
await page.emulateMedia({ colorScheme: 'light' });
await page.setViewportSize({ width: 900, height: 800 });
await go(page, '#finance');
await shot('narrow-overview');
await go(page, '#finance-flow');
await shot('narrow-flow');
await go(page, '#finance-ledger?tab=vouchers');
await page.getByRole('button', { name: '新建凭证' }).click();
await page.waitForTimeout(600);
await shot('narrow-voucher-editor');
await dlg().getByRole('button', { name: '取消', exact: true }).click();
await page.setViewportSize({ width: 1440, height: 900 });
await go(page, '#dashboard');
await shot('nav-collapsed');
await context.close().catch(() => {});
log('console errors:', [...new Set(consoleErrors)].slice(0, 10));
