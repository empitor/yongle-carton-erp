// 以前只打开过窗口、没真正提交过的操作，这里点到底：保存新订单、登记完工并确认入库、更正到货、
// 采购退货再撤销、助手提出删除待送货单并在卡片上确认、网关出错的提示、
// 只读账号看不到退货按钮。模拟从域名访问的那段在 flow-remote.mjs。全部虚构数据。
import { BASE, SP, login, notice, openAssistant, openChrome, reviewButtonsFit } from './lib.mjs';
const fail = (message) => console.log('ERR: ' + message);
const ok = (message) => console.log('ok ' + message);
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
const dialog = () => page.locator('[role="dialog"][aria-modal="true"]').last();
let shots = 0;
const shot = (label) => page.screenshot({ path: `${SP}/o${String(++shots).padStart(2, '0')}-${label}.png` });
const open = async (hash, rows = 'main tbody tr') => {
  await page.goto(BASE + hash);
  await page.locator(rows).first().waitFor();
};
const api = (path) => page.evaluate(async (p) => (await fetch(p)).json(), path);
/** 这次操作的页面提示（上一步留下的不算） */
const toast = (pattern) => notice(page, pattern);
const pick = async (label, text) => {
  const input = page.getByRole('combobox', { name: label }).first();
  await input.click();
  await input.fill(text);
  await page.getByRole('option', { name: new RegExp(text) }).first().click();
};
const panel = () => page.locator('.detail-panel');
/** 详情里的操作：直接的按钮，或者“更多”里的 */
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
await login(page);

await step('保存新订单', async () => {
  await open('#orders?scope=all');
  const before = (await api('/api/orders')).length;
  await page.getByRole('button', { name: '新建订单' }).first().click();
  await dialog().waitFor();
  await pick('订单客户', '虚构余姚塑料');
  // 交货日期不再默认今天（不猜日期），要自己填；填一周后
  const due = new Date();
  due.setDate(due.getDate() + 7);
  const dueText = due.getFullYear() + '-' + String(due.getMonth() + 1).padStart(2, '0') + '-' + String(due.getDate()).padStart(2, '0');
  await dialog().getByLabel(/^交货日期/).fill(dueText);
  await pick('第 1 行产品', '水壶外箱');
  await dialog().getByLabel('第 1 行数量', { exact: true }).fill('321');
  await dialog().getByLabel('第 1 行单价', { exact: true }).fill('2.35');
  await shot('新订单');
  await dialog().getByRole('button', { name: '保存并确认' }).click();
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  const after = await api('/api/orders');
  const saved = after.find((o) => o.lines?.some((l) => l.quantity === 321));
  if (after.length !== before + 1 || !saved) fail('新订单没有保存上');
  else if (saved.status !== '已确认' || saved.lines[0].unit !== '只' || saved.totalCents !== 75435)
    fail('新订单的状态、单位或金额不对：' + JSON.stringify({ status: saved.status, unit: saved.lines[0].unit, total: saved.totalCents }));
  else ok('新订单 ' + saved.number + ' 已保存：' + (await toast(/订单/)));
});

const openTasks = async () =>
  (await api('/api/flow?kind=task')).filter((t) => t.status === 'confirmed' && !t.hasProduction);
const balanceOf = async (productId) =>
  (await api('/api/warehouse/items?kind=finished'))
    .filter((i) => i.productId === productId)
    .reduce((n, i) => n + Number(i.balanceUnits || 0), 0);
/** 打开一张还没开工的生产任务，填好登记完工窗口（良品按预填、领一种纸板） */
const fillCompletion = async (task) => {
  await open('#production?doc=' + task.id, '.detail-panel');
  await panel().getByRole('button', { name: '登记完工', exact: true }).first().click();
  await dialog().waitFor();
  await dialog().getByLabel('实际操作人员').fill('虚构机长');
  await pick('第 1 种纸板', 'BC五层纸板');
  await dialog().getByLabel('第 1 种纸板领用（张）', { exact: true }).fill('120');
};

