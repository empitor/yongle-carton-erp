// 已生效单据的更正和编辑（和 flow-operations.mjs 同一组，接着用同一个实例）：送货出库后更正数量、库存发光后再更正、
// 完工的货已发出一部分时撤销被拒而更正能办、详情“编辑”只改说明且详情不关、数据管理里的“编辑”和“更多 → 更正送货单”。
// 本机管理员（带超级管理员模式）。全部虚构数据。
import { BASE, SP, login, notice, openChrome } from './lib.mjs';
const fail = (message) => console.log('ERR: ' + message);
const ok = (message) => console.log('ok ' + message);
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
const dialog = () => page.locator('[role="dialog"][aria-modal="true"]').last();
let shots = 0;
const shot = (label) => page.screenshot({ path: `${SP}/c${String(++shots).padStart(2, '0')}-${label}.png` });
const api = (path) => page.evaluate(async (p) => (await fetch(p)).json(), path);
/** 带登录凭证发 POST；status 是服务端的状态码（不抛错，由调用处判断） */
const post = (path, body) =>
  page.evaluate(
    async ([p, b]) => {
      const { csrf } = await (await fetch('/api/auth/state')).json();
      const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': csrf }, body: JSON.stringify(b) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    [path, body],
  );
const panel = () => page.locator('.detail-panel');
const action = async (name) => {
  const direct = panel().getByRole('button', { name, exact: true });
  if (await direct.count()) return direct.first().click();
  await panel().locator('summary', { hasText: '更多' }).first().click();
  await panel().locator('details[open]').getByRole('menuitem', { name, exact: true }).or(panel().locator('details[open] button', { hasText: name })).first().click();
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    fail(name + ' 中途出错：' + String(e.message).split('\n')[0]);
    await shot('出错-' + name).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  }
};
const items = () => api('/api/warehouse/items');
const balance = async (id) => Number((await items()).find((i) => i.id === id)?.balanceUnits ?? NaN) / 1000;
const deliveries = () => api('/api/flow?kind=delivery');
const live = (d) => d.status === 'confirmed' && !d.replacedBy && !d.archived;
const openDelivery = async (id) => {
  await page.goto(BASE + '#warehouse?kind=finished&deliveries=1&doc=' + id);
  await panel().waitFor();
};
/** 在更正窗里改第 n 个“正确数量”、写原因，等核验完再提交；返回提交后的页面提示 */
const submitCorrection = async (index, value, reason, label) => {
  await dialog().waitFor();
  // 送货是“产品名正确数量”，完工是“正确合格数量”“正确报废数量”
  await dialog().locator('input[aria-label*="正确"]').nth(index).fill(String(value));
  await dialog().getByLabel('更正原因').fill(reason);
  const submit = dialog().getByRole('button', { name: '提交更正' });
  for (let i = 0; i < 80 && (await submit.isDisabled()); i++) await page.waitForTimeout(100);
  if (await submit.isDisabled()) {
    await shot(label + '-没核验出来');
    throw new Error('核验没通过：' + (await dialog().innerText()).replace(/\s+/g, ' ').slice(0, 200));
  }
  await dialog().locator('[aria-label="更正影响"]').waitFor();
  await shot(label);
  await submit.click();
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  return notice(page, /已更正为/);
};
await login(page);

let corrected = null;
await step('送货出库后更正数量', async () => {
  const target = (await deliveries()).find((d) => live(d) && d.shippedAt && Number(d.lines[0].quantity) >= 2);
  if (!target) return fail('没有能更正的已出库送货单');
  const stockId = target.lines[0].stockId,
    was = Number(target.lines[0].quantity),
    before = await balance(stockId);
  await openDelivery(target.id);
  await action('更正送货单');
  const said = await submitCorrection(0, was - 1, '虚构少送 1 只', '更正送货单');
  const after = await api('/api/flow/' + target.id);
  const replacement = (await deliveries()).find((d) => d.correctionOf === target.id);
  if (after.status !== 'reversed' || !after.replacedBy || !replacement) return fail('更正后原单没有标成被替代、或没有替代单');
  if ((await balance(stockId)) !== before + 1) fail('少送 1 只更正后库存没加回 1：' + before + ' → ' + (await balance(stockId)));
  else ok('送货单 ' + target.number + ' 更正为 ' + replacement.number + '：' + said);
  // 详情留着，原单写“已更正为 ××”
  await page.waitForTimeout(600);
  if (!(await panel().count())) fail('更正办完后详情跟着关了');
  else if (!/已更正为/.test(await panel().innerText())) fail('原单详情没写“已更正为 ××”');
  await openDelivery(replacement.id);
  if (!/更正自/.test(await panel().innerText())) fail('替代单详情没写“更正自 ××”');
  await shot('替代单详情');
  corrected = replacement;
});

