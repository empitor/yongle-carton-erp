// 接着 flow-basics 的状态：关审核分离、补税、生成凭证、在凭证页点“提交 / 审核 / 记账本页”（全组只在这里点一遍）、
// 收款核销再打开撤销窗，最后查财务界面的几处叫法和写法。
import { checkConsole, go, login, openChrome } from './lib.mjs';
import { financeKit, shotsDir as out } from './finance-kit.mjs';
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
await login(page);
const postAllByApi = financeKit(page).postAll;
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
// 直接写账的批量动作都先弹确认窗：点确认窗里的主按钮
const confirmDialog = async () => {
  await page.waitForTimeout(300);
  await dlg().locator('button.primary, button.danger-solid').last().click();
  await page.waitForTimeout(1200);
};
const postAll = async () => {
  await go(page, '#finance-ledger?tab=vouchers');
  await page.waitForTimeout(600);
  for (const label of [/^提交本页/, /^审核本页/, /^记账本页/]) {
    const b = page.getByRole('button', { name: label });
    if (await b.count()) {
      await b.click();
      await confirmDialog();
    } else log('ERR: 凭证页没有按钮 ' + String(label));
  }
};

// A 关掉审核分离（一个人用的时候必须关）
await go(page, '#finance-settings');
await page.getByRole('button', { name: '编辑设置', exact: true }).click();
await page.waitForTimeout(300);
await field('制单和审核必须不同人').locator('input').uncheck();
await dlg().getByRole('button', { name: '保存设置', exact: true }).click();
await close();
await shot('settings-saved');

// B 批量补税
await go(page, '#finance-flow?missing=1');
await page.waitForTimeout(800);
await shot('flow-missing');
await page.getByLabel('全选本页待补税率的单据').check();
await page.locator('.selection-bar').getByRole('button', { name: '补税率', exact: true }).click();
await page.waitForTimeout(300);
await field('税率 %').locator('input').fill('13');
await field('口径').locator('select').selectOption('未税');
await shot('batch-dialog');
await dlg().getByRole('button', { name: '保存税率', exact: true }).click();
await close();
await shot('flow-after-batch');

// C 生成凭证并记账
await go(page, '#finance-ledger?tab=events');
await page.waitForTimeout(800);
await shot('events-ready');
const gen = page.getByRole('button', { name: /^生成凭证（/ });
if (await gen.count()) {
  await gen.click();
  await confirmDialog();
}
await shot('events-generated');
await go(page, '#finance-ledger?tab=vouchers');
await page.waitForTimeout(600);
await shot('vouchers-draft');
await postAll();
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
await dlg().getByRole('button', { name: '保存收付款', exact: true }).click();
await close();
await page.locator('.detail-panel').getByRole('button', { name: '确认', exact: true }).click();
await page.waitForTimeout(800);
await shot('allocate-with-lines');
await dlg().getByRole('button', { name: '确认', exact: true }).click();
await close();
await shot('confirmed-with-allocation');
await postAllByApi();
await go(page, '#finance-cash?tab=documents');
await page.waitForTimeout(500);
await page.locator('.fin-table tbody tr.record-row').first().click();
await page.waitForTimeout(500);
// 撤销是危险操作，在详情的“更多”里
await page.locator('.detail-panel .more-menu summary').first().click();
await page.getByRole('menuitem', { name: '撤销', exact: true }).click();
await page.waitForTimeout(300);
await shot('cancel-or-revoke');
// 上面打开的撤销窗只截图，不提交：关掉
if (await page.locator('[role="dialog"][aria-modal="true"]').count())
  await dlg().getByRole('button', { name: '取消', exact: true }).click().catch(() => page.keyboard.press('Escape'));
await page.waitForTimeout(300);

// E 财务界面的叫法、写法
const fail = (message) => log('ERR: ' + message);