await step('登记完工直接入库', async () => {
  const [task] = await openTasks();
  const before = await balanceOf(task.productId);
  await fillCompletion(task);
  await shot('登记完工');
  await dialog().getByRole('button', { name: '登记完工', exact: true }).click();
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  const said = await toast(/登记完工/);
  await shot('登记完工之后');
  const after = await balanceOf(task.productId);
  if (after - before !== Number(task.quantity) * 1000) fail('登记完工后成品库存没加上：' + before + ' → ' + after);
  else ok('登记完工入库 ' + task.quantity + ' 只：' + said);
});

await step('先登记再核对入库', async () => {
  const [task] = await openTasks();
  const before = await balanceOf(task.productId);
  await fillCompletion(task);
  await dialog().getByLabel(task.number + '实际良品').fill('300');
  await dialog().locator('summary', { hasText: '更多' }).click();
  await shot('先登记稍后核对入库');
  await dialog().getByRole('menuitem', { name: '先登记，稍后核对入库' }).click();
  // 就在这个窗口里登记成待入库：窗口关闭、页面提示，不再换一个单张登记窗；核对入库时才加库存
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  const said = await toast(/完工/);
  if (!/已登记 1 张完工.*待核对入库/.test(said)) fail('先登记的提示不对：' + said);
  const record = (await api('/api/flow?kind=production')).find((p) => p.taskId === task.id && p.status === 'draft');
  if (!record) throw new Error('没生成待入库的完工记录');
  if (Number(record.goodQuantity) !== 300) fail('待入库完工单的合格数量不对：' + record.goodQuantity);
  if ((await balanceOf(task.productId)) !== before) fail('还没核对就动了库存');
  await open('#production?view=production&doc=' + record.id, '.detail-panel');
  await panel().getByRole('button', { name: '核对入库', exact: true }).click();
  await dialog().waitFor();
  await shot('核对入库');
  await dialog().getByRole('button', { name: '确认入库', exact: true }).click();
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  const after = await balanceOf(task.productId);
  if (after - before !== Number(record.goodQuantity) * 1000) fail('确认入库后成品库存不对：' + before + ' → ' + after);
  else ok('核对后确认入库：' + (await toast(/入库/)));
});

const arrivals = async () => await api('/api/flow?kind=arrival');
const openArrival = (id) => open('#warehouse?arrivals=1&doc=' + id, '.detail-panel');

await step('更正到货', async () => {
  const target = (await arrivals()).find((a) => a.status === 'confirmed' && !a.replacedBy);
  await openArrival(target.id);
  await action('更正到货单');
  await dialog().waitFor();
  const quantity = dialog().locator('input[aria-label$="正确数量"]').first();
  const was = Number(await quantity.inputValue());
  await quantity.fill(String(was - 50));
  await dialog().getByLabel('更正原因').fill('虚构点错数量');
  const submit = dialog().getByRole('button', { name: '提交更正' });
  await submit.waitFor();
  for (let i = 0; i < 50 && (await submit.isDisabled()); i++) await page.waitForTimeout(100);
  await shot('更正到货');
  await submit.click();
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  const after = await api('/api/flow/' + target.id);
  if (!after.replacedBy) fail('提交更正后原到货单没有被替代');
  else ok('到货 ' + target.number + ' 已更正：' + (await toast(/更正/)));
});

await step('删替代单的影响清单', async () => {
  // 上一步更正出来的替代单：删它时原到货单留着，只解除“替代它的单据”这层关系（单据表上的外键列）
  const replacement = (await arrivals()).find((a) => a.status === 'confirmed' && a.correctionOf);
  if (!replacement) return fail('没有找到更正出来的替代单');
  await openArrival(replacement.id);
  await action('删除');
  await dialog().waitFor();
  await dialog().getByText(/只解除关联/).first().waitFor({ timeout: 8000 });
  const text = await dialog().innerText();
  if (!/替代它的单据/.test(text) || /replaced_by|单据内关联/.test(text))
    fail('删替代单的影响清单应把原到货单列成解除“替代它的单据”：' + text.replace(/\s+/g, ' ').slice(0, 300));
  else ok('删替代单的影响清单：原到货单解除“替代它的单据”');
  await page.waitForTimeout(400); // 等窗口的出现动画放完再截图
  await shot('删替代单影响清单');
  // 只看影响清单，不真删：后面的步骤还要用这些到货单
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
});

