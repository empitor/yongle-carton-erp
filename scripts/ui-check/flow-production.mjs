// 产品、库存和订单的日常操作：附属品挂在主产品下面、“筛选”弹层按客户筛、
// 订单明细的单位固定是“只”、订单编辑窗读失败后的“重试”、从订单和从产品“安排生产”、今日分组（含规格对不上的订单）。
// 完工批次在 flow-batches.mjs（同一组）。
import { BASE, SP, businessDay, call, fail, login, ok, openChrome, step as stepOn } from './lib.mjs';
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
const dialog = () => page.locator('[role="dialog"][aria-modal="true"]').last();
let shots = 0;
const shot = (label) => page.screenshot({ path: `${SP}/p${String(++shots).padStart(2, '0')}-${label}.png` });
const open = async (hash) => {
  await page.goto(BASE + hash);
  await page.locator('main tbody tr').first().waitFor();
};
const api = (path) => page.evaluate(async (p) => (await fetch(p)).json(), path);
// 列表里树形的名称列：附属品前面带“├ / └”
const treeNames = () =>
  page.locator('main tbody tr td.record-tree-cell').evaluateAll((cells) =>
    cells.map((c) => (c.querySelector('.record-tree-branch') ? (c.querySelector('.is-last') ? '└ ' : '├ ') : '') + c.textContent.trim()),
  );
const step = (name, fn) => stepOn(page, name, fn);
const filterPanel = () => page.getByRole('dialog', { name: '筛选条件' });
const scrollPage = async () => {
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(100);
};
await login(page);

await step('附属品', async () => {
  await open('#products');
  await page.locator('tbody tr', { hasText: '五金配件箱 小' }).first().click();
  await page.locator('.detail-panel').getByRole('button', { name: '编辑', exact: true }).click();
  await dialog().waitFor();
  const combo = dialog().getByRole('combobox', { name: '附属于哪个产品' }).first();
  await combo.click();
  await combo.fill('五金配件箱 大');
  await page.getByRole('option', { name: /五金配件箱 大/ }).first().click();
  await dialog().getByRole('button', { name: '保存产品' }).click();
  await dialog().waitFor({ state: 'detached' });
  await page.waitForTimeout(600);
  const names = await treeNames();
  const big = names.indexOf('五金配件箱 大');
  if (big < 0 || !/^[├└] 五金配件箱 小/.test(names[big + 1] || ''))
    fail('产品列表里“五金配件箱 小”没有挂在“五金配件箱 大”下面：' + names.join(' | '));
  else ok('产品列表附属品挂在主产品下面');
  await shot('产品附属品');
  const product = (await api('/api/products')).find((p) => p.name === '五金配件箱 大');
  await open('#products?record=' + product.id);
  await page.locator('.detail-panel .record-family-list li').first().waitFor({ timeout: 5000 }).catch(() => {});
  const children = await page.locator('.detail-panel .record-family-list li').allInnerTexts();
  if (!children.some((t) => t.includes('五金配件箱 小'))) fail('“五金配件箱 大”详情里没有列出附属品：' + children.join(' | '));
  await open('#warehouse?kind=finished');
  const stock = await treeNames();
  const at = stock.findIndex((t) => t.startsWith('五金配件箱 大'));
  if (at < 0 || !/^[├└] 五金配件箱 小/.test(stock[at + 1] || '')) fail('成品库存里附属品没有挂在主产品下面：' + stock.join(' | '));
  else if (!stock[at].includes('虚构海曙五金制品厂')) fail('成品库存产品名后没有带出所属客户名：' + stock[at]);
  else ok('成品库存附属品挂在主产品下面并带出所属客户名');
});

