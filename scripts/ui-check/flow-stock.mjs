// 采购、到货、送货、库存点到底（和 operations 同一组，接在它后面；operations 会删掉供应商虚构华美瓦楞）：
// 新建采购单保存为待到货 → 按这张采购单登记到货，原材料库存加上；待订货的采购单导出 Excel 订货单；已入库到货单只改备注和到货时间；从订单安排送货 → 导出并出库，下载到送货单文件、成品库存扣掉；库存品手动入库再盘点调整；已归档的到货单、送货单详情和在用的一样。全部虚构数据。
import { BASE, SP, businessDay, call, fail, login, notice, ok, openChrome, step as stepOn } from './lib.mjs';
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
const dialog = () => page.locator('[role="dialog"][aria-modal="true"]').last();
const panel = () => page.locator('.detail-panel');
let shots = 0;
const shot = (label) => page.screenshot({ path: `${SP}/k${String(++shots).padStart(2, '0')}-${label}.png` });
const api = (path) => page.evaluate(async (p) => (await fetch(p)).json(), path);
const step = (name, fn) => stepOn(page, name, fn);
const toast = (pattern) => notice(page, pattern);
const pick = async (label, text) => {
  const input = page.getByRole('combobox', { name: label }).first();
  await input.click();
  await input.fill(text);
  await page.getByRole('option', { name: new RegExp(text) }).first().click();
};
/** 详情里的操作：直接的按钮，或者“更多”里的 */
const action = async (name) => {
  const direct = panel().getByRole('button', { name, exact: true });
  if (await direct.count()) return direct.first().click();
  await panel().locator('summary', { hasText: '更多' }).first().click();
  await panel().locator('details[open]').getByRole('menuitem', { name, exact: true }).first().click();
};
const items = () => api('/api/warehouse/items');
/** 库存品余额（张或只） */
const balance = async (id) => Number((await items()).find((i) => i.id === id)?.balanceUnits ?? NaN) / 1000;
await login(page);
const raw = (await items()).filter((i) => i.kind === 'raw');
const board = raw.find((i) => i.name.startsWith('E三层纸板'));
const spare = raw.find((i) => i.name.startsWith('B三层纸板'));

let purchase = null;
await step('新建采购单', async () => {
  const before = (await api('/api/purchases')).length;
  await page.goto(BASE + '#purchases?create=1');
  await dialog().waitFor();
  await pick('供应商', '虚构鼎盛纸业');
  await pick('采购明细1 库存品', 'E三层纸板');
  await dialog().getByLabel('纸板1 订货数量').fill('600');
  await shot('新建采购单');
  // 保存为待到货：供应商已经确认要送，直接进待到货
  await dialog().getByRole('button', { name: '保存为待到货', exact: true }).click();
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  const said = await toast(/采购单/);
  const list = await api('/api/purchases');
  purchase = list.sort((a, b) => b.id - a.id)[0];
  const line = purchase?.lines?.[0];
  if (list.length !== before + 1 || purchase.supplierName !== '虚构鼎盛纸业') fail('新采购单没存上：' + before + ' → ' + list.length);
  else if (purchase.businessStatus !== '已订货' || line.quantity !== '600' || line.stockItemId !== board.id || line.unit !== '张')
    fail('新采购单的状态、数量或纸板不对：' + JSON.stringify({ status: purchase.businessStatus, line }));
  else ok('新建采购单 ' + purchase.number + ' 待到货 600 张：' + said);
});

await step('按采购单登记到货', async () => {
  if (!purchase) throw new Error('上一步没建出采购单');
  const before = await balance(board.id);
  await page.goto(BASE + '#purchases?record=' + purchase.id);
  await panel().getByRole('button', { name: '登记到货', exact: true }).click();
  await dialog().waitFor();
  // 到了 580 张、其中拒收 10 张：合格的 570 张入库，还差 20 张继续待到货
  await dialog().getByLabel(/本次实到$/).first().fill('580');
  await dialog().getByLabel(/拒收$/).first().fill('10');
  await dialog().getByLabel('供应商送货单号').fill('GYS-虚构-' + Date.now());
  await shot('登记到货');
  await dialog().getByRole('button', { name: '登记到货', exact: true }).click();
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  const said = await toast(/到货/);
  const after = await balance(board.id);
  const line = (await api('/api/purchases')).find((p) => p.id === purchase.id).lines[0];
  await page.goto(BASE + '#purchases?record=' + purchase.id);
  const progress = await panel().getByRole('group', { name: '到货进度' }).innerText({ timeout: 8000 }).catch(() => '');
  await shot('登记到货之后');
  if (after - before !== 570) fail('登记到货后原材料库存应加 570 张：' + before + ' → ' + after);
  else if (line.receivedQuantity !== '580' || !/580\s*\/\s*600/.test(progress)) fail('采购单到货进度不对：' + line.receivedQuantity + ' ' + progress);
  else ok('按采购单登记到货：库存 ' + before + ' → ' + after + ' 张，进度 ' + progress.replace(/\s+/g, ' ') + '：' + said);
});