await step('采购退货再撤销', async () => {
  const target = (await arrivals()).find((a) => a.status === 'confirmed' && !a.replacedBy);
  await openArrival(target.id);
  await action('采购退货');
  await dialog().waitFor();
  await dialog().locator('input[aria-label^="本次退货数量"]').first().fill('10');
  await dialog().getByPlaceholder('例如：受潮、尺寸不对').fill('虚构受潮');
  await dialog().getByRole('button', { name: '确认退货' }).click();
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  await toast(/退货/);
  // 从采购单详情点开这张到货单（窗口）：退货照样列出来、不能撤销（撤销到到货页办），到货记录和到货页一样有
  await page.goto(BASE + '#purchases?record=' + target.lines[0].purchaseId);
  await page.locator('.rb-docs button', { hasText: target.number }).first().click();
  await dialog().locator('.flow-returns').waitFor({ timeout: 8000 });
  const popupUndo = await dialog().getByRole('button', { name: '撤销退货' }).count();
  const popupHistory = await dialog().getByRole('heading', { name: '到货记录' }).count();
  // 到货记录展开后也只看：不能在窗口上再开“更正到货单”
  if (popupHistory) await dialog().getByRole('button', { name: /^展开 \d+ 批$/ }).click();
  await dialog().locator('.receipt-history').waitFor({ timeout: 5000 }).catch(() => fail('窗口里的到货记录点“展开”没列出来'));
  const popupCorrect = await dialog().getByRole('button', { name: '更正到货单' }).count();
  await shot('窗口里的到货单退货');
  const problems = [popupUndo && '退货能撤销', !popupHistory && '没有到货记录', popupCorrect && '到货记录能更正到货单'].filter(Boolean);
  if (problems.length) fail('从采购单点开的到货单窗口：' + problems.join('、'));
  else ok('从采购单点开的到货单窗口：列出退货和到货记录，不能撤销退货、不能更正到货单');
  await page.keyboard.press('Escape');
  await openArrival(target.id);
  const undo = panel().getByRole('button', { name: '撤销退货' });
  await undo.first().waitFor({ timeout: 5000 });
  await undo.first().click();
  await dialog().waitFor();
  await dialog().getByLabel('撤销原因').fill('虚构退错了');
  await shot('撤销退货');
  await dialog().getByRole('button', { name: '撤销退货' }).click();
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  await page.waitForTimeout(600);
  const section = await panel().locator('.flow-returns').innerText();
  if (!/已撤销/.test(section)) fail('撤销退货后退货记录没显示已撤销：' + section.slice(0, 120));
  else ok('采购退货后撤销：' + (await toast(/撤销/)));
});

// 导出窗里预览待送货的送货单：印的是“导出并出库”后的样子，实际送货日期是今天，不是当初安排的日子
await step('送货单预览出库日期', async () => {
  const pending = (await api('/api/flow?kind=delivery')).find((d) => d.status === 'draft');
  const today = await page.evaluate(() => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10));
  await open('#warehouse?kind=finished&deliveries=1&doc=' + pending.id, '.detail-panel');
  await panel().getByRole('button', { name: '导出送货单', exact: true }).click();
  await dialog().waitFor();
  await dialog().getByRole('button', { name: '预览送货单' }).click();
  await page.waitForTimeout(1200);
  const text = await dialog().innerText();
  await shot('送货单预览');
  // 预览在导出窗里原地换成纸面，不再叠一个窗口；“返回导出”回到导出
  if ((await page.locator('[role="dialog"][aria-modal="true"]').count()) !== 1) fail('送货单预览又叠了一个窗口');
  else if (!(await dialog().getByRole('button', { name: '返回导出' }).isVisible())) fail('送货单预览里没有“返回导出”');
  else ok('送货单预览在导出窗里原地显示');
  if (!text.includes('实际送货日期') || !text.includes(today) || text.includes('预计送货日期'))
    fail('送货单预览没印今天的实际送货日期：' + (text.match(/(实际|预计)送货日期.{0,20}/) || [''])[0]);
  else ok('送货单预览印的是今天 ' + today + ' 的实际送货日期（安排的是 ' + pending.plannedDate + '）');
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
});