// E2 账期统一叫“没有账期”：按单位一块（页顶、列名、账期列）、账期页签、账期设置窗的选项
{
  await go(page, '#finance-ar');
  await page.locator('#fin-sec-held .fin-table').first().waitFor({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  const heldText = await page.locator('#fin-sec-held').innerText();
  // 页顶合计和列名都写“没有账期”（说明小字里也有这几个字，所以分开看表头）
  const heldHead = await page.locator('#fin-sec-held thead').first().innerText();
  if (!heldHead.includes('没有账期')) fail('按单位的列名不是“没有账期”：' + heldHead.replace(/\s+/g, ' '));
  if (!(await page.locator('#fin-sec-held').getByText('没有账期', { exact: true }).count()))
    fail('按单位页顶合计没有“没有账期”');
  if (heldText.includes('没有约定')) fail('按单位一块还有“没有约定”的写法');
  await shot('held-no-terms-name');
  await go(page, '#finance-ar?tab=terms');
  await page.waitForTimeout(800);
  if ((await page.locator('main').innerText()).includes('没有约定')) fail('账期页签还有“没有约定”的写法');
  await page.getByRole('button', { name: '新建客户账期' }).click();
  await page.waitForTimeout(600);
  const none = (await dlg().locator('option[value="none"]').first().textContent()) || '';
  if (none.trim() !== '没有账期（到期日留空）') fail('账期设置窗“没有账期”选项写成了：' + none);
  await dlg().getByRole('button', { name: '取消', exact: true }).click();
  await page.waitForTimeout(300);
  log('没有账期叫法 ok');
}

// E3 账龄按到期日算：没到期的写“未到期”，不写“-10 天”
{
  await go(page, '#finance-ar?tab=aging');
  await page.waitForTimeout(800);
  await page.getByLabel('账龄起算').selectOption('due');
  await page.waitForTimeout(1000);
  // 说明小字里本来就有“未到期”几个字，只看表格
  const agingText = await page.locator('#fin-sec-aging table').first().innerText();
  if (/-\d+ 天/.test(agingText)) fail('账龄按到期日算还有负天数：' + agingText.match(/-\d+ 天/)[0]);
  const notDue = ((await api('/aging?kind=receivable&basis=due&pageSize=50')).rows || []).filter((r) => Number(r.days) < 0);
  if (notDue.length && !agingText.includes('未到期')) fail('有 ' + notDue.length + ' 笔没到期，账龄一栏却没写“未到期”');
  const agingNote = await page.locator('#fin-sec-aging .fin-note').first().innerText();
  if (!agingNote.includes('没有账期的单子单独一档')) fail('账龄口径小字没写没有账期的单子单独一档');
  await shot('aging-by-due');
  log('账龄未到期 ok', notDue.length);
}

// E4 订单详情的“财务”一段：日期一格不折行（状态一格多了“重记”这类标签也不挤它）
{
  const orders = await page.evaluate(async () => (await fetch('/api/orders')).json());
  let checked = false;
  for (const o of (Array.isArray(orders) ? orders : []).slice(0, 30)) {
    const related = await api('/related/orders/' + o.id);
    if (!(related.rows || []).some((r) => r.obligation_id != null)) continue;
    await go(page, '#orders?order=' + o.id);
    const cell = page.locator('section.record-section:has(> header a[href="#finance-ar"]) td.nowrap').first();
    if (!(await cell.waitFor({ timeout: 5000 }).then(() => true, () => false))) {
      fail('订单 ' + o.number + ' 详情的财务一段没有日期格（td.nowrap）');
      break;
    }
    const box = await cell.evaluate((td) => {
      const style = getComputedStyle(td);
      const range = document.createRange();
      range.selectNodeContents(td);
      return { whiteSpace: style.whiteSpace, lines: range.getClientRects().length, text: td.textContent };
    });
    if (box.whiteSpace !== 'nowrap' || box.lines > 1) fail('订单详情财务一段的日期折行了：' + JSON.stringify(box));
    await cell.scrollIntoViewIfNeeded();
    await shot('order-finance-date');
    log('详情财务段日期不折行 ok', box.text);
    checked = true;
    break;
  }
  if (!checked) fail('没找到有应收的订单，没查到详情财务段的日期');
}

// E5 时间写法全站一致（北京时间“年/月/日 时:分:秒”）：财务修改记录、流水详情的记录时间、收件箱详情的收到时间；时间一格不折行
{
  const full = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/;
  const oneLine = (loc) => loc.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects().length <= 1;
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width > 900 ? 900 : 844 });
    await go(page, '#finance-ledger?tab=audit');
    const cells = page.locator('main table tbody tr td:first-child');
    await cells.first().waitFor();
    const times = await cells.allInnerTexts();
    const bad = times.filter((t) => !full.test(t.trim()));
    if (bad.length) fail(width + ' 宽财务修改记录的时间写法不一：' + bad.slice(0, 3).join('、'));
    if (!(await oneLine(cells.first()))) fail(width + ' 宽财务修改记录的时间折行了');
    await shot('audit-times-' + width);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const elsewhere = [];
  for (const [hash, term] of [['#warehouse?flow=1', '记录时间'], ['#inbox', '收到时间']]) {
    await go(page, hash);
    await page.locator('main tbody tr').first().locator('button, td').first().click();
    const value = page.locator('.detail-panel dt', { hasText: term }).locator('xpath=following-sibling::dd[1]');
    const text = (await value.innerText({ timeout: 5000 }).catch(() => '')).trim();
    elsewhere.push(term + ' ' + text);
    if (!full.test(text)) fail(hash + ' 详情的“' + term + '”写法和财务修改记录不一样：' + text);
    await page.keyboard.press('Escape');
  }
  log('时间写法一致 ok', elsewhere.join('；'));
}

await context.close().catch(() => {});
checkConsole(consoleErrors);