// 待订货的采购单在列表里勾选 → 导出订货单选 Excel：下载到 .xlsx，采购单变成待到货
await step('导出订货单 Excel', async () => {
  const waiting = (await api('/api/purchases')).find((p) => p.businessStatus === '待订货');
  if (!waiting) throw new Error('种子里没有待订货的采购单');
  await page.goto(BASE + '#purchases');
  await page.getByRole('checkbox', { name: '选择 ' + waiting.number }).check();
  await page.getByRole('region', { name: '已选记录的操作' }).getByRole('button', { name: /导出订货单/ }).click();
  await dialog().waitFor();
  await dialog().getByLabel('订货单文件格式').selectOption({ label: 'Excel' });
  const [file] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    dialog().getByRole('button', { name: '导出订货单', exact: true }).click(),
  ]);
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  const said = await toast(/订货单/);
  const after = (await api('/api/purchases')).find((p) => p.id === waiting.id);
  if (!/\.xlsx$/.test(file.suggestedFilename())) fail('选了 Excel，下载的却是：' + file.suggestedFilename());
  else if (after.businessStatus !== '已订货') fail('导出订货单后采购单没变成待到货：' + after.businessStatus);
  else ok('导出订货单 ' + file.suggestedFilename() + '，采购单 ' + waiting.number + ' 变成待到货：' + said);
});

// 已入库到货单的“编辑”：只改备注和到货时间，库存不动、不出替代单；详情和修改历史里看得到
await step('已入库到货单编辑备注和时间', async () => {
  const arrival = (await api('/api/flow?kind=arrival')).find((a) => a.status === 'confirmed' && !a.replacedBy && !a.correctionOf);
  const before = await items();
  const note = '虚构编辑：卸货时有两张淋湿';
  await page.goto(BASE + '#warehouse?arrivals=1&doc=' + arrival.id);
  // “编辑”和“采购退货”并排：都完整显示、不重叠、文字不被截断
  await panel().getByRole('button', { name: '采购退货', exact: true }).waitFor();
  const [edit, ret] = await Promise.all(['编辑', '采购退货'].map((n) => panel().getByRole('button', { name: n, exact: true }).boundingBox()));
  const cut = await panel().getByRole('button', { name: '采购退货', exact: true }).evaluate((b) => b.scrollWidth > b.clientWidth + 1);
  if (!edit || !ret || cut || (edit.y === ret.y && edit.x < ret.x + ret.width && ret.x < edit.x + edit.width))
    fail('到货详情的“编辑”和“采购退货”挤在一起：' + JSON.stringify({ edit, ret, cut }));
  await panel().getByRole('button', { name: '编辑', exact: true }).click();
  await dialog().waitFor();
  await dialog().getByLabel('到货时间').fill('10:30');
  await dialog().getByLabel('备注').fill(note);
  await shot('到货单编辑');
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  const said = await toast(/到货|已保存/);
  const after = await api('/api/flow/' + arrival.id);
  // 保存后详情跟着关了：从列表重新打开这张
  await page.locator('main tbody tr', { hasText: arrival.number }).first().click();
  const detail = await panel().innerText({ timeout: 8000 });
  await shot('到货单编辑之后');
  const changed = (await items()).filter((i) => before.find((b) => b.id === i.id)?.balanceUnits !== i.balanceUnits);
  if (after.notes !== note || after.actualTime !== '10:30') fail('到货单编辑没存上：' + JSON.stringify({ notes: after.notes, time: after.actualTime }));
  else if (after.replacedBy || changed.length) fail('只改备注和时间却出了替代单或动了库存');
  else if (!detail.includes(note) || !detail.includes('10:30')) fail('详情里没显示新备注和到货时间');
  else ok('已入库到货单 ' + arrival.number + ' 改了备注和到货时间：' + said);
  await action('关联记录与修改历史');
  const history = dialog();
  await history.getByText(/^最近修改 \d+$/).waitFor({ timeout: 8000 });
  const text = await history.innerText();
  if (!text.includes(note) && !/修改/.test(text)) fail('修改历史里没有这次编辑：' + text.slice(0, 200));
  await page.keyboard.press('Escape');
  // 手机宽度看一眼编辑窗
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '#warehouse?arrivals=1&doc=' + arrival.id);
  await panel().getByRole('button', { name: '编辑', exact: true }).click();
  await dialog().waitFor();
  if (await dialog().evaluate((el) => el.scrollWidth > el.clientWidth + 1)) fail('手机宽度下到货编辑窗横向滚动');
  await page.waitForTimeout(500); // 底部弹层有滑入动画，等它放完再截图
  await shot('到货单编辑-手机');
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
});