await step('库存发光后再更正', async () => {
  if (!corrected) return fail('上一步没有替代单');
  const stockId = corrected.lines[0].stockId,
    item = (await items()).find((i) => i.id === stockId);
  const zero = await post('/api/warehouse/items/' + stockId + '/move', {
    expectedVersion: item.version,
    requestId: crypto.randomUUID(),
    action: 'adjust',
    quantity: '0',
    date: corrected.date,
    notes: '虚构盘点：全部发光',
    customerOrderId: null,
    acknowledged: true,
  });
  if (zero.status !== 200 || (await balance(stockId)) !== 0) return fail('没能把库存盘成 0：' + JSON.stringify(zero.body).slice(0, 120));
  await openDelivery(corrected.id);
  await action('更正送货单');
  const was = Number(corrected.lines[0].quantity);
  const said = await submitCorrection(0, was - 1, '虚构又少送 1 只', '库存为 0 时更正');
  if ((await balance(stockId)) !== 1) fail('库存为 0 时少送 1 只，更正后应剩 1：' + (await balance(stockId)));
  else ok('库存发光后也能更正：' + said);
});

await step('完工发出一部分后更正', async () => {
  const [productions, all] = await Promise.all([api('/api/flow?kind=production'), items()]);
  // 成品现有的比这次完工少（发出去了一部分），但还有：撤销整批扣不回，更正少 1 只能办
  const target = productions
    .filter((p) => live(p) && p.taskId)
    .map((p) => ({ p, stock: all.find((i) => i.id === p.finishedStockId) }))
    .find(({ p, stock }) => stock && stock.balanceUnits >= 1000 && stock.balanceUnits < Number(p.goodQuantity) * 1000);
  if (!target) return fail('没有已发出一部分的完工单');
  const { p } = target,
    before = await balance(p.finishedStockId);
  const undo = await post('/api/flow/' + p.id + '/reverse', { version: p.version, reason: '虚构试撤销', acknowledged: true });
  if (undo.status < 400) return fail('成品已发出一部分，撤销这次完工却办成了');
  await page.goto(BASE + '#production?view=production&doc=' + p.id);
  await panel().waitFor();
  await action('更正完工单');
  const said = await submitCorrection(0, Number(p.goodQuantity) - 1, '虚构合格多登了 1 只', '更正完工单');
  if ((await balance(p.finishedStockId)) !== before - 1) fail('合格少 1 只，成品库存应少 1：' + before + ' → ' + (await balance(p.finishedStockId)));
  else ok('撤销被拒（' + String(undo.body.message || undo.status).slice(0, 40) + '），更正能办：' + said);
});

await step('详情的编辑只改说明', async () => {
  const target = (await deliveries()).find((d) => live(d) && d.shippedAt);
  await openDelivery(target.id);
  await action('编辑');
  await dialog().waitFor();
  const text = '虚构改送货备注 ' + Date.now();
  await dialog().getByLabel('备注', { exact: true }).fill(text);
  await shot('送货单编辑');
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  const said = await notice(page, /已保存/);
  await page.waitForTimeout(600);
  const after = await api('/api/flow/' + target.id);
  if (!(await panel().count())) fail('编辑保存后详情跟着关了');
  else if (after.notes !== text || after.replacedBy) fail('编辑后备注没改上，或出了替代单');
  else if (!(await panel().innerText()).includes(text)) fail('详情没显示新备注');
  else ok('送货单只改备注：' + said);
});

await step('数据管理里的编辑和更正', async () => {
  await page.goto(BASE);
  await page.locator('.oi-account').click();
  await page.locator('.account-menu').getByRole('menuitem', { name: '数据管理' }).click();
  await dialog().getByRole('heading', { name: '业务数据管理' }).waitFor();
  await dialog().getByLabel('数据管理业务模块').selectOption('delivery');
  await page.waitForTimeout(800);
  const row = dialog().locator('tbody tr', { hasText: /送货中|已送达/ }).first();
  const number = (await row.locator('strong').first().innerText()).trim();
  // 已撤销、已更正的送货单不出“编辑”
  const dead = dialog().locator('tbody tr', { hasText: /已撤销|已更正/ }).first();
  if ((await dead.count()) && (await dead.getByRole('button', { name: '编辑', exact: true }).count()))
    fail('已撤销、已更正的送货单在数据管理里还有“编辑”');
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await dialog().getByLabel('收货联系人').waitFor();
  if (await dialog().getByLabel(/数量/).count()) fail('数据管理的“编辑”里还能改数量');
  await shot('数据管理编辑送货单');
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await page.waitForTimeout(300);
  await row.locator('summary').click();
  await page.getByRole('menuitem', { name: '更正送货单' }).click();
  await dialog().getByRole('heading', { name: '更正送货单' }).waitFor();
  // 单号要等这张单读出来才显示，机器慢时标题先到
  const shown = await dialog().getByText(number).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
  if (!shown) fail('数据管理打开的更正窗不是这张送货单：' + number);
  else ok('数据管理里“编辑”只改说明，“更多 → 更正送货单”打开同一个更正窗');
  await shot('数据管理更正送货单');
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
});

const real = [...new Set(consoleErrors)].filter((e) => !/status of (403|409)/.test(e));
if (real.length) fail('控制台报错：' + real.join(' | ').slice(0, 300));
await context.close();