await step('筛选', async () => {
  for (const [hash, label] of [
    ['#products', '筛选客户'],
    ['#warehouse?kind=finished', '筛选客户'],
  ]) {
    await open(hash);
    const before = await page.locator('main tbody tr').count();
    await page.locator('main .filter-popover-toggle').click();
    const select = page.getByRole('dialog', { name: '筛选条件' }).getByLabel(label);
    await select.selectOption({ label: '虚构明远食品有限公司' });
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    const after = await page.locator('main tbody tr').count();
    const toggle = (await page.locator('main .filter-popover-toggle').innerText()).trim();
    if (toggle !== '筛选 1') fail(hash + ' 选了客户后“筛选”按钮没显示条件数：' + toggle);
    if (!(after > 0 && after < before)) fail(hash + ' 按客户筛选后行数不对：' + before + ' → ' + after);
    else ok(hash + ' 按客户筛选 ' + before + ' → ' + after + ' 行');
    await page.locator('main .filter-popover-toggle').click();
    await page.getByRole('dialog', { name: '筛选条件' }).getByRole('button', { name: '清除筛选' }).click();
    await page.waitForTimeout(600);
    if ((await page.locator('main tbody tr').count()) !== before) fail(hash + ' 清除筛选后没有回到原来的行数');
    await page.locator('main .filter-popover-toggle').click();
    await filterPanel().waitFor();
    // 焦点在弹层里的控件上时（手机上键盘弹出会顶得页面滚动）滚动不收起；焦点移出后滚动才收起
    await filterPanel().getByLabel(label).focus();
    await scrollPage();
    if (!(await filterPanel().count())) fail(hash + ' 焦点还在弹层里，页面滚动一下就把筛选弹层收起了');
    await page.locator('main .filter-popover-toggle').focus();
    await scrollPage();
    if (await filterPanel().count()) fail(hash + ' 滚动列表或页面后筛选弹层没有自动收起');
  }
});

// 种子里最后一张已确认、还没排产的订单
const pending = (await api('/api/orders'))
  .filter((o) => o.status === '已确认')
  .sort((a, b) => a.orderDate.localeCompare(b.orderDate) || a.id - b.id)
  .at(-1);
const openOrder = async () => {
  await open('#orders?scope=all');
  await page.locator('tbody tr', { hasText: pending.number }).first().click();
  await page.locator('.detail-panel [role="table"][aria-label="订单明细"]').waitFor();
};

await step('订单编辑窗明细', async () => {
  await openOrder();
  await page.locator('.detail-panel').getByRole('button', { name: '编辑', exact: true }).first().click();
  await dialog().waitFor();
  const title = await dialog().getByText('订单明细', { exact: true }).count();
  const fixed = await dialog().locator('.unit-fixed').allInnerTexts();
  if (!title) fail('订单编辑窗里明细区的名字不是“订单明细”');
  if (!fixed.length || fixed.some((u) => u.trim() !== '只')) fail('订单编辑窗的单位应固定为“只”：' + JSON.stringify(fixed));
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached' }).catch(() => {});
});

// 编辑已有订单时先读“只在这张订单里的产品”（换客户要用）；第一次故意回 500，点“重试”后按钮马上变成不可点的
// “正在重试…”（人看得出点上了），第二次读到以后红字和按钮都消失（src/editors/order-customer-change.ts 的 soleRetryButton）
await step('订单编辑窗读失败后重试', async () => {
  const errorsBefore = consoleErrors.length;
  let calls = 0,
    release;
  const held = new Promise((r) => (release = r));
  await page.route('**/api/orders/*/sole-products', async (route) => {
    if (++calls === 1)
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: '虚构：服务器出错' }) });
    await held;
    await route.continue();
  });
  try {
    await openOrder();
    await page.locator('.detail-panel').getByRole('button', { name: '编辑', exact: true }).first().click();
    await dialog().waitFor();
    const retry = dialog().locator('.form-message', { hasText: '没读到这张订单里哪些产品' }).getByRole('button');
    await retry.waitFor({ timeout: 8000 });
    if ((await retry.innerText()).trim() !== '重试' || (await retry.isDisabled())) fail('读失败后按钮不是可点的“重试”');
    await retry.click();
    await page.waitForTimeout(300);
    const label = (await retry.innerText()).trim(),
      disabled = await retry.isDisabled();
    await shot('订单编辑窗正在重试');
    release();
    await retry.waitFor({ state: 'detached', timeout: 8000 });
    if (label !== '正在重试…' || !disabled) fail('点了“重试”、还没读完时按钮应是不可点的“正在重试…”，实际：' + label + (disabled ? '（不可点）' : '（可点）'));
    else if (calls !== 2) fail('点“重试”应再读一次，实际读了 ' + calls + ' 次');
    else ok('订单编辑窗读失败：点“重试”后显示“正在重试…”不可点，读到后红字消失');
  } finally {
    release();
    await page.unroute('**/api/orders/*/sole-products');
    // 故意回的 500 不算控制台报错
    consoleErrors.splice(errorsBefore, consoleErrors.length - errorsBefore, ...consoleErrors.slice(errorsBefore).filter((e) => !/status of 500/.test(e)));
    await page.keyboard.press('Escape');
    await dialog().waitFor({ state: 'detached' }).catch(() => {});
  }
});

