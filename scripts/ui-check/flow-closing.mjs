// 财务结账这一组：撤销核销和收款、银行流水、发票、保证金、费用、固定资产、工资，再走成本、计提、结转、结账、
// 报表、反结账，最后看压款利息和收付计划已逾期。开头用接口准备好 basics + ledger 点出来的状态（启用、补税、
// 记账、收虚构北仑灯具一笔款并核销）；给后面准备数据的记账走接口，点按钮记账那一遍在 flow-ledger。全部虚构数据。
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SP, call as callOn, checkConsole, fail, go, login, openChrome } from './lib.mjs';
import { financeKit, period, shotsDir as out, today } from './finance-kit.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const ExcelJS = require('exceljs');
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
await login(page);
const { dlg, field, text, pick, combo, save, confirmDialog, fin, postAll, sync, prepareBooks, prepareReceipt, checkEventsLink } =
  financeKit(page);
await prepareBooks();
await prepareReceipt('虚构北仑灯具');
const log = (...a) => console.log(...a);
let n = 200;
const shot = async (label) => {
  await page.waitForTimeout(300);
  const errs = await page.locator('.fin-page .error, .detail-panel .error,[role=alert]').allInnerTexts();
  await page.screenshot({ path: `${out}/${++n}-${label}.png` });
  log(`[${n}] ${label}`, errs.length ? 'ERR: ' + errs.join(' | ').slice(0, 260) : 'ok');
};
const api = (path) => fin('GET', path);
/** 详情“更多”里的操作（撤销、处置这类危险项都在里面） */
const panelMore = async (t) => {
  await page.locator('.detail-panel .more-menu summary').first().click();
  await page.getByRole('menuitem', { name: t, exact: true }).click();
};
const row = (t) => page.locator('.fin-table tbody tr.record-row', { hasText: t }).first();
const panelBtn = (t) => page.locator('.detail-panel').getByRole('button', { name: t, exact: true }).first();
/** 直接调财务写接口造检查用的虚构数据 */
const send = (method, path, body) => fin(method, path, body);
/** 资金账户“当天”：各账户收入、支出合计（分） */
const dailyTotals = async () => {
  const rows = (await api('/cash/daily?date=' + today + '&pageSize=200')).rows || [];
  return rows.reduce(
    (t, r) => ({ income: t.income + Number(r.income), expense: t.expense + Number(r.expense) }),
    { income: 0, expense: 0 },
  );
};
/** 页面上的金额文字（“1,234.50”）换成分 */
const centsOf = (t) => Math.round(Number(String(t).replace(/[^\d.-]/g, '')) * 100);

/** 本月结了账以后再确认一张送货：业务单据详情说记到哪天，“生成凭证”确认窗多一句，凭证记到下月 1 号、摘要带单据日期 */
async function closedMonthDocument() {
  const draft = ((await callOn(page, 'GET', '/flow?kind=delivery&status=draft')) || [])[0];
  if (!draft) return fail('没有待送货的送货单，已结账月份补单据这一段没测');
  const preview = await callOn(page, 'POST', '/flow/' + draft.id + '/preview', {});
  const done = await callOn(page, 'POST', '/flow/' + draft.id + '/confirm', { previewDigest: preview.previewDigest, requestId: crypto.randomUUID(), acknowledged: true, shipDate: today });
  if (done.error) return fail('结账后确认送货单失败：' + done.error);
  await sync();
  await go(page, '#finance-ledger?tab=events');
  const line = page.locator('.fin-table tbody tr.record-row', { hasText: draft.number }).first();
  await line.click();
  const next = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const hint = page.locator('.detail-panel').getByText('单据所在月份已结账，生成凭证时记在 ' + next);
  if (!(await hint.waitFor({ timeout: 5000 }).then(() => true, () => false))) fail('已结账月份的单据详情没说记到 ' + next);
  await shot('closed-month-event');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('closed-month-event-phone');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^生成凭证（/ }).click();
  const ask = await dlg().innerText();
  if (!/其中 \d+ 张所在月份已结账，记到最早没结账的月份/.test(ask)) fail('生成凭证的确认窗没说有单据记到下个月：' + ask.slice(0, 120));
  await shot('closed-month-generate');
  await confirmDialog();
  const event = ((await fin('GET', '/events?pageSize=200')).rows || []).find((e) => e.source_kind === 'delivery' && String(e.source_id) === String(draft.id));
  const voucher = event?.voucher_id ? await fin('GET', '/vouchers/' + event.voucher_id) : null;
  if (!voucher?.header) fail('已结账月份的单据没生成凭证');
  else if (voucher.header.date !== next || !JSON.stringify(voucher).includes('单据日期 ' + today))
    fail('凭证没记到 ' + next + ' 或摘要没带单据日期：' + JSON.stringify({ date: voucher.header.date, description: voucher.header.description }));
  else log('已结账月份补的送货单：凭证记在 ' + next + '，摘要带单据日期 ok');
}