// 订单已有一部分排进待送货单，再从订单安排送货：预填的只剩没排的部分，不再按订单剩余全量预填
await step('安排送货扣掉待送货单', async () => {
  const [drafts, orders, items] = await Promise.all([
    api('/api/flow?kind=delivery&status=draft'),
    api('/api/orders'),
    api('/api/warehouse/items'),
  ]);
  const pending = new Map();
  for (const d of drafts) for (const l of d.lines) pending.set(l.orderLineId, (pending.get(l.orderLineId) || 0) + Number(l.quantity) * 1000);
  const units = (q) => Math.round(Number(q) * 1000);
  const target = orders
    .filter((o) => o.lines.length === 1 && ['已确认', '生产中', '待发货'].includes(o.status))
    .map((o) => {
      const line = o.lines[0];
      const stock = items.find((i) => i.kind === 'finished' && !i.archived && i.productId === line.productId && i.unit === line.unit);
      return { o, line, stock, left: units(line.remainingQuantity ?? line.quantity) - (pending.get(line.id) || 0) };
    })
    .find((c) => pending.get(c.line.id) && c.left > 0 && c.stock && c.stock.availableUnits > 0);
  if (!target) return fail('种子数据里没有部分排进待送货单、又有可用库存的订单，这一步没测到');
  const expected = Math.min(target.left, target.stock.availableUnits);
  await page.goto(BASE + '#warehouse?kind=finished&deliveries=1&createDelivery=1&order=' + target.o.id);
  await dialog().waitFor();
  const input = dialog().locator('input[aria-label*="本次送货数量"]').first();
  await input.waitFor();
  const got = units(await input.inputValue());
  await shot('安排送货扣待送货');
  if (got !== expected)
    fail('订单 ' + target.o.number + ' 预填 ' + got / 1000 + '，应为 ' + expected / 1000 + '（剩余减去待送货单已排的 ' + pending.get(target.line.id) / 1000 + '）');
  else ok('订单 ' + target.o.number + ' 已排 ' + pending.get(target.line.id) / 1000 + '，安排送货只预填剩下的 ' + got / 1000);
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
});

await step('助手删待送货单', async () => {
  const pending = (await api('/api/flow?kind=delivery')).find((d) => d.status === 'draft');
  if (!pending) throw new Error('种子里没有待送货的送货单');
  // 让模型替身下一次回复：提出删除这张送货单
  await page.evaluate(
    async (id) =>
      fetch('/__ui-check/replies', {
        method: 'POST',
        body: JSON.stringify([{ message: '', toolCalls: [{ name: 'records.delete', args: { module: 'deliveries', id } }] }]),
      }),
    pending.id,
  );
  await open('#dashboard', 'main');
  const box = await openAssistant(page);
  await box.fill('把送货单 ' + pending.number + ' 删掉');
  await page.locator('[data-global-assistant]').getByRole('button', { name: '发送' }).click();
  // 聊天里先是方案卡片，点“查看修改内容并确认”展开，才有删除按钮（和页面删除窗口同一句：“删除送货单”，连带删单据时写明几张）
  await page.locator('[data-global-assistant]').getByRole('button', { name: '查看修改内容并确认' }).click({ timeout: 15000 });
  const confirm = page.locator('[data-global-assistant] .ga-review-actions').getByRole('button', { name: '确认删除' });
  await confirm.waitFor({ timeout: 8000 });
  await reviewButtonsFit(page);
  const card = await page.locator('[data-global-assistant]').innerText();
  if (!/不会自动执行/.test(card)) fail('删除卡片没写明要人确认');
  if (!/会删除/.test(card) || /correctionOf|plannedDate|未填写/.test(card)) fail('删除卡片应列出会删的记录，不按字段对比：' + card.slice(0, 200));
  if (await page.locator('[data-global-assistant] input[type=password]').count()) fail('本机最高管理员删还没核对的单据不该要密码');
  await shot('助手删除卡片');
  const still = await api('/api/flow?kind=delivery');
  if (!still.some((d) => d.id === pending.id)) fail('没点确认就删了');
  await confirm.click();
  await page.waitForTimeout(1500);
  const left = await api('/api/flow?kind=delivery');
  if (left.some((d) => d.id === pending.id)) fail('点了删除，送货单还在');
  else ok('助手删除待送货单 ' + pending.number + '：卡片上点确认后删掉');
  await page.keyboard.press('Escape');
});