const arrange = async (where, quantities = {}) => {
  await dialog().waitFor();
  for (const [name, quantity] of Object.entries(quantities))
    await dialog().getByLabel(name + ' 本次生产数量').fill(quantity);
  const submit = dialog().getByRole('button', { name: /^安排生产（\d+ 张）$/ });
  await submit.waitFor();
  if (await dialog().getByText(/没有单位|单位待确认/).count()) fail(where + '安排生产窗口里还在提单位：' + (await dialog().innerText()).slice(0, 200));
  await page.waitForTimeout(300);
  await shot(where + '安排生产');
  await submit.click();
  await dialog().waitFor({ state: 'detached' });
  const toast = (await page.locator('.toast').allInnerTexts()).join(' | ');
  if (!/生产任务|安排/.test(toast)) fail(where + '安排生产后页面没提示结果：' + toast);
  else ok(where + '安排生产：' + toast);
};

await step('订单安排生产', async () => {
  await openOrder();
  const panel = page.locator('.detail-panel');
  const direct = panel.getByRole('button', { name: '安排生产', exact: true });
  if (await direct.count()) await direct.first().click();
  else {
    await panel.locator('summary', { hasText: '更多' }).first().click();
    await panel.locator('details[open] button', { hasText: '安排生产' }).first().click();
  }
  await arrange('订单');
});

await step('产品安排生产', async () => {
  await open('#products');
  await page.getByRole('checkbox', { name: '选择 水壶外箱' }).check();
  await page.getByRole('checkbox', { name: '选择 吹风机彩箱' }).check();
  const bar = page.getByRole('region', { name: '已选记录的操作' });
  await bar.getByRole('button', { name: '安排生产（2 种）' }).click();
  await arrange('产品', { 水壶外箱: '300', 吹风机彩箱: '500' });
});

// 今日：每张订单只在一组里，放在服务端算好的那一组（和订单详情同一套“下一步”）
await step('今日分组', async () => {
  await page.goto(BASE + '#dashboard');
  await page.locator('.td-group').first().waitFor();
  const today = await api('/api/business/today');
  const titles = { schedule: '待排产', complete: '待完工', ship: '可发货' };
  // 每组默认只列最急的几条，先把“全部 N 条”展开
  for (const more of await page.locator('.td-group button.td-all').all()) await more.click();
  const seen = new Map();
  for (const [group, title] of Object.entries(titles)) {
    const numbers = await page.locator(`.td-group[aria-label="${title}"] .td-no`).allInnerTexts();
    for (const n of numbers) seen.set(n, [...(seen.get(n) || []), group]);
  }
  const wrong = today.todo.filter((o) => (seen.get(o.number) || []).join() !== o.group);
  if (wrong.length) fail('今日分组和服务端给的不一致：' + wrong.map((o) => o.number + ' 应在 ' + o.group + ' 实际 ' + (seen.get(o.number) || []).join('/')).join('；'));
  else ok('今日 ' + today.todo.length + ' 张订单各在一组，和服务端一致');
  await shot('今日');
});