// 1 撤销核销，再撤销收款：实际收入要减回去
const m0 = await api('/monthly-report?period=' + period);
log('实收 before', m0.actualIncome);
const receiptDoc = ((await api('/cash/documents?pageSize=200')).rows || []).find(
  (c) => c.status === 'confirmed' && String(c.party_name).includes('虚构北仑灯具'),
);
const day0 = await dailyTotals();
await go(page, '#finance-cash?tab=documents');
await row('虚构北仑灯具').click();
await page.locator('.detail-panel').waitFor();
await shot('receipt-panel');
await page.locator('.detail-panel').getByRole('button', { name: '撤销' }).last().click();
await text('原因', '虚构录错');
await shot('revoke-dialog');
await save('确认撤销');
await postAll();
// 撤销核销当天：原核销凭证红冲、钱转回预收，账户里的钱没动，资金账户“当天”收入、支出都不变（红字不算支出）
const day1 = await dailyTotals();
if (day1.income !== day0.income || day1.expense !== day0.expense)
  fail('撤销核销后资金账户当天收支变了（红字凭证不该算成支出）：' + JSON.stringify({ before: day0, after: day1 }));
else log('撤销核销当天收支不变 ok', JSON.stringify(day1));
await go(page, '#finance-cash?tab=documents');
await row('虚构北仑灯具').click();
await page.locator('.detail-panel').getByText('已撤销').first().waitFor({ timeout: 5000 }).catch(() => {});
// 收付款详情的核销表：撤销的那条写“已撤销”，不露英文状态
{
  const panelText = await page.locator('.detail-panel').innerText();
  const english = panelText.match(/\b(revoked|reversing|reversed|active|confirmed|cancelled|posted|draft)\b/);
  if (english) fail('收付款详情露出英文状态：' + english[0]);
  if (!panelText.includes('已撤销')) fail('收付款详情的核销表里撤销的那条没写“已撤销”');
  await shot('receipt-revoked-panel');
}
await panelMore('撤销');
await text('原因', '虚构录错');
await save('确认撤销');
await shot('receipt-cancelled');
await postAll();
// 撤销整笔收款：钱真的退回去了，当天净额少了这一笔；红字冲的是收入，收入够冲时支出不变
if (receiptDoc) {
  const day2 = await dailyTotals();
  const x = Number(receiptDoc.amount_cents);
  if (day2.income - day2.expense !== day1.income - day1.expense - x)
    fail('撤销收款后资金账户当天净额不对：' + JSON.stringify({ before: day1, after: day2, amount: x }));
  else if (day1.income >= x && day2.expense !== day1.expense)
    fail('撤销收款的红字凭证被算成了支出：' + JSON.stringify({ before: day1, after: day2 }));
  else log('撤销收款当天收支 ok', JSON.stringify(day2));
} else fail('没找到虚构北仑灯具的已确认收款，没查资金账户当天收支');
const m1 = await api('/monthly-report?period=' + period);
log('实收 after cancel', m1.actualIncome, '（应减少 291000）');

// 2 银行流水 CSV 导入、匹配、余额调节
await go(page, '#finance-cash?tab=bank');
const csv = SP + '/fict-bank.csv';
writeFileSync(csv, `日期,金额,对方,摘要,流水号\n${today},100.50,虚构慈溪小家电有限公司,虚构货款,FICT001\n${today},-12.00,虚构银行,虚构手续费,FICT002\n`);
await page.getByRole('button', { name: '导入银行流水' }).click();
await text('日期在第几列', 1);
await text('金额在第几列', 2);
await text('对方在第几列', 3);
await text('摘要在第几列', 4);
await text('流水号在第几列', 5);
await dlg().locator('input[type=file]').setInputFiles(csv);
await save('导入流水');
await shot('bank-imported');
await row('虚构慈溪').click();
await page.locator('.detail-panel').waitFor();
await shot('bank-suggestions');
const match = page.locator('.detail-panel').getByRole('button', { name: '匹配', exact: true });
if (await match.count()) {
  await match.first().click();
  await page.locator('.detail-panel').getByRole('button', { name: '匹配', exact: true }).first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}