await step('网关出错', async () => {
  await page.route('**/api/orders**', (route) =>
    route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }),
  );
  await page.goto(BASE + '#orders');
  await page.getByText('服务暂时不可用').first().waitFor({ timeout: 8000 });
  await shot('网关出错');
  if (await page.getByText(/Unexpected token|JSON/).count()) fail('网关出错时露出了语法错误');
  else ok('网关出错显示“服务暂时不可用”');
  await page.unroute('**/api/orders**');
});

// 只读账号：看得到到货和退货记录，看不到“采购退货”按钮
await step('只读账号', async () => {
  const viewer = await openChrome({ width: 1440, height: 900 });
  try {
    await login(viewer.page, '虚构只读');
    const target = (await viewer.page.evaluate(async () => (await fetch('/api/flow?kind=arrival')).json())).find(
      (a) => a.status === 'confirmed',
    );
    await viewer.page.goto(BASE + '#warehouse?arrivals=1&doc=' + target.id);
    await viewer.page.locator('.detail-panel').waitFor();
    await viewer.page.waitForTimeout(800);
    const buttons = await viewer.page.locator('.detail-panel button, .detail-panel [role=menuitem]').allInnerTexts();
    if (buttons.some((b) => /采购退货|更正到货单|撤销/.test(b))) fail('只读账号看到了改单据的按钮：' + buttons.join(' | '));
    else ok('只读账号看不到采购退货、更正这些按钮');
    await viewer.page.screenshot({ path: `${SP}/o-只读到货详情.png` });
    // 能看记录就能看它的关联记录与修改历史（和助手查修改历史同一个判断）
    await viewer.page.locator('.detail-panel .more-menu summary').first().click();
    await viewer.page.getByRole('menuitem', { name: '关联记录与修改历史', exact: true }).click();
    const box = viewer.page.locator('[role="dialog"][aria-modal="true"]').last();
    await box.getByText(/^最近修改 \d+$/).waitFor({ timeout: 8000 });
    if (await box.locator('.form-message.tone-danger').count()) fail('只读账号打开关联记录与修改历史报错：' + (await box.locator('.form-message.tone-danger').innerText()));
    else ok('只读账号能看关联记录与修改历史：' + (await box.getByText(/^最近修改 \d+$/).innerText()));
    await viewer.page.screenshot({ path: `${SP}/o-只读修改历史.png` });
    await viewer.page.keyboard.press('Escape');
    // 新建订单、安排生产的链接：只读账号不打开编辑窗，只用一句话说明原因
    for (const hash of ['#orders?create=1', '#production?create=1']) {
      await viewer.page.goto(BASE + hash);
      const why = viewer.page.locator('.toast-error, .form-message.tone-danger', { hasText: '只能查看' }).first();
      await why.waitFor({ timeout: 8000 });
      if (await viewer.page.locator('[role="dialog"][aria-modal="true"]').count())
        fail('只读账号打开了新建窗口：' + hash);
      else ok('只读账号点 ' + hash + ' 只提示：' + (await why.innerText()));
    }
  } finally {
    await viewer.context.close();
  }
});

// 弹窗底栏的“更多”：底栏有毛玻璃（backdrop-filter），菜单以前被推到屏幕外面看不见。打开后要整个在屏幕里、没被盖住
// 菜单在打开后的下一帧才摆到位（src/ui/MoreMenu.tsx：toggle 后 requestAnimationFrame），等它摆好再量，最多 1 秒
const menuOnScreen = async () => {
  let last = { shown: false };
  for (let i = 0; i < 10 && !last.shown; i++) {
    if (i) await page.waitForTimeout(100);
    last = await menuBox();
  }
  return last;
};
const menuBox = () =>
  page.evaluate(() => {
    const list = document.querySelector('details.more-menu[open] .more-menu-list');
    if (!list) return { shown: false };
    const r = list.getBoundingClientRect(),
      hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 16));
    return {
      shown: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && !!hit && list.contains(hit),
      box: [r.left, r.top, r.right, r.bottom].map(Math.round),
    };
  });