// 今日：明细规格和产品现在对不上的订单已经进了别的分组时，提示挂在那一行下面，不再在“要核对订单”里多列一次
// （src/records/today-groups.ts 的 specCheckOrders）。造一张两行的订单：一行照常，一行规格写错；看完取消掉
await step('今日规格对不上的订单只出现一次', async () => {
  const stock = (await api('/api/warehouse/items?kind=finished')).find((s) => s.availableUnits >= 20000 && s.length && s.width && s.dimensionUnit);
  if (!stock) throw new Error('种子里没有带尺寸、有库存的成品');
  const date = businessDay(),
    line = { productId: stock.productId, quantity: 10, unitPriceCents: 100 };
  const order = await call(page, 'POST', '/orders', { customerId: stock.customerId, orderDate: date, deliveryDate: date, status: '已确认', lines: [line, { ...line, specification: '999×999×999' }], requestId: crypto.randomUUID() });
  if (!order.id) throw new Error('无法新建规格对不上的虚构订单：' + order.error);
  const placed = (await api('/api/business/today')).todo.find((o) => o.id === order.id);
  if (!placed?.mismatches?.length) throw new Error('服务端没把这张订单放进分组、或没带规格提示：' + JSON.stringify(placed));
  // 上一步已停在 #dashboard，接口建的订单页面不知道，整页刷新再读
  await page.goto(BASE + '#dashboard');
  await page.reload();
  await page.locator('.td-group').first().waitFor();
  for (const more of await page.locator('.td-group button.td-all').all()) await more.click();
  const rows = page.locator('.td-group .td-row', { has: page.locator('.td-no', { hasText: order.number }) });
  const count = await rows.count(),
    hint = count ? await rows.first().locator('.record-hint').allInnerTexts() : [];
  await shot('今日规格对不上');
  if (count !== 1) fail('规格对不上的订单 ' + order.number + ' 在今日页出现了 ' + count + ' 次（应只在“' + placed.group + '”那一组）');
  else if (!hint.join().includes('规格和产品现在的不一样')) fail('规格对不上的提示没挂在那一行下面：' + hint.join(' | '));
  else ok('规格对不上的订单只在一组里出现一次，提示挂在那一行下面');
  const cancelled = await call(page, 'POST', '/orders/' + order.id + '/cancel', { expectedVersion: order.version, requestId: crypto.randomUUID(), reason: '虚构：看完今日分组' });
  if (cancelled.error) fail('取消看完的虚构订单失败：' + cancelled.error);
});

// 今日“经营概况”的统计日期（和列表筛选同一个日期件）：换范围后订单总数跟着变，和服务端按同样日期算的一致
await step('经营概况统计日期', async () => {
  await page.goto(BASE + '#dashboard');
  await page.getByRole('tab', { name: '经营概况' }).click();
  const range = page.getByLabel('统计日期范围');
  await range.waitFor();
  const total = page.getByRole('link', { name: /^订单总数/ }).locator('strong');
  /** 页面上的订单总数，和“查看订单”带的日期让服务端算的总数 */
  const read = async () => {
    const href = (await page.getByRole('link', { name: /^订单总数/ }).getAttribute('href')) || '';
    const q = new URLSearchParams(href.split('?')[1] || '');
    const query = new URLSearchParams({ withMetrics: '1' });
    if (q.get('range') === 'custom') for (const k of ['start', 'end']) if (q.get(k)) query.set(k, q.get(k));
    // 订单总数含待确认和已取消：按状态分的张数加起来
    const byStatus = (await api('/api/dashboard?' + query)).byStatus || [];
    return { shown: Number(await total.innerText()), server: byStatus.reduce((n, x) => n + Number(x.count), 0) };
  };
  const two = await read();
  await shot('经营概况-最近两个月');
  await range.selectOption('all');
  await page.waitForFunction((n) => {
    const el = [...document.querySelectorAll('main a')].find((a) => a.textContent.startsWith('订单总数'));
    return el && Number(el.querySelector('strong')?.textContent) !== n;
  }, two.shown, { timeout: 8000 }).catch(() => {});
  const all = await read();
  await shot('经营概况-全部日期');
  await page.setViewportSize({ width: 390, height: 844 });
  const bar = page.locator('main .filter-bar').first();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  await page.waitForTimeout(500); // 换宽度后侧栏收起有动画，等它放完再截图
  await shot('经营概况-手机');
  await page.setViewportSize({ width: 1440, height: 900 });
  if (two.shown !== two.server || all.shown !== all.server) fail('统计日期下的订单总数和服务端不一致：' + JSON.stringify({ two, all }));
  else if (all.shown <= two.shown) fail('换成全部日期后订单总数没变多：' + two.shown + ' → ' + all.shown);
  else if (wide || !(await bar.count())) fail('手机宽度下统计日期一栏超出屏幕或不见了');
  else ok('经营概况统计日期：最近两个月 ' + two.shown + ' 张 → 全部日期 ' + all.shown + ' 张，和服务端一致');
});