await page.keyboard.press('Escape');
await page.getByRole('button', { name: '余额调节' }).click();
await text('银行对账单余额', '88.50');
await save('生成调节表');
await shot('bank-reconcile');

// 3 发票：录入 → 选单据关联 → 确认
await go(page, '#finance-cash?tab=invoices');
await page.getByRole('button', { name: '新建发票' }).click();
const recv = await api('/obligations?kind=receivable&pageSize=50');
const bill = recv.rows.find((o) => o.balance > 0 && o.voucher_id);
log('开票对象', bill.party_name, bill.source_number, bill.amount_cents);
await text('票号', 'FICT-INV-1');
await combo('往来单位', bill.party_name);
await text('不含税', (bill.amount_cents / 100).toFixed(2));
await text('税率 %', '0');
await text('税额', '0');
await text('价税合计', (bill.amount_cents / 100).toFixed(2));
await save('保存发票');
await page.locator('.detail-panel').waitFor();
await shot('invoice-draft');
await panelBtn('关联单据').click();
await dlg().waitFor();
await shot('invoice-link-dialog');
await pick('对应的单据', String(bill.id));
await save('保存');
await panelBtn('确认').click();
await panelBtn('确认').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
await shot('invoice-confirmed');
await postAll();

// 4 保证金：新建 → 记账 → 转抵（选单据）。保证金在应收应付“账期”页签的一节里
await go(page, '#finance-ar?tab=deposits');
await page.getByRole('button', { name: '新建保证金' }).click();
await pick('方向', 'received');
await pick('单位类型', 'customer');
// “单位”要和“单位类型”分开：标签以“单位”开头、紧跟必填星号
await combo(/^单位\s*\*/, bill.party_name);
await pick('资金账户', { index: 1 });
await text('金额', '10');
await text('说明', '虚构保证金');
await save('保存保证金');
await postAll();
await go(page, '#finance-ar?tab=deposits');
await page.locator('#fin-sec-deposits .fin-table tbody tr.record-row').first().click();
await panelBtn('转抵货款').click();
await dlg().waitFor();
await shot('deposit-apply-dialog');
await pick('抵扣哪张单子', String(bill.id));
await text('原因', '虚构转抵');
await save('确认转抵');
await shot('deposit-applied');
await postAll();
// 保证金叫法：收进来的叫“收到保证金”，概览、月度台账、导出一致；不再有“保证金收回 / 收入 / 收取”
{
  const old = /保证金收回|保证金收入|保证金收取/;
  await go(page, '#finance');
  await page.locator('main').getByText('收到保证金').first().waitFor({ timeout: 5000 }).catch(() => {});
  const overview = await page.locator('main').innerText();
  if (!overview.includes('收到保证金')) fail('概览没有“收到保证金”');
  if (old.test(overview)) fail('概览还有旧叫法：' + overview.match(old)[0]);
  await shot('overview-deposit-name');
  await go(page, '#finance-flow');
  await page.locator('main').getByText('收到保证金').first().waitFor({ timeout: 5000 }).catch(() => {});
  const flow = await page.locator('main').innerText();
  if (!flow.includes('收到保证金')) fail('月度台账类型一栏没有“收到保证金”');
  if (old.test(flow)) fail('月度台账还有旧叫法：' + flow.match(old)[0]);
  const bytes = await page.evaluate(
    async (u) => Array.from(new Uint8Array(await (await fetch(u)).arrayBuffer())),
    '/api/finance/monthly-ledger/export?period=' + period,
  );
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes));
  const cells = [];
  book.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => cells.push(String(c.text ?? c.value ?? '')))));
  if (!cells.includes('收到保证金')) fail('台账导出没有“收到保证金”');
  if (cells.some((c) => old.test(c))) fail('台账导出还有旧叫法：' + cells.find((c) => old.test(c)));
  log('保证金叫法 ok');
}

