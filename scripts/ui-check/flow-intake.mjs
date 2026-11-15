// 收件箱和 AI 导入点到底：文字消息标为已处理、再恢复待处理；文件“转订单”进 AI 导入；
// 识别好的虚构客户订单改一格数量后导入订单，订单列表多一张、金额按改过的算。全部虚构数据（server.mts 造的）。
import { BASE, SP, fail, login, notice, ok, openChrome, step as stepOn } from './lib.mjs';
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
const dialog = () => page.locator('[role="dialog"][aria-modal="true"]').last();
const panel = () => page.locator('.detail-panel');
let shots = 0;
const shot = (label) => page.screenshot({ path: `${SP}/i${String(++shots).padStart(2, '0')}-${label}.png` });
const api = (path) => page.evaluate(async (p) => (await fetch(p)).json(), path);
const step = (name, fn) => stepOn(page, name, fn);
const toast = (pattern) => notice(page, pattern);
const inbox = async (status) => (await api('/api/inbox?status=' + status)).rows || [];
const tab = (name) => page.getByRole('region', { name: '收件箱筛选' }).getByRole('button', { name: new RegExp('^' + name) });
await login(page);

await step('收件箱标为已处理再恢复', async () => {
  const text = '客户电话：月底对账单已发，请核对。';
  const pending = (await inbox('pending')).length;
  await page.goto(BASE + '#inbox');
  await page.getByRole('button', { name: '查看 ' + text }).click();
  await panel().getByRole('button', { name: '标为已处理', exact: true }).click();
  const done = await toast('已标为已处理');
  await tab('已处理 1').waitFor({ timeout: 8000 });
  await shot('标为已处理');
  if ((await inbox('pending')).length !== pending - 1 || !(await inbox('converted')).some((r) => r.text === text))
    fail('标为已处理后这条没从待处理挪到已处理');
  else ok('收件箱标为已处理：' + done);
  await tab('已处理').click();
  await page.getByRole('button', { name: '查看 ' + text }).click();
  await panel().getByRole('button', { name: '恢复待处理', exact: true }).click();
  const back = await toast('已恢复到待处理');
  await tab('待处理 ' + pending).waitFor({ timeout: 8000 });
  if ((await inbox('pending')).length !== pending) fail('恢复待处理后待处理不是 ' + pending + ' 条');
  else ok('收件箱恢复待处理：' + back);
});