// 到货页默认只读待处理和最近 90 天，“显示更早的记录”读全部
await step('到货只读最近', async () => {
  await open('#warehouse?arrivals=1');
  const note = page.locator('.record-recent-note');
  await note.waitFor();
  if (!/最近|以后的到货记录/.test(await note.innerText())) fail('到货页没说只列了最近的记录');
  await note.getByRole('button', { name: '显示更早的记录' }).click();
  await note.waitFor({ state: 'detached', timeout: 5000 });
  ok('到货页“显示更早的记录”读了全部');
});

// 地址是人能手改的：不认识的订单状态、客户编号、日期当作没筛选，不能冒出服务端的英文校验报错
await step('地址里乱写的筛选', async () => {
  // 每个地址从新页面打开，等订单列表读完，避开上一组的行和首次加载的占位行。
  const openAddress = async (hash) => {
    await page.goto('about:blank');
    await page.goto(BASE + hash);
    await page.getByRole('button', { name: '新建订单', exact: true }).and(page.locator('button:enabled')).waitFor();
  };
  const toggle = async () => (await page.locator('main .filter-popover-toggle').innerText()).trim();
  const rows = () => page.locator('main tbody tr').count();
  await openAddress('#orders?scope=all');
  const all = await rows();
  // 先看一个认识的状态：按钮写“筛选 1”，下面“只写筛选”的判断才说明问题
  await openAddress('#orders?scope=all&status=已确认');
  if ((await toggle()) !== '筛选 1') fail('status=已确认 的筛选按钮应写“筛选 1”：' + (await toggle()));
  // 状态下拉在“筛选”弹层里；带上了条件时按钮写“筛选 N”，当作没筛选就只写“筛选”、行数和不筛一样
  for (const hash of ['#orders?scope=all&status=草稿', '#orders?scope=all&status=abc&customerId=xyz']) {
    await openAddress(hash);
    const alerts = (await page.locator('[role="alert"]').allInnerTexts()).join(' | ');
    const label = await toggle();
    const count = await rows();
    if (alerts || label !== '筛选' || count !== all)
      fail(hash + ' 出了报错或带上了不认识的筛选：' + JSON.stringify({ alerts, toggle: label, rows: count, all }));
    else ok(hash + ' 当作没筛选，列出 ' + all + ' 行');
  }
  // 自定义日期两头都不认识：不报错、不按日期筛（按钮仍算“自定义日期”这一项，见交接单）
  await openAddress('#orders?scope=all&range=custom&start=bad&end=2026-13-40');
  const alerts = (await page.locator('[role="alert"]').allInnerTexts()).join(' | ');
  if (alerts || (await rows()) !== all) fail('乱写的自定义日期出了报错或按日期筛了：' + JSON.stringify({ alerts, rows: await rows(), all }));
  else ok('乱写的自定义日期不筛，列出 ' + all + ' 行');
  await shot('地址乱写的状态');
});

// 原材料概览：有纸板尺寸不全、没算进总面积时，“另有 N 种……没算进去”要真的看得见（不能只在 DOM 里）
await step('概览里没算进去的说明', async () => {
  const post = (path, body) =>
    page.evaluate(
      async ([p, b]) => {
        const { csrf } = await (await fetch('/api/auth/state')).json();
        const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': csrf }, body: JSON.stringify(b) });
        const value = await r.json();
        if (!r.ok) throw new Error(p + '：' + (value.message || r.status));
        return value;
      },
      [path, body],
    );
  const item = await post('/api/warehouse/items', { name: '虚构无尺寸纸板', kind: 'raw' });
  await post('/api/warehouse/items/' + item.id + '/move', {
    expectedVersion: item.version,
    requestId: crypto.randomUUID(),
    action: 'in',
    quantity: '30',
    date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
    notes: '虚构盘盈',
    acknowledged: true,
  });
  await open('#warehouse');
  const note = page.locator('.list-summary .list-summary-note');
  await note.first().waitFor({ state: 'visible', timeout: 5000 });
  const text = await note.first().innerText();
  if (!/另有 \d+ 种.*没算进去/.test(text)) fail('概览说明不对：' + text);
  else ok('原材料概览看得见：' + text);
  // 口径说明照旧收起，不把一排统计挤乱
  const hidden = await page.locator('.list-summary small:not(.list-summary-note)').evaluateAll((els) => els.every((e) => getComputedStyle(e).display === 'none'));
  if (!hidden) fail('概览的口径说明没收起');
  await shot('原材料概览说明');
});