await step('安排送货再导出并出库', async () => {
  const [orders, finished, drafts] = await Promise.all([api('/api/orders'), api('/api/warehouse/items?kind=finished'), api('/api/flow?kind=delivery&status=draft')]);
  const planned = new Set(drafts.flatMap((d) => d.lines.map((l) => l.orderLineId)));
  const target = orders
    .filter((o) => ['已确认', '生产中', '待发货'].includes(o.status) && o.lines.length === 1 && !planned.has(o.lines[0].id))
    .map((o) => ({ o, stock: finished.find((i) => !i.archived && i.productId === o.lines[0].productId) }))
    .find((c) => c.stock && c.stock.availableUnits >= 100000);
  if (!target) throw new Error('种子里没有有库存、还没排送货的订单');
  const line = target.o.lines[0];
  const before = await balance(target.stock.id);
  await page.goto(BASE + '#warehouse?kind=finished&deliveries=1&createDelivery=1&order=' + target.o.id);
  await dialog().waitFor();
  await dialog().locator('input[aria-label$="本次送货数量"]').first().fill('100');
  await shot('安排送货');
  await dialog().getByRole('button', { name: /^安排送货（\d+ 张）$/ }).click();
  await dialog().waitFor({ state: 'detached', timeout: 8000 });
  const arranged = await toast(/送货/);
  const delivery = (await api('/api/flow?kind=delivery&status=draft')).find((d) => d.lines.some((l) => l.orderLineId === line.id));
  if (!delivery) throw new Error('安排送货后没有这张订单的待送货单');
  if (Number(delivery.lines[0].quantity) !== 100) fail('待送货单数量不是 100：' + delivery.lines[0].quantity);
  if ((await balance(target.stock.id)) !== before) fail('只是安排送货就动了成品库存');
  await page.goto(BASE + '#warehouse?kind=finished&deliveries=1&doc=' + delivery.id);
  await panel().getByRole('button', { name: '导出送货单', exact: true }).click();
  await dialog().waitFor();
  const [file] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    dialog().getByRole('button', { name: '导出并出库', exact: true }).click(),
  ]);
  const name = file.suggestedFilename();
  let shipped = null;
  for (let i = 0; i < 40 && !shipped; i++) {
    const d = await api('/api/flow/' + delivery.id);
    if (d.status !== 'draft') shipped = d;
    else await page.waitForTimeout(200);
  }
  await dialog().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  const after = await balance(target.stock.id);
  const row = page.locator('main tbody tr', { hasText: delivery.number }).first();
  const head = await row.innerText({ timeout: 8000 }).catch(() => '');
  await shot('导出并出库之后');
  if (!/\.docx$/.test(name)) fail('导出并出库下载的不是 Word 送货单：' + name);
  else if (!shipped) fail('导出并出库后送货单还是待送货');
  else if (before - after !== 100) fail('导出并出库后成品库存应少 100 只：' + before + ' → ' + after);
  else if (!head.includes('送货中')) fail('送货列表里这张送货单没写“送货中”：' + head.slice(0, 120));
  else ok('订单 ' + target.o.number + ' 安排送货 100 只（' + arranged + '），导出 ' + name + ' 并出库，库存 ' + before + ' → ' + after + '，送货中');
});