// 5 费用：新建 → 提交 → 批准 → 付款
await go(page, '#finance-costs?tab=expenses');
await page.getByRole('button', { name: '新建费用单' }).click();
await text('员工工号', 'E001');
await text('员工姓名', '虚构员工');
await text('部门', '虚构部门');
await combo('费用科目', '560201');
await text('金额', '123');
await text('说明', '虚构办公费');
await save('保存费用单');
/** 点详情里的按钮，等列表里这一行的状态跟着变了再往下走 */
const advance = async (t, button) => {
  await row(t).click();
  const before = await row(t).innerText();
  await panelBtn(button).click();
  for (let i = 0; i < 50 && (await row(t).innerText()) === before; i++) await page.waitForTimeout(100);
};
await advance('虚构办公费', '提交审批');
await advance('虚构办公费', '批准');
await postAll();
await go(page, '#finance-costs?tab=expenses');
await row('虚构办公费').click();
await panelBtn('付款').click();
await pick('资金账户', { index: 1 });
await save('确认付款');
await shot('expense-paid');
await postAll();

// 6 固定资产
await go(page, '#finance-costs?tab=assets');
await page.getByRole('button', { name: '新建固定资产' }).click();
await text('编号', 'FICT-A1');
await text('名称', '虚构设备');
await text('类别', '设备');
await text('部门', '虚构部门');
await text('原值', '1200');
await text('使用月数', '12');
await combo('折旧费用科目', '560205');
await combo('付款科目', '1002');
await save('保存资产');
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
await dlg().locator('input[type=file]').setInputFiles(xlsx);
await save('导入工资表');
await shot('payroll-imported');