await step('收件箱文件转订单', async () => {
  // 用种子里那张真的 PNG（11月采购单.xlsx 的内容不是真表格，服务端会拒收）
  const name = '手写订单照片.png';
  const before = ((await api('/api/ai/imports')).workspaces || []).length;
  await page.goto(BASE + '#inbox');
  await tab('待处理').click(); // 上一步停在“已处理”页签，页面记着
  await page.getByRole('button', { name: '查看 ' + name }).click();
  await panel().getByRole('button', { name: '转订单', exact: true }).click();
  await page.waitForURL(/#ai-import\?workspace=/, { timeout: 8000 });
  const id = new URLSearchParams(page.url().split('?')[1]).get('workspace');
  const files = (await api('/api/ai/imports')).workspaces || [];
  const item = (await inbox('converted')).find((r) => r.fileName === name);
  await page.getByText(name).first().waitFor({ timeout: 8000 });
  await shot('转订单到 AI 导入');
  if (files.length !== before + 1 || !files.some((w) => w.id === id && w.fileName === name)) fail('转订单后 AI 导入里没有这份文件');
  else if (!item || item.convertedRef !== id) fail('转订单后收件箱这条没标成已处理、没记下去了哪个导入任务');
  else ok('收件箱文件转订单：进了 AI 导入，收件箱这条已处理');
});

await step('AI 导入改一格后导入订单', async () => {
  const workspace = ((await api('/api/ai/imports')).workspaces || []).find((w) => w.fileName === '虚构客户订单.png');
  if (!workspace) throw new Error('种子里没有识别好的虚构客户订单');
  const before = await api('/api/orders');
  await page.goto(BASE + '#ai-import?workspace=' + workspace.id);
  const quantity = page.getByLabel('明细1 数量', { exact: true });
  await quantity.waitFor({ timeout: 10000 });
  // 第 1 行数量 100 → 120：导入时先存下这处修改，合计 120×1.2345 + 100×1.2345 = 148.14 + 123.45
  await quantity.fill('120');
  await page.getByRole('button', { name: '导入订单', exact: true }).first().click();
  await dialog().waitFor();
  const total = await dialog().locator('tr', { hasText: '合计' }).last().innerText();
  await shot('导入预览');
  if (!total.includes('271.59')) fail('导入预览的合计没按改过的数量算：' + total.replace(/\s+/g, ' '));
  await dialog().getByRole('button', { name: '导入订单', exact: true }).click();
  await dialog().waitFor({ state: 'detached', timeout: 10000 });
  const link = page.getByRole('link', { name: /^查看订单 / });
  await link.waitFor({ timeout: 8000 });
  const after = await api('/api/orders');
  const order = after.find((o) => !before.some((b) => b.id === o.id));
  await shot('导入之后');
  if (!order) fail('导入后订单列表没有多一张');
  else if (order.customerName !== '聊天验收客户' || order.totalCents !== 27159 || order.lines.length !== 2 || order.lines[0].quantity !== 120)
    fail('导入的订单不对：' + JSON.stringify({ customer: order.customerName, total: order.totalCents, lines: order.lines.map((l) => [l.productName, l.quantity]) }));
  else if (!(await link.innerText()).includes(order.number)) fail('导入后“查看订单”不是这张：' + (await link.innerText()));
  else ok('AI 导入改一格后导入订单 ' + order.number + '：合计 271.59，两行，第 1 行 120 只');
});

// 上传一份虚构订单图片，模型替身放慢回复（server.mts 的 slowRecognitions）：识别进度先“等 AI 读文件”、
// 再“AI 正在填写”一步步出来，最后出识别结果（明细数量 100）
await step('上传后流式识别', async () => {
  await page.goto(BASE + '#ai-import');
  await page.evaluate(() => fetch('/__ui-check/replies', { method: 'POST', body: JSON.stringify([{ recognition: { chunkDelayMs: 900 } }]) }));
  // 种子里那张 1×1 的 PNG，后面接一段虚构字样，和已有的文件内容不同
  const png = Buffer.concat([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64'),
    Buffer.from('虚构流式识别 ' + Date.now()),
  ]);
  await page.getByLabel('上传订单文件').setInputFiles({ name: '虚构流式识别订单.png', mimeType: 'image/png', buffer: png });
  // 上传只存原件；选中这份、点“开始识别”才发给 AI
  await page.getByRole('button', { name: /虚构流式识别订单\.png/ }).click();
  await page.getByRole('button', { name: '开始识别', exact: true }).click();
  const progress = page.locator('.aii-progress');
  const quantity = page.getByLabel('明细1 数量', { exact: true });
  const seen = [];
  for (const until = Date.now() + 30000; Date.now() < until; await page.waitForTimeout(200)) {
    const text = await progress.first().innerText().catch(() => '');
    const stage = text.split(' · ')[0];
    if (stage && seen.at(-1) !== stage) {
      seen.push(stage);
      if (stage === 'AI 正在填写') await shot('流式识别进度');
    }
    if (!text && (await quantity.count())) break;
  }
  await quantity.waitFor({ timeout: 10000 });
  await shot('流式识别结果');
  if (!seen.includes('等 AI 读文件') || !seen.includes('AI 正在填写') || seen.indexOf('等 AI 读文件') > seen.indexOf('AI 正在填写'))
    fail('识别进度没有一步步出来：' + (seen.join(' → ') || '（没看到进度）'));
  else if ((await quantity.inputValue()) !== '100') fail('流式识别的结果不对：明细1 数量 ' + (await quantity.inputValue()));
  else ok('上传后流式识别：' + seen.join(' → ') + ' → 识别结果');
});

const real = [...new Set(consoleErrors)].filter((e) => !/status of (403|409)/.test(e));
if (real.length) fail('控制台报错：' + real.join(' | ').slice(0, 300));
await context.close();
