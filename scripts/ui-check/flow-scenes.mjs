// 财务补充场景（自己一组）：开头用接口准备好启用、记账、一项固定资产、一张已付款的费用单、一笔保证金，
// 再用接口造出平时数据里没有的几种情况，看页面。
// - 按单位“已送货未开票”有数：改成开票确认收入，确认一张待送货，记账后开一半的销售发票
// - 压款利息“已算到哪天、这次几天”：给一个客户设利息，记一笔已到期的手工应收，确认一次早于今天的利息
// - 结账检查里“启用前单据的变动”：把种子里上个月的那张送货单冲销
// - 派生凭证的撤回、红字冲销：保证金、票据、资产处置、坏账、费用报销各打开一次（没记账的撤回到底）
// 种子是虚构数据；脚本只走公开接口（财务的服务不对脚本开放）。
import { call as callOn, checkConsole, fail, go, login, openChrome } from './lib.mjs';
import { financeKit, period, shotsDir as out, today } from './finance-kit.mjs';
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
await login(page);
const { dlg, fin, must, postAll, prepareBooks, sync } = financeKit(page);
const call = (method, path, body) => callOn(page, method, path, body);
await prepareBooks();
{
  const account = ((await fin('GET', '/cash/accounts?pageSize=50')).rows || [])[0];
  const party = ((await fin('GET', '/obligations?kind=receivable&pageSize=200')).rows || []).find((o) => o.party_id)?.party_id;
  await must('建固定资产', fin('POST', '/assets', { number: 'FICT-A1', name: '虚构设备', category: '设备', department: '虚构部门', date: today, original: 120000, months: 12, residualBp: 0, expenseAccount: '560205', counterAccount: '1002', cashFlow: '购建固定资产支付的现金' }));
  await must('建保证金', fin('POST', '/deposits', { kind: 'received', partyKind: 'customer', partyId: Number(party), accountId: Number(account.id), date: today, amount: 1000, description: '虚构保证金' }));
  const expense = await must('建费用单', fin('PUT', '/expenses', { employeeId: 'E001', employeeName: '虚构员工', department: '虚构部门', date: today, amount: 12300, accountCode: '560201', description: '虚构办公费' }));
  const submitted = await must('提交费用单', fin('POST', '/expenses/' + expense.id + '/transition', { action: 'submit', version: expense.version }));
  await must('批准费用单', fin('POST', '/expenses/' + expense.id + '/transition', { action: 'approve', version: submitted.version, date: today }));
  await postAll();
  const approved = ((await fin('GET', '/expenses?pageSize=50')).rows || []).find((e) => Number(e.id) === Number(expense.id));
  await must('费用单付款', fin('POST', '/expenses/' + expense.id + '/transition', { action: 'pay', version: approved.version, date: today, accountId: Number(account.id) }));
  await postAll();
}
let n = 300;
const log = (...a) => console.log(...a);
const shot = async (label) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${++n}-${label}.png` });
  log(`[${n}] ${label}`);
};

// 1 已送货未开票
{
  const settings = await fin('GET', '/settings');
  const set = await fin('PUT', '/settings', { version: settings.version, revenueRecognition: 'invoice' });
  if (set.error) fail('改成开票确认收入失败：' + set.error);
  const draft = ((await call('GET', '/flow?kind=delivery&status=draft')) || [])[0];
  if (!draft) fail('种子里没有待送货的送货单');
  else {
    const preview = await call('POST', '/flow/' + draft.id + '/preview', {});
    const done = await call('POST', '/flow/' + draft.id + '/confirm', { previewDigest: preview.previewDigest, requestId: crypto.randomUUID(), acknowledged: true, shipDate: today });
    if (done.error) fail('确认送货单失败：' + done.error);
    await sync();
    // 开票确认收入：送货单同步后等发票，往来先挂上，开票确认时才记收入
    const event = ((await fin('GET', '/events?pageSize=200')).rows || []).find((e) => e.source_kind === 'delivery' && String(e.source_id) === String(draft.id));
    if (!event) fail('没找到这张送货单的财务事件');
    const ob = ((await fin('GET', '/obligations?kind=receivable&pageSize=200')).rows || []).find((o) => event && Number(o.event_id) === Number(event.id));
    if (!ob) fail('没找到这张送货单的应收');
    else {
      const gross = Math.floor(Number(ob.amount_cents) / 2),
        net = Math.round((gross * 100) / 113);
      const bill = await fin('POST', '/invoices', { direction: 'sale', type: '增值税专用发票', number: 'XN-' + Date.now(), date: today, partyId: Number(ob.party_id), net, rate: '13', tax: gross - net, gross });
      const linked = bill.error ? bill : await fin('PUT', '/invoices/' + bill.id + '/links', { version: 1, links: [{ obligationId: Number(ob.id), amount: gross }] });
      const confirmed = linked.error ? linked : await fin('POST', '/invoices/' + bill.id + '/confirm', { version: 2 });
      if (confirmed.error) fail('开一半的销售发票失败：' + confirmed.error);
      await postAll();
    }
  }
  await go(page, '#finance-ar?tab=held');
  await page.waitForTimeout(1200);
  const text = await page.locator('#fin-sec-held').innerText();
  if (!text.includes('已送货未开票')) fail('按单位没有“已送货未开票”');
  await shot('held-uninvoiced');
}

// 2 压款利息接着算
{
  const terms = (await fin('GET', '/party-terms?kind=customer&pageSize=200')).rows || [];
  const party = ((await fin('GET', '/obligations?kind=receivable&pageSize=200')).rows || []).find((o) => o.party_id && !terms.some((t) => String(t.party_id) === String(o.party_id)))?.party_id;
  const interest = { rate: '36.5', unit: 'annual', basis: 'overdue', freeDays: 0 };
  const saved = party
    ? await fin('PUT', '/party-terms/customer/' + party, { termType: 'none', taxRate: null, taxMode: null, creditLimit: null, options: { discounts: [], installments: [], deposits: false, interest } })
    : { error: '没有可用的客户' };
  if (saved.error) fail('设利息失败：' + saved.error);
  const ob = saved.error ? saved : await fin('POST', '/obligations', { kind: 'receivable', partyId: Number(party), date: period + '-01', dueDate: period + '-01', amount: 100000, description: '虚构计息货款（接着算）', counterAccount: '5001' });
  if (ob.error) fail('造手工应收失败：' + ob.error);
  await postAll();
  // 先确认一次，算到月初后两天（不晚于今天），下次就从那天之后接着算
  const through = [period + '-03', today].sort()[0];
  const row = ((await fin('GET', '/interest?kind=receivable&period=' + period + '&pageSize=200')).rows || []).find((r) => Number(r.id) === Number(ob.id));
  const confirmed = row ? await fin('POST', '/interest/confirm', { period, obligationId: Number(ob.id), version: Number(row.version), date: through }) : { error: '利息列表里没有这笔' };
  if (confirmed.error) fail('确认利息失败：' + confirmed.error);
  await postAll();
  await go(page, '#finance-ar?tab=interest');
  await page.waitForTimeout(1500);
  const text = await page.locator('#fin-sec-interest').innerText();
  if (!text.includes(through)) fail('利息列表没写已算到 ' + through);
  await shot('interest-through');
  const line = page.locator('#fin-sec-interest .fin-table tbody tr.record-row', { hasText: '虚构' }).first();
  if (await line.count()) {
    await line.click();
    await shot('interest-panel');
    const confirmBtn = page.locator('.detail-panel').getByRole('button', { name: '确认利息', exact: true });
    if (await confirmBtn.count()) {
      await confirmBtn.click();
      await shot('interest-confirm-dialog');
      await dlg().getByRole('button', { name: '取消', exact: true }).click();
    }
  }
}

// 3 启用前单据的变动：冲销种子里上个月那张送货单
{
  const doc = ((await call('GET', '/flow?kind=delivery')) || []).find((d) => d.notes === '虚构启用前送货');
  if (!doc) fail('种子里没有“虚构启用前送货”那张送货单');
  else {
    const reversed = await call('POST', '/flow/' + doc.id + '/reverse', { version: doc.version, reason: '虚构冲销', acknowledged: true });
    if (reversed.error) fail('冲销启用前送货单失败：' + reversed.error);
    await sync();
    const check = await fin('GET', '/closing?period=' + period);
    const step = (check.steps || []).find((s) => s.key === 'opening');
    if (!step || step.ok) fail('结账检查里没有启用前单据要核对：' + JSON.stringify(step));
    await go(page, '#finance-reports?tab=closing');
    await page.waitForTimeout(1200);
    if (doc.number && !(await page.locator('.fb-steps').innerText()).includes(doc.number)) fail('启用前单据清单没写单号 ' + doc.number);
    await shot('closing-opening');
    const ack = page.locator('.fb-steps').getByRole('button', { name: '核对无误', exact: true }).first();
    if (await ack.count()) {
      await ack.click();
      await shot('closing-opening-ack');
      await dlg().getByRole('button', { name: '取消', exact: true }).click();
    }
  }
}

// 4 派生凭证：保证金详情“更多”里的红字冲销 / 撤回
{
  await go(page, '#finance-ar?tab=deposits');
  const line = page.locator('#fin-sec-deposits .fin-table tbody tr.record-row').first();
  if (!(await line.waitFor({ timeout: 8000 }).then(() => true, () => false))) fail('没有保证金可看');
  else {
    await line.click();
    await page.waitForTimeout(800);
    await page.locator('.detail-panel .more-menu summary').first().click();
    const item = page.getByRole('menuitem', { name: /^(红字冲销|撤回)$/ });
    if (!(await item.count())) fail('保证金详情的“更多”里没有撤回或红字冲销');
    else {
      await item.first().click();
      await shot('deposit-source-voucher');
      await dlg().getByRole('button', { name: '取消', exact: true }).click();
    }
  }
}

// 5 派生凭证的撤回、红字冲销：每种来源打开一次入口
/** 打开某一行的详情，点“更多”里名字以 prefix 开头的那项；返回有没有找到 */
const openMore = async (hash, section, text, prefix) => {
  await go(page, hash);
  // 数据是接口直接造的，页面不知道变了：重新载入再找
  await page.reload();
  await page.locator('.shell').waitFor();
  await page.waitForTimeout(1200);
  const lines = page.locator(section + ' .fin-table tbody tr.record-row', { hasText: text });
  // 同样写着这几个字的行可能有几条，挨个打开，找“更多”里有这一项的那条
  for (let i = 0; i < Math.min(await lines.count(), 6); i++) {
    await lines.nth(i).click();
    await page.waitForTimeout(800);
    const more = page.locator('.detail-panel .more-menu summary').first();
    if (!(await more.count())) continue;
    await more.click();
    const item = page.getByRole('menuitem', { name: new RegExp('^' + prefix) });
    if (await item.count()) {
      await item.first().click();
      await page.waitForTimeout(400);
      return true;
    }
    await page.keyboard.press('Escape');
  }
  fail(hash + ' 里写着“' + text + '”的行，“更多”里都没有“' + prefix + '…”');
  return false;
};
const cancelDialog = () => dlg().getByRole('button', { name: '取消', exact: true }).click();
const withdrawWith = async (label) => {
  await dlg().locator('textarea').first().fill('虚构录错');
  await dlg().getByRole('button', { name: label, exact: true }).click();
  await page.waitForTimeout(1000);
};
{
  const parties = (await fin('GET', '/obligations?kind=receivable&pageSize=200')).rows || [];
  const party = Number(parties.find((o) => o.party_id)?.party_id);
  const account = ((await fin('GET', '/cash/accounts?pageSize=50')).rows || [])[0];
  // 没记账的保证金：撤回，列表写“已撤回”
  const dep = await fin('POST', '/deposits', { kind: 'received', partyKind: 'customer', partyId: party, accountId: Number(account?.id), date: today, amount: 2000, description: '虚构保证金（撤回）' });
  if (dep.error) fail('造保证金失败：' + dep.error);
  if (!dep.error && await openMore('#finance-ar?tab=deposits', '#fin-sec-deposits', '虚构保证金（撤回）', '撤回')) {
    await shot('source-withdraw-dialog');
    await withdrawWith('撤回');
    await shot('source-withdrawn-deposit');
  }
  // 有退回、转抵的保证金：详情里每笔一行
  await go(page, '#finance-ar?tab=deposits');
  await page.waitForTimeout(1000);
  const used = page.locator('#fin-sec-deposits .fin-table tbody tr.record-row', { hasText: '虚构保证金' }).last();
  if (await used.count()) {
    await used.click();
    await page.waitForTimeout(800);
    if (await page.locator('.detail-panel').getByText('退回和转抵').count()) await shot('deposit-actions');
    else log('  这笔保证金没有退回、转抵记录');
  }
  // 没记账的票据：撤回收票，票据成“已作废”
  const note = await fin('POST', '/notes', { kind: 'receivable', partyId: party, number: 'XN-' + Date.now(), bank: '虚构银行', date: today, dueDate: today.slice(0, 8) + '28', amount: 30000, allocations: [] });
  if (note.error) fail('造票据失败：' + note.error);
  else if (await openMore('#finance-cash?tab=notes', '', note.number || '虚构银行', '撤回')) {
    await shot('source-note-withdraw');
    await withdrawWith('撤回');
    await go(page, '#finance-cash?tab=notes');
    await page.waitForTimeout(1000);
    if (!(await page.locator('.fin-table').getByText('已作废').count())) fail('撤回收票后票据没写“已作废”');
    await shot('source-note-cancelled');
  }
  // 资产处置：处置一项资产，详情里给处置凭证的入口
  const asset = ((await fin('GET', '/assets?status=active&pageSize=50')).rows || [])[0];
  const disposed = asset ? await fin('POST', '/assets/' + asset.id + '/dispose', { version: asset.version, date: today, reason: '虚构报废' }) : { error: '没有在用资产' };
  if (disposed.error) fail('处置资产失败：' + disposed.error);
  else if (await openMore('#finance-costs?tab=assets', '', asset.name, '撤回处置')) {
    await shot('source-asset-disposal');
    await cancelDialog();
  }
  // 坏账：给接着算利息的那笔应收计提一点坏账，逐笔详情里给坏账凭证的入口
  const ob = ((await fin('GET', '/obligations?kind=receivable&pageSize=200')).rows || []).find((o) => o.description === '虚构计息货款（接着算）');
  const bad = ob ? await fin('POST', '/obligations/' + ob.id + '/bad-debt', { version: ob.version, kind: 'writeoff', date: today, amount: 1000, reason: '虚构核销' }) : { error: '没找到那笔应收' };
  if (bad.error) fail('计提坏账失败：' + bad.error);
  else if (await openMore('#finance-ar', '#fin-sec-items', '手工', '撤回坏账')) {
    await shot('source-bad-debt');
    await cancelDialog();
  }
  // 费用报销：已付款的费用单，“更多”里的入口（服务端会说先撤销付款）
  if (await openMore('#finance-costs?tab=expenses', '', '', '红字冲销')) {
    await shot('source-expense');
    await cancelDialog();
  }
}

// 6 财务入过账的送货单被删：业务单据里成了“单据已删”。一张点主按钮“红字冲销”，事件处理完、结账检查不再拦；
//   另一张“更多 → 核对无误，保留凭证”，原凭证一点不动。电脑和手机宽度各看一次详情
{
  const events = (await fin('GET', '/events?pageSize=200')).rows || [];
  const deliveries = (await call('GET', '/flow?kind=delivery')) || [];
  const picked = events
    .filter((e) => e.source_kind === 'delivery' && e.voucher_id && e.date < today)
    .map((e) => ({ e, d: deliveries.find((d) => String(d.id) === String(e.source_id)) }))
    .filter((x) => x.d && x.d.status === 'confirmed')
    .slice(0, 2);
  if (picked.length < 2) fail('没有两张入过账、能删的送货单，单据已删这一段没测全');
  for (const { d } of picked) {
    const selection = { module: 'delivery', items: [{ id: d.id, version: d.version }], inventoryPolicy: 'recalculate' };
    const preview = await call('POST', '/deletions/preview', selection);
    const gone = preview.error ? preview : await call('POST', '/deletions/execute', { ...selection, requestId: crypto.randomUUID(), deletionDigest: preview.digest });
    if (gone.error) fail('删送货单 ' + d.number + ' 失败：' + gone.error);
  }
  await sync();
  const eventOf = async (id) => ((await fin('GET', '/events?pageSize=200')).rows || []).find((e) => Number(e.id) === Number(id));
  const blocked = async () => ((await fin('GET', '/closing?period=' + period)).steps || []).find((x) => x.key === 'events');
  if (picked.length === 2 && (await eventOf(picked[0].e.id))?.status !== 'source_deleted') fail('删掉入过账的送货单后事件没成“单据已删”');
  const stuck = Number((await blocked())?.count ?? 0);
  if (!stuck) fail('有单据已删的事件，结账检查却没拦');
  const open = async (number) => {
    await go(page, '#finance-ledger?tab=events');
    await page.getByLabel('单据状态').selectOption('source_deleted');
    await page.locator('.fin-table tbody tr.record-row', { hasText: number }).first().click();
    await page.locator('.detail-panel').waitFor();
  };
  if (picked.length === 2) {
    const [cut, keep] = picked;
    await open(cut.d.number);
    const panel = page.locator('.detail-panel');
    const primaries = await panel.locator('button.primary').allInnerTexts();
    if (primaries.length !== 1 || primaries[0].trim() !== '红字冲销') fail('单据已删的详情主按钮不是唯一的“红字冲销”：' + primaries.join('、'));
    if (/[a-z]{4,}_[a-z]+/.test(await panel.innerText())) fail('单据已删的详情露出英文：' + (await panel.innerText()).match(/[a-z]{4,}_[a-z]+/)[0]);
    await shot('deleted-source-panel');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('deleted-source-panel-phone');
    await page.setViewportSize({ width: 1440, height: 900 });
    await panel.getByRole('button', { name: '红字冲销', exact: true }).click();
    const box = dlg();
    if (!(await box.innerText()).includes('不再重做')) fail('单据已删的红字冲销窗没说“不再重做”');
    await box.locator('textarea').first().fill('虚构：送货单录重了，已删');
    await box.getByRole('button', { name: '确认红字冲销', exact: true }).click();
    await box.waitFor({ state: 'detached', timeout: 8000 });
    await postAll();
    const after = await eventOf(cut.e.id);
    if (after?.status === 'source_deleted') fail('点了红字冲销，事件还是单据已删');
    else log('单据已删点红字冲销 ok', after?.status);
    // 保留：凭证表头和分录都不动
    // 凭证本身：表头的日期、摘要、状态和全部分录（读出来的附带说明不算）
    const voucherOf = async () => {
      const v = await fin('GET', '/vouchers/' + keep.e.voucher_id);
      return JSON.stringify([v.header?.date, v.header?.description, v.header?.status, v.entries]);
    };
    const before = await voucherOf();
    await open(keep.d.number);
    await page.locator('.detail-panel .more-menu summary').first().click();
    await page.getByRole('menuitem', { name: '核对无误，保留凭证', exact: true }).click();
    await dlg().locator('textarea').first().fill('虚构：库存流水保留了，收入是真的');
    await shot('deleted-source-keep');
    await dlg().getByRole('button', { name: '核对无误', exact: true }).click();
    await dlg().waitFor({ state: 'detached', timeout: 8000 });
    const kept = await eventOf(keep.e.id);
    if (kept?.status === 'source_deleted') fail('核对无误保留凭证后事件还是单据已删');
    else if ((await voucherOf()) !== before) fail('保留凭证后凭证变了：' + before.slice(0, 160) + ' → ' + (await voucherOf()).slice(0, 160));
    else log('单据已删核对无误、保留凭证 ok', kept?.status);
    const left = Number((await blocked())?.count ?? 0);
    if (left !== stuck - 2) fail('两张单据已删都处理了，结账检查拦着的应少 2 张：' + stuck + ' → ' + left);
  }
}

checkConsole(consoleErrors);
await context.close();