// 生产任务列表 1280 宽打开右侧详情：计划日期留着（先收实际完工、产品），表格不横向滚动。
// 生产任务页默认是排产板（没有表格），下面几步用 scope=all 打开列表
await step('生产任务列表收列', async () => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open('#production?scope=all');
  await page.locator('main tbody tr.record-row').first().click();
  await page.locator('.detail-panel').waitFor();
  await page.waitForTimeout(300);
  const heads = await page.locator('main table thead th').evaluateAll((ths) =>
    ths.filter((th) => getComputedStyle(th).display !== 'none').map((th) => th.textContent.trim()),
  );
  if (!heads.includes('计划日期')) fail('1280 宽打开详情时生产任务列表没有计划日期：' + heads.join(' | '));
  const scroll = await page.locator('main .unified-table-region').first().evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  if (scroll) fail('1280 宽打开详情时生产任务列表要横向滚动');
  else ok('1280 宽打开详情时生产任务列表显示：' + heads.filter(Boolean).join(' | '));
  await shot('生产任务列表-1280-详情');
  await page.setViewportSize({ width: 1440, height: 900 });
});

// 登记完工只有一个窗口：不挂任务的完工（打样、补做）也在这个窗口里加行登记；完工记录页没有“不挂任务单独登记”
await step('不挂任务的完工', async () => {
  await open('#production?view=production');
  if (await page.locator('.page-heading summary[aria-label="完工记录的其他操作"]').count())
    fail('完工记录页还有“更多 → 不挂任务单独登记”');
  await page.locator('.page-heading').getByRole('button', { name: '登记完工', exact: true }).click();
  await dialog().waitFor();
  await dialog().getByText('不挂任务的完工', { exact: true }).first().waitFor();
  await dialog().locator('section, .ed-section').filter({ hasText: '不挂任务的完工' }).getByRole('button', { name: '加一行' }).click();
  const product = dialog().getByRole('combobox', { name: '不挂任务第 1 行产品' });
  await product.click();
  await page.getByRole('option').nth(1).click();
  await dialog().getByLabel('不挂任务第 1 行合格').fill('7');
  const max = await dialog().getByLabel('实际完工日期').getAttribute('max');
  if (!max || !/^\d{4}-\d{2}-\d{2}$/.test(max)) fail('完工日期没有限制不能晚于今天：' + max);
  await shot('不挂任务的完工');
  ok('登记完工窗口里能加不挂任务的完工，完工日期最晚 ' + max);
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached' }).catch(() => {});
});

// 登记完工窗口：领纸板的表叫“退料”；必填没填时，提示条列的是看得见的列名，不是“原料1”“领用张数1”；
// 任务的“还差”扣掉已登记、待核对入库的（任务视图带 pendingCompleted），预填的合格数就是“还差”
await step('登记完工窗口的叫法和还差', async () => {
  await open('#production?scope=all');
  const tasks = await api('/api/flow?kind=task');
  const waiting = tasks.filter((t) => t.status === 'confirmed' && Number(t.pendingCompleted || 0) > 0);
  await page.locator('.page-heading').getByRole('button', { name: '登记完工', exact: true }).click();
  await dialog().waitFor();
  const heads = await dialog().locator('thead th').allInnerTexts();
  if (!heads.some((h) => h.includes('退料'))) fail('登记完工窗口没有“退料（张）”列：' + heads.join(' | '));
  if (heads.some((h) => h.includes('退回'))) fail('登记完工窗口还写“退回”：' + heads.join(' | '));
  for (const t of waiting) {
    const row = dialog().locator('tr', { hasText: t.number });
    if (!(await row.count())) continue;
    const text = await row.innerText();
    if (!/待核对入库/.test(text)) fail(t.number + ' 有待入库的完工单，窗口里没说明：' + text);
    else ok(t.number + ' 的还差扣掉了待入库的：' + text.replace(/\s+/g, ' '));
  }
  // 勾一张任务、什么都不填就提交：提示条列出的名字
  const box = dialog().locator('input[aria-label^="选择完工任务"]').first();
  if (await box.count()) {
    await box.check();
    await dialog().getByRole('button', { name: '登记完工', exact: true }).click();
    await page.waitForTimeout(400);
    const note = (await dialog().locator('.missing-note').allInnerTexts()).join(' ');
    if (/原料\d|领用张数\d|退回张数\d/.test(note)) fail('必填提示露出内部标签：' + note);
    else ok('必填提示：' + (note || '（浏览器自带提示）'));
    await shot('登记完工-必填提示');
  }
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached' }).catch(() => {});
});