await step('弹窗底栏的更多菜单', async () => {
  await open('#purchases');
  const waiting = (await api('/api/purchases')).find((p) => (p.orderStatus || p.status) === '待订货');
  if (!waiting) throw new Error('没有待订货的采购单');
  await page.getByRole('checkbox', { name: '选择 ' + waiting.number }).check();
  await page.getByRole('region', { name: '已选记录的操作' }).getByRole('button', { name: /导出订货单/ }).click();
  await dialog().waitFor();
  await dialog().locator('.editor-footer summary', { hasText: '更多' }).click();
  const sheet = await menuOnScreen();
  await shot('订货单底栏更多');
  if (!sheet.shown) fail('订货单导出窗底栏的“更多”菜单不在屏幕里：' + JSON.stringify(sheet.box));
  else if (!(await dialog().getByRole('menuitem', { name: '预览 Word 排版' }).isVisible())) fail('订货单“更多”里看不到“预览 Word 排版”');
  else ok('订货单导出窗底栏的“更多”在屏幕里 ' + JSON.stringify(sheet.box));
  // Esc 先关菜单、焦点回到“更多”，窗口还在
  await page.keyboard.press('Escape');
  const after = await page.evaluate(() => ({ open: !!document.querySelector('details.more-menu[open]'), focus: document.activeElement?.tagName }));
  if (after.open || after.focus !== 'SUMMARY' || !(await dialog().count())) fail('Esc 没有只关菜单：' + JSON.stringify(after));
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await dialog().waitFor({ state: 'detached', timeout: 5000 });
  // 登记完工窗（从页头进来，不登记；生产页默认是排产板，没有表格行）
  await page.goto(BASE + '#production');
  const header = page.locator('main').getByRole('button', { name: '登记完工', exact: true }).first();
  await header.waitFor();
  await header.click();
  await dialog().waitFor();
  await dialog().locator('.editor-footer summary', { hasText: '更多' }).click();
  const done = await menuOnScreen();
  if (!done.shown) fail('登记完工窗底栏的“更多”菜单不在屏幕里：' + JSON.stringify(done.box));
  else ok('登记完工窗底栏的“更多”在屏幕里 ' + JSON.stringify(done.box));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
});

// 平板宽度：底部勾选条还在时弹出的提示要在勾选条上面，不能挡住按钮
await step('平板勾选条和提示', async () => {
  const tablet = await openChrome({ width: 768, height: 1024 });
  try {
    await login(tablet.page);
    const p = tablet.page;
    await p.goto(BASE + '#purchases');
    await p.locator('main tbody tr').first().waitFor();
    const purchases = await p.evaluate(async () => (await fetch('/api/purchases')).json());
    const [a, b] = [purchases[0], purchases.find((x) => x.supplierId !== purchases[0].supplierId)];
    await p.getByRole('checkbox', { name: '选择 ' + a.number }).check();
    await p.getByRole('checkbox', { name: '选择 ' + b.number }).check();
    const bar = p.getByRole('region', { name: '已选记录的操作' });
    await bar.getByRole('button', { name: /导出订货单/ }).click();
    const notice = p.locator('.toast').first();
    await notice.waitFor({ timeout: 5000 });
    const [n, s] = [await notice.boundingBox(), await bar.boundingBox()];
    await p.screenshot({ path: `${SP}/o-平板勾选条和提示.png` });
    if (!n || !s || n.y + n.height > s.y + 1) fail('平板宽度下提示挡住了勾选条：' + JSON.stringify({ n, s }));
    else ok('平板宽度下提示在勾选条上面');
  } finally {
    await tablet.context.close();
  }
});

const real = [...new Set(consoleErrors)].filter((e) => !/status of (403|502)/.test(e));
if (real.length) fail('控制台报错：' + real.join(' | ').slice(0, 300));
await context.close();