// 8 结账全程
await go(page, '#finance-reports?tab=closing');
await page.locator('.fb-closing').first().waitFor();
await shot('closing-start');
const closing0 = await api('/closing?period=' + period);
log('待结期间', closing0.next, 'steps', JSON.stringify(closing0.steps.map((s) => [s.key, s.ok])));
await checkEventsLink(closing0);
// 先填税率，这是真实用户结账前要做的
await go(page, '#finance-settings');
await page.getByRole('button', { name: '编辑设置', exact: true }).click();
for (const label of ['城建税率 %', '教育费附加率 %', '地方教育附加率 %', '所得税率 %']) await text(label, '0');
await save('保存设置');
const clickJobs = async () => {
  await go(page, '#finance-reports?tab=closing');
  await page.locator('.fb-closing').first().waitFor();
  for (const label of ['计提折旧', '计提工资', '计提税费']) {
    const b = page.locator('.fb-closing').getByRole('button', { name: label, exact: true });
    if (await b.count()) {
      await b.click();
      await confirmDialog();
      const e = await page.locator('.fin-page .error').allInnerTexts();
      log('  job', label, e.join('|').slice(0, 200) || 'ok');
      await postAll();
      await go(page, '#finance-reports?tab=closing');
      await page.locator('.fb-closing').first().waitFor();
    }
  }
};
// 当月确认一张无单价到货又在当月冲销：没记过账的作废到货算成本时两条流水都不计，不拦算成本也不拦结账
{
  const seed = ((await callOn(page, 'GET', '/flow?kind=arrival')) || [])[0];
  const saved = await callOn(page, 'POST', '/flow/arrival', {
    requestId: crypto.randomUUID(),
    supplierId: seed.supplierId,
    date: today,
    reference: 'GYS-SD-无价冲销',
    lines: [{ stockId: seed.lines[0].stockId, item: seed.lines[0].item, quantity: '10' }],
  });
  const preview = await callOn(page, 'POST', '/flow/' + saved.id + '/preview', {});
  const confirmed = await callOn(page, 'POST', '/flow/' + saved.id + '/confirm', {
    previewDigest: preview.previewDigest,
    requestId: crypto.randomUUID(),
    acknowledged: true,
  });
  if (confirmed.error) fail('核对入库无单价到货单失败：' + confirmed.error);
  const rev = await callOn(page, 'POST', '/flow/' + saved.id + '/reverse', {
    version: confirmed.version,
    reason: '虚构无价到货冲销',
    acknowledged: true,
  });
  if (rev.error) fail('冲销无单价到货单失败：' + rev.error);
  else log('无单价到货当月确认并冲销 ok', saved.number);
  await sync();
}
await go(page, '#finance-reports?tab=closing');
await page.locator('.fb-closing').first().waitFor();
await page.getByRole('link', { name: '计算成本', exact: true }).click();
await page.getByRole('button', { name: /计算 .* 成本/ }).click();
await dlg().waitFor();
await shot('costing-dialog');
for (const input of await dlg().locator('input').all()) await input.fill('100');
await dlg().getByRole('button', { name: '计算', exact: true }).click();
await dlg().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
const stillOpen = await page.locator('[role="dialog"][aria-modal="true"]').count();
if (stillOpen) { fail('计算成本失败：' + (await dlg().locator('.error').allInnerTexts()).join('|').slice(0, 300)); await dlg().getByRole('button', { name: '取消', exact: true }).click(); }
await shot('costing-done');
await postAll();
await clickJobs();
await shot('closing-after-jobs');
const events = await api('/events?pageSize=50');
log('待处理事件', JSON.stringify(events.rows.filter((e) => ['ready','info_pending','difference','source_deleted','cost_pending','waiting_invoice','awaiting_allocation_reversal'].includes(e.status)).map((e) => [e.source_kind, e.number, e.status, e.problem]).slice(0, 12)));
await go(page, '#finance-ledger?tab=events');
await page.locator('main .fin-table').first().waitFor().catch(() => {});
const gen2 = page.getByRole('button', { name: /^生成凭证（/ });
if (await gen2.count()) { await gen2.click(); await confirmDialog(); }
await postAll();
await go(page, '#finance-reports?tab=closing');
await page.locator('.fb-closing').first().waitFor();
const profit = page.getByRole('button', { name: '结转损益', exact: true });
if (await profit.count()) { await profit.click(); await confirmDialog(); await postAll(); }
await go(page, '#finance-reports?tab=closing');
await page.locator('.fb-closing').first().waitFor();
await shot('closing-ready');
const c2 = await api('/closing?period=' + period);
log('结账前', c2.canClose, JSON.stringify(c2.steps));
const closeBtn = page.locator('.fin-subform').getByRole('button', { name: '结账', exact: true });
if (await closeBtn.isEnabled().catch(() => false)) {
  await closeBtn.click();
  await confirmDialog();
  await shot('closed');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    page.getByRole('link', { name: '下载归档文件' }).click(),
  ]);
  const archiveName = download ? download.suggestedFilename() : '无';
  log(/\.zip$/.test(archiveName) ? '归档下载 ' + archiveName : 'ERR: 归档不是 zip：' + archiveName);
  await closedMonthDocument();
  await go(page, '#finance-reports?tab=reports');
  await page.locator('main table').first().waitFor().catch(() => {});
  await shot('balance-sheet');
  await page.getByRole('button', { name: '利润表', exact: true }).click();
  await page.locator('main table').first().waitFor().catch(() => {});
  await shot('profit-sheet');
  await go(page, '#finance-reports?tab=closing');
  await page.getByRole('button', { name: '反结账' }).click();
  await text('原因', '虚构反结账');
  await save('确认反结账');
  await shot('reopened');
} else fail("结账按钮不能点，结账、报表、反结账这一段没走：" + JSON.stringify((c2.steps || []).filter((s) => !s.ok).map((s) => s.key)));
// 9 压款利息和逾期：造一笔虚构手工应收（月初到期），确认一笔压款利息
{
  const recvAll = (await api('/obligations?kind=receivable&pageSize=200')).rows || [];
  const party = recvAll.find((o) => o.party_id)?.party_id;
  const ob = party
    ? await send('POST', '/obligations', {
        requestId: 'ui-check-interest-base',
        kind: 'receivable',
        partyId: Number(party),
        date: period + '-01',
        dueDate: period + '-01',
        amount: 100000,
        description: '虚构计息货款',
        counterAccount: '5001',
      })
    : { error: '没有客户' };
  if (ob.error) fail('造手工应收失败：' + ob.error);
  else {
    const base = ((await api('/obligations?kind=receivable&pageSize=200')).rows || []).find((o) => Number(o.id) === Number(ob.id));
    const interest = await send('POST', '/interest/confirm', {
      requestId: 'ui-check-interest',
      period,
      obligationId: Number(ob.id),
      version: Number(base?.version ?? 1),
      amount: 123,
      reason: '虚构计息',
    });
    if (interest.error) fail('确认压款利息失败：' + interest.error);
    await postAll();
    // 逐笔：利息那笔“单据”写“压款利息 月-日 1.23”，不笼统写“手工”
    const rows = (await api('/obligations?kind=receivable&pageSize=200')).rows || [];
    const it = rows.find((o) => o.record_kind === 'interest');
    if (!it) fail('逐笔里没找到压款利息那笔（record_kind=interest）');
    else {
      const label = '压款利息 ' + String(it.date).slice(5) + ' 1.23';
      await go(page, '#finance-ar');
      await page.locator('#fin-sec-items .fin-table').first().waitFor().catch(() => {});
      const cell = page.locator('#fin-sec-items .fin-table tbody td', { hasText: label });
      if (!(await cell.count())) fail('逐笔里压款利息那笔没写成“' + label + '”');
      else {
        await cell.first().scrollIntoViewIfNeeded();
        await shot('items-interest-name');
        log('逐笔压款利息 ok', label);
      }
    }
    // 收付计划：到期日早于今天的进“已逾期”一行，和到期提醒的逾期对得上；本月一行不含已逾期的
    const plan = await api(`/payment-plan?date=${today}&months=6`);
    const overdue = (plan.forecast || []).find((r) => r.period === 'overdue');
    const soon = (await api(`/due-soon?date=${today}&days=0&pageSize=200`)).rows || [];
    const soonOverdue = soon
      .filter((r) => r.kind === 'receivable' && Number(r.days_to_due) < 0)
      .reduce((n, r) => n + Number(r.balance), 0);
    if (!overdue || Number(overdue.receivable) !== soonOverdue)
      fail('收付计划“已逾期”和到期提醒对不上：' + JSON.stringify({ plan: overdue, soon: soonOverdue }));
    if (today > period + '-01' && !(Number(overdue?.receivable) > 0)) fail('月初到期的虚构应收没进“已逾期”一行');
    const month = (await api(`/payment-plan?date=${today}&months=6&dueMonth=${period}&pageSize=200`)).detail?.rows || [];
    if (month.some((r) => r.due_date < today)) fail('本月一行的明细里还有已逾期的');
    const late = (await api(`/payment-plan?date=${today}&months=6&dueMonth=overdue&pageSize=200`)).detail?.rows || [];
    if (late.some((r) => !(r.due_date < today))) fail('已逾期明细里有没逾期的');
    await go(page, '#finance-ar?tab=plan');
    await page.locator('#fin-sec-plan tbody tr').first().waitFor().catch(() => {});
    const planRow = page.locator('#fin-sec-plan tbody tr', { hasText: '已逾期' }).first();
    if (!(await planRow.count())) fail('收付计划没有“已逾期”一行');
    else {
      const shown = centsOf(await planRow.locator('td').nth(1).innerText());
      if (shown !== Number(overdue?.receivable)) fail('收付计划“已逾期”一行的应收显示 ' + shown + '，应为 ' + overdue?.receivable);
      await planRow.click();
      await page.locator('#fin-sec-plan').getByText('已逾期的应收').waitFor({ timeout: 5000 }).catch(() => {});
      if (!(await page.locator('#fin-sec-plan').getByText('已逾期的应收').count())) fail('点“已逾期”没出明细');
      await shot('plan-overdue');
      log('收付计划已逾期 ok', overdue?.receivable);
    }
  }
}