// 详情“更多”：看关联和历史的那一项叫“关联记录与修改历史”，和打开的窗口标题同一个名字
await step('关联记录与修改历史的叫法', async () => {
  await open('#production?scope=all');
  await page.locator('main tbody tr.record-row').first().click();
  await page.locator('.detail-panel').waitFor();
  const more = page.locator('.detail-panel summary').filter({ hasText: '更多' }).first();
  if (!(await more.count())) return ok('详情没有“更多”（不是本机管理员模式），跳过');
  await more.click();
  const items = await page.locator('.detail-panel [role="menuitem"]').allInnerTexts();
  if (items.some((t) => t.trim() === '修改历史')) fail('“更多”里还叫“修改历史”：' + items.join(' | '));
  const entry = page.locator('.detail-panel').getByRole('menuitem', { name: '关联记录与修改历史' });
  if (!(await entry.count())) return ok('“更多”里没有关联记录与修改历史（不是本机管理员模式）：' + items.join(' | '));
  await entry.click();
  await dialog().waitFor();
  const title = await dialog().getAttribute('aria-label');
  if (title !== '关联记录与修改历史') fail('菜单叫“关联记录与修改历史”，窗口标题却是：' + title);
  else ok('菜单和窗口同名：' + title);
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached' }).catch(() => {});
});

// 本机管理员在生产页取消、撤销：走单据自己的接口（/api/flow/:id/cancel、/reverse），不走数据管理（/api/management/execute），
// 提示说清办了什么。会真的取消一张没开工的任务（虚构数据），放在最后
await step('生产页取消走普通业务接口', async () => {
  const tasks = await api('/api/flow?kind=task');
  const target = tasks.find((t) => t.status === 'confirmed' && !t.archived && !t.hasProduction && !Number(t.completed || 0));
  if (!target) return fail('没有没开工的任务，这一步没测到');
  const hits = [];
  const listen = (req) => {
    if (req.method() === 'POST' && /\/api\/(flow\/\d+\/(cancel|reverse)|flow\/batch|management\/execute)/.test(req.url())) hits.push(new URL(req.url()).pathname);
  };
  page.on('request', listen);
  try {
    await open('#production?scope=all&doc=' + target.id);
    await page.locator('.detail-panel').waitFor();
    await page.locator('.detail-panel summary').filter({ hasText: '更多' }).first().click();
    await page.locator('.detail-panel').getByRole('menuitem', { name: '取消这张任务' }).click();
    await dialog().waitFor();
    await dialog().locator('textarea, input[type="text"]').first().fill('虚构复看：生产页取消');
    await dialog().getByRole('button', { name: /取消这张任务|确认/ }).last().click();
    await dialog().waitFor({ state: 'detached', timeout: 8000 });
    await page.waitForTimeout(300);
    const notice = (await page.locator('.toast, .success-banner, [role="status"]').allInnerTexts()).join(' | ');
    if (hits.some((p) => p.includes('/management/execute'))) fail('生产页取消还走数据管理接口：' + hits.join(', '));
    else if (!hits.some((p) => p.endsWith('/' + target.id + '/cancel'))) fail('生产页取消没走 /flow/:id/cancel：' + hits.join(', '));
    else ok('生产页取消走普通接口：' + hits.join(', '));
    if (!notice.includes('已取消 ' + target.number)) fail('取消后的提示没说清办了什么：' + notice);
    if (/操作已保存，历史和审计记录已保留/.test(notice)) fail('还在用笼统的提示：' + notice);
    const history = await api('/api/flow/' + target.id).catch(() => null);
    if (history && history.status !== 'cancelled') fail('任务没取消：' + history.status);
  } finally {
    page.off('request', listen);
  }
});

if (consoleErrors.length) fail('控制台报错：' + consoleErrors.join(' | ').slice(0, 300));
await context.close();