await step('安排送货按厂区拆单', async () => {
  const [customers, finished] = await Promise.all([api('/api/customers'), api('/api/warehouse/items?kind=finished')]);
  const customer = customers.find((c) => c.sites?.length > 1 && finished.some((s) => s.customerId === c.id && s.availableUnits >= 20000));
  const stock = finished.find((s) => s.customerId === customer?.id && s.availableUnits >= 20000);
  if (!customer || !stock) throw new Error('种子里没有多厂区客户的可用成品');
  const main = customer.sites.find((s) => s.isDefault), branch = customer.sites.find((s) => !s.isDefault);
  const date = businessDay(), line = { productId: stock.productId, quantity: 10, unitPriceCents: 100 };
  const order = await call(page, 'POST', '/orders', { customerId: customer.id, orderDate: date, deliveryDate: date, status: '已确认', lines: [line, line] });
  if (!order.id) throw new Error('无法新建拆单用的虚构订单：' + order.error);
  await page.goto(BASE + '#orders');
  await page.goto(BASE + '#warehouse?kind=finished&deliveries=1&createDelivery=1&order=' + order.id);
  const selector = dialog().getByLabel(/收货厂区$/);
  await selector.waitFor();
  if (await selector.inputValue() !== String(main.id)) fail('安排送货没有预选默认厂区');
  await selector.selectOption(String(branch.id));
  const address = dialog().getByLabel(/收货地址$/);
  // 收货信息是由厂区带出的只读文字（output），不是输入框
  const shownAddress = await address.evaluate((el) => [el.tagName, el.textContent]);
  if (shownAddress[0] !== 'OUTPUT' || shownAddress[1] !== branch.address) fail('收货地址预览没有随厂区更新或不是只读文字：' + shownAddress.join(' '));
  // 两行时每行的“去掉 …”看得见、点得到（不被拆单下拉挤掉），下拉宽得下“拆给别的厂区”整句
  const removes = dialog().getByRole('button', { name: /^去掉 / }), splits = dialog().getByLabel(/^拆给别的厂区/);
  if (await removes.count() !== 2 || await splits.count() !== 2) fail('两行明细应各有一个“去掉”和一个“拆给别的厂区”');
  for (const b of await removes.all()) {
    const box = await b.boundingBox();
    if (!box || box.width < 16 || box.height < 16) fail('“去掉”按钮看不见：' + JSON.stringify(box));
    await b.click({ trial: true });
  }
  for (const s of await splits.all()) {
    const fits = await s.evaluate((el) => {
      const probe = document.createElement('span');
      probe.textContent = el.options[el.selectedIndex].text;
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + getComputedStyle(el).font;
      document.body.append(probe);
      const need = probe.getBoundingClientRect().width;
      probe.remove();
      const style = getComputedStyle(el); // 右内边距里含下拉箭头，字只能排在两边内边距之间
      return { text: el.options[el.selectedIndex].text, need, inner: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
    });
    if (fits.text !== '拆给别的厂区' || fits.inner < fits.need) fail('拆单下拉显示不全：' + JSON.stringify(fits));
  }
  ok('两行明细：每行“去掉”看得见点得到，“拆给别的厂区”整句显示');
  await splits.first().selectOption(String(main.id));
  await dialog().getByRole('button', { name: '安排送货（2 张）' }).waitFor();
  await shot('送货拆给别的厂区');
  await dialog().getByRole('button', { name: '安排送货（2 张）' }).click();
  await dialog().waitFor({ state: 'detached' });
  const found = (await api('/api/flow?kind=delivery&status=draft')).filter((d) => d.lines.some((l) => l.orderId === order.id));
  if (found.length !== 2 || found.some((d) => d.lines.length !== 1) ||
    [main, branch].some((s) => !found.some((d) => d.siteId === s.id && d.siteName === s.name && d.address === s.address)))
    throw new Error('按厂区拆开的两张送货单内容不对');
  const d = found.find((v) => v.siteId === branch.id);
  await page.goto(BASE + '#warehouse?kind=finished&deliveries=1&doc=' + d.id);
  await panel().getByText('收货厂区', { exact: true }).waitFor();
  await panel().getByText(branch.name, { exact: true }).waitFor();
  await shot('送货详情的收货厂区');
  ok('同一客户两行拆成两张待送货单，详情显示所选厂区');
});

await step('出入库和盘点', async () => {
  const open = async () => {
    await page.goto(BASE + '#warehouse');
    await page.locator('main tbody tr', { hasText: spare.name }).first().click();
    await panel().waitFor();
    await action('出入库 / 盘点');
    await dialog().waitFor();
  };
  const submit = async () => {
    const agree = dialog().locator('.pur-agreement input[type=checkbox]');
    if (await agree.count()) await agree.check();
    await dialog().getByRole('button', { name: '确认库存变动', exact: true }).click();
    await dialog().waitFor({ state: 'detached', timeout: 8000 });
  };
  const before = await balance(spare.id);
  await open();
  await dialog().getByLabel('操作类型').selectOption('in');
  await dialog().getByLabel('本次数量').fill('50');
  await dialog().getByLabel('业务日期').fill(businessDay());
  await dialog().getByLabel('出入库用途 / 盘点原因').fill('虚构补录入库');
  await shot('手动入库');
  await submit();
  const inSaid = await toast(/库存|入库/);
  const afterIn = await balance(spare.id);
  await open();
  await dialog().getByLabel('操作类型').selectOption('adjust');
  await dialog().getByLabel('实盘数量').fill(String(afterIn - 5));
  await dialog().getByLabel('业务日期').fill(businessDay());
  await dialog().getByLabel('出入库用途 / 盘点原因').fill('虚构盘点少了 5 张');
  await shot('盘点调整');
  await submit();
  const adjustSaid = await toast(/盘点|库存/);
  const afterAdjust = await balance(spare.id);
  if (afterIn - before !== 50) fail('手动入库 50 张后余额不对：' + before + ' → ' + afterIn);
  else if (afterAdjust !== afterIn - 5) fail('盘点调整到 ' + (afterIn - 5) + ' 后余额是 ' + afterAdjust);
  else ok(spare.name + ' 手动入库 ' + before + ' → ' + afterIn + '（' + inSaid + '），盘点到 ' + afterAdjust + '（' + adjustSaid + '）');
});

// 已归档的到货单、送货单：详情和在用的同一份，验收 / 入库、出入库流水、明细里的采购单和订单链接都在。看完恢复，后面的流程照旧
await step('已归档的到货单、送货单详情和在用的一样', async () => {
  const archive = (action, doc) =>
    call(page, 'POST', '/flow/batch', { action, acknowledged: true, items: [{ id: doc.id, version: doc.version }] });
  const stocked = (kind) =>
    api('/api/flow?kind=' + kind).then((rows) => rows.find((d) => d.status === 'confirmed' && !d.archived && !d.replacedBy));
  const checks = [
    { kind: 'arrival', hash: '#warehouse?arrivals=1', want: ['验收 / 入库', '入库流水', '到货记录'], link: 'a[href^="#purchases?"]' },
    { kind: 'delivery', hash: '#warehouse?kind=finished&deliveries=1', want: ['出库流水'], link: 'a[href^="#orders?"]' },
  ];
  for (const c of checks) {
    const doc = await stocked(c.kind);
    await archive('archive', doc);
    let text = '',
      links = 0;
    try {
      await page.goto(BASE + c.hash);
      await page.getByRole('tab', { name: '已归档', exact: true }).click();
      await page.locator('main tbody tr', { hasText: doc.number }).first().click();
      // 正文等台账记录读到才显示；等不到就是这一步出错（step 报出来）
      await panel().getByText(c.want[0], { exact: true }).waitFor({ timeout: 8000 });
      text = await panel().innerText();
      links = await panel().locator(c.link).count();
      await shot('已归档' + (c.kind === 'arrival' ? '到货单' : '送货单') + '详情');
    } finally {
      // 不管看没看成都恢复，后面的流程照旧用这张单
      await archive('restore', await api('/api/flow/' + doc.id));
    }
    const missing = c.want.filter((w) => !text.includes(w));
    if (missing.length || !links) fail('已归档的 ' + doc.number + ' 详情缺：' + [...missing, links ? '' : '明细链接'].filter(Boolean).join('、'));
    else ok('已归档的 ' + doc.number + ' 详情有 ' + c.want.join('、') + '和明细链接');
  }
});

const real = [...new Set(consoleErrors)].filter((e) => !/status of (403|409)/.test(e));
if (real.length) fail('控制台报错：' + real.join(' | ').slice(0, 300));
await context.close();