// 深色和 900 宽：财务几页查报错、深色确实生效（换了系统深浅要重新载入）、900 宽不横向溢出，凭证编辑窗放得下
const looks = async (label) => {
  const errors = await page.locator('main .error, [role=dialog] .error').allInnerTexts();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (errors.length) fail(label + ' 页面报错：' + errors.join(' | ').slice(0, 120));
  if (over > 0) fail(label + ' 横向溢出 ' + over + 'px');
  return theme;
};
await page.emulateMedia({ colorScheme: 'dark' });
await page.reload();
for (const hash of ['#finance', '#finance-flow', '#finance-ar?tab=terms']) {
  await go(page, hash);
  if ((await looks('深色 ' + hash)) !== 'dark') fail('深色 ' + hash + ' 没换成深色');
}
await shot('dark-terms');
await page.emulateMedia({ colorScheme: 'light' });
await page.reload();
await page.setViewportSize({ width: 900, height: 800 });
for (const hash of ['#finance', '#finance-flow']) {
  await go(page, hash);
  await looks('900 宽 ' + hash);
}
await go(page, '#finance-ledger?tab=vouchers');
await page.getByRole('button', { name: '新建凭证' }).click();
await dlg().waitFor();
if (await dlg().evaluate((el) => el.scrollWidth > el.clientWidth + 1)) fail('900 宽下凭证编辑窗横向滚动');
await shot('narrow-voucher-editor');
await dlg().getByRole('button', { name: '取消', exact: true }).click();
await page.setViewportSize({ width: 1440, height: 900 });
log('财务深色和 900 宽 ok');
await context.close().catch(() => {});
checkConsole(consoleErrors);
