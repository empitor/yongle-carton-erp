// 成品库存详情里的完工批次：块的样式和内容、批次备注事后补写和修改（含手机宽度）。和 production 同一组、同一个实例。
import { BASE, SP, fail, login, ok, openChrome, step as stepOn } from './lib.mjs';
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
const dialog = () => page.locator('[role="dialog"][aria-modal="true"]').last();
let shots = 0;
const shot = (label) => page.screenshot({ path: `${SP}/b${String(++shots).padStart(2, '0')}-${label}.png` });
const open = async (hash) => {
  await page.goto(BASE + hash);
  await page.locator('main tbody tr').first().waitFor();
};
const api = (path) => page.evaluate(async (p) => (await fetch(p)).json(), path);
const step = (name, fn) => stepOn(page, name, fn);
await login(page);

// 成品库存详情里按每次完工分批：一批一块上下排开，常显说明，备注全文，已发完的收起，不横向滚动
/** 第一个还有货的完工批次所在的成品：{ it 库存品, b 批次接口的结果 } */
const findOpenBatch = async () => {
  const items = await api('/api/warehouse/items?kind=finished');
  for (const it of items) {
    const b = await api('/api/flow/stock-batches/' + it.id);
    if (b.open?.length) return { it, b };
  }
  return null;
};
/** 说明常显、块数对、头部两行（单号是链接、字比日期小）；返回 { blocks, head } */
const checkBatchHead = async (section, target) => {
  const note = await section.locator('.pur-batch-note').innerText();
  if (!/每次完工入库算一批/.test(note)) fail('批次说明没有常显：' + note);
  // 还有货的块（不算收起的“估计已发完”里的）
  const blocks = await section.locator('.pur-batch').evaluateAll((els) => els.filter((e) => !e.closest('details')).length);
  if (blocks !== target.b.open.length) fail('还有货的批次块数 ' + blocks + '，接口给了 ' + target.b.open.length);
  // 头部两行：“日期 完工 · 完工单号”（单号是链接、字比日期小），“入库 N 只 · 估计还剩 N 只”
  const head = await section.locator('.pur-batch > header').first().innerText();
  if (!/^\d{4}-\d{2}-\d{2}\s*完工\s*·\s*DJ-/.test(head)) fail('批次头部第一行不是“日期 完工 · 完工单号”：' + head);
  if (!/入库\s*[\d.]+\s*只\s*·\s*估计还剩/.test(head)) fail('批次头部第二行不是“入库 N 只 · 估计还剩 N 只”：' + head);
  const numberLink = section.locator('.pur-batch > header a.pur-batch-number').first();
  if (!(await numberLink.count())) fail('完工单号不在头部或不是链接');
  else {
    const [dateSize, numberSize] = [
      await section.locator('.pur-batch-date').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      await numberLink.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ];
    if (!(numberSize < dateSize)) fail('完工单号的字不比日期小：' + numberSize + ' / ' + dateSize);
  }
  return { blocks, head };
};
// 下面不再重复“完工单”“入库”两行；只有生产任务、订单、用料、操作人、批次备注，没有内容的行不占位
const checkBatchRows = async (section) => {
  const labels = await section.locator('.pur-batch').first().locator('dt').allInnerTexts();
  if (labels.some((l) => /^(完工单|入库)$/.test(l.trim()))) fail('块里还在重复“完工单 / 入库”：' + labels.join('、'));
  if (labels.some((l) => !['生产任务', '订单', '用料', '操作人', '批次备注'].includes(l.trim()))) fail('完工批次多了别的行：' + labels.join('、'));
  const emptyRows = await section.locator('.pur-batch dd').evaluateAll((els) => els.filter((e) => !e.textContent.trim()).length);
  if (emptyRows) fail('有 ' + emptyRows + ' 行没有内容还占着位置');
};
// 每批一块浅灰底圆角块，块之间有间距，不靠细线分；单号是链接色；值一列和别的节对齐
const checkBatchLook = async (section, blocks) => {
  const look = await section.locator('.pur-batch').first().evaluate((el) => {
    const s = getComputedStyle(el),
      list = getComputedStyle(el.parentElement);
    return { bg: s.backgroundColor, radius: parseFloat(s.borderTopLeftRadius), border: s.borderTopWidth, gap: parseFloat(list.rowGap) || 0 };
  });
  if (/rgba?\(0, 0, 0, 0\)|transparent/.test(look.bg) || !look.radius) fail('批次块没有浅底圆角：' + JSON.stringify(look));
  if (parseFloat(look.border)) fail('批次块不该再靠细线分：' + look.border);
  if (blocks > 1 && look.gap < 4) fail('批次块之间没有留空：' + look.gap);
  // 单号是链接色，和正文颜色不一样
  const colors = await section.locator('.pur-batch').first().evaluate((el) => {
    const a = el.querySelector('dd a'),
      dd = [...el.querySelectorAll('dd')].find((d) => !d.querySelector('a'));
    return { link: a && getComputedStyle(a).color, text: dd && getComputedStyle(dd).color };
  });
  if (!colors.link || colors.link === colors.text) fail('批次里的单号看不出是链接：' + JSON.stringify(colors));
  // 字段名一列和“库存”等节的字段名对齐（值那一列左边缘相差不超过 2px）
  const facts = page.locator('.detail-panel .record-facts dd').first();
  if (await facts.count()) {
    const [x1, x2] = [await facts.evaluate((el) => el.getBoundingClientRect().left), await section.locator('.pur-batch dd').first().evaluate((el) => el.getBoundingClientRect().left)];
    if (Math.abs(x1 - x2) > 2) fail('批次的值一列和别的节没对齐：' + x1 + ' / ' + x2);
  }
};
// 用料：主行“名称 · N 张”，数量不在中间断行；不再出现“× N 张”
const checkMaterial = async (section) => {
  const material = section.locator('.pur-batch-material').first();
  if (await material.count()) {
    const text = await material.innerText();
    if (!/ · \d[\d.]* 张$/.test(text) || /×\s*\d[\d.]*\s*张/.test(text)) fail('用料主行不是“名称 · N 张”：' + text);
  }
};
// 其他入库另起一组：在完工批次后面、有小标题“其他入库”，块是白底细边、标签中性色，和完工批次分得开
const checkOtherStock = async (section) => {
  if (await section.locator('.pur-batches').first().locator(':scope > .pur-batch.is-other').count() && (await section.locator('.pur-batch:not(.is-other)').count()))
    fail('其他入库和完工批次混在一组里');
  const other = section.locator('.pur-batch.is-other').first();
  if (await other.count()) {
    const heading = await section.locator('.pur-batches-group').first().innerText().catch(() => '');
    if (heading.trim() !== '其他入库') fail('其他入库那一组没有小标题：' + heading);
    const batchBg = await section.locator('.pur-batch:not(.is-other)').first().evaluate((el) => getComputedStyle(el).backgroundColor),
      otherLook = await other.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, border: parseFloat(getComputedStyle(el).borderTopWidth) }));
    if (otherLook.bg === batchBg || !otherLook.border) fail('其他入库的块和完工批次一个样子：' + JSON.stringify(otherLook));
    const otherHead = await other.locator('header').innerText();
    if (/完工/.test(otherHead) || !/^\d{4}-\d{2}-\d{2}\s*\S/.test(otherHead)) fail('其他入库头部没直接写类型：' + otherHead);
    if (await other.locator('.status-chip.tone-accent').count()) fail('其他入库的标签不该用强调色');
  }
};
// 估计已发完的收起；展开后整块用次要色，和还有货的区分开
const checkDoneBatches = async (section) => {
  const done = section.locator('details.pur-batches-done');
  if (await done.count()) {
    const summary = await done.locator('summary').innerText();
    if (!/^估计已发完的 \d+ 批/.test(summary.trim())) fail('收起标题不是“估计已发完的 N 批”：' + summary);
    await done.locator('summary').click();
    const [oldColor, liveColor] = [
      await done.locator('.pur-batch-date').first().evaluate((el) => getComputedStyle(el).color),
      await section.locator('.pur-batches').first().locator('.pur-batch-date').first().evaluate((el) => getComputedStyle(el).color),
    ];
    if (oldColor === liveColor) fail('估计已发完的批次和还有货的颜色一样');
    const oldBg = await done.locator('.pur-batch:not(.is-other)').first().evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => ''),
      liveBg = await section.locator('.pur-batch:not(.is-other)').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    if (oldBg && oldBg === liveBg) fail('估计已发完的批次和还有货的底色一样');
    if (!/估计已发完/.test(await done.locator('.pur-batch > header').first().innerText())) fail('已发完的标签不是“估计已发完”');
    await done.locator('summary').click();
  }
};
await step('成品批次', async () => {
  const target = await findOpenBatch();
  if (!target) return fail('预览数据里没有还有货的完工批次');
  await open('#warehouse?kind=finished');
  await page.locator('main tbody tr', { hasText: target.it.name }).first().click();
  const section = page.locator('.detail-panel .record-section', { has: page.locator('h3', { hasText: /^批次$/ }) });
  await section.locator('.pur-batch').first().waitFor({ timeout: 5000 });
  const { blocks, head } = await checkBatchHead(section, target);
  await checkBatchRows(section);
  await checkBatchLook(section, blocks);
  await checkMaterial(section);
  await checkOtherStock(section);
  await checkDoneBatches(section);
  if (await section.locator('table').count()) fail('批次里不该用多列表格');
  const link = section.locator('.pur-batch a[href*="view=production&doc="]').first();
  if (!(await link.count())) fail('批次里没有能点开的完工单号');
  const wide = await page.locator('.detail-panel').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  if (wide) fail('详情面板出现横向滚动');
  else ok('成品详情里能看到 ' + blocks + ' 批：' + head.replace(/\s+/g, ' '));
  await shot('成品批次');
});

// 批次备注事后补写、修改：完工批次有“写备注 / 编辑备注”文字按钮（其他入库没有），小窗口一个实心主按钮，
// 保存后窗口关闭、批次刷新、页面提示；手机宽度下窗口不横向滚动
await step('批次备注', async () => {
  const section = page.locator('.detail-panel .record-section', { has: page.locator('h3', { hasText: /^批次$/ }) });
  await section.locator('.pur-batch').first().waitFor({ timeout: 5000 });
  if (await section.locator('.pur-batch.is-other .pur-batch-note-edit').count())
    fail('其他入库不该有备注入口');
  const button = section.locator('.pur-batch-note-edit').first();
  if (!(await button.count())) return fail('完工批次里没有“写备注 / 编辑备注”');
  const label = (await button.innerText()).trim();
  if (!['写备注', '编辑备注'].includes(label)) fail('备注按钮叫法不对：' + label);
  if (await button.evaluate((el) => el.classList.contains('primary'))) fail('备注按钮不该是实心按钮');
  await button.click();
  const d = dialog();
  await d.waitFor();
  const box = d.getByRole('textbox', { name: '批次备注' });
  const placeholder = await box.getAttribute('placeholder');
  if (placeholder !== '这批用的什么料、质量怎样') fail('备注框占位文字不对：' + placeholder);
  const primaries = await d.locator('button.primary').count();
  if (primaries !== 1) fail('备注窗应只有一个实心主按钮，现在 ' + primaries);
  const text = '界面检查：这批压线偏浅 ' + Date.now();
  await box.fill(text);
  await shot('批次备注窗');
  const before = (await page.locator('.toast, .success-banner').allInnerTexts()).join(' | ');
  await d.getByRole('button', { name: '保存', exact: true }).click();
  await d.waitFor({ state: 'detached' });
  await section.locator('.pur-batch-notes-text', { hasText: text }).first().waitFor({ timeout: 5000 });
  let notice = '';
  for (let i = 0; i < 50 && (!notice || notice === before); i++) {
    notice = (await page.locator('.toast, .success-banner').allInnerTexts()).join(' | ');
    if (!notice || notice === before) await page.waitForTimeout(100);
  }
  if (!/完工单 .* 已保存/.test(notice)) fail('保存后没有页面提示：' + notice);
  const again = section.locator('.pur-batch', { has: page.locator('.pur-batch-notes-text', { hasText: text }) }).locator('.pur-batch-note-edit');
  if ((await again.innerText()).trim() !== '编辑备注') fail('有备注以后按钮应叫“编辑备注”');
  // 备注和“编辑备注”之间、块的底部不空出一截（量文字本身的位置，按钮在手机上为了好点按是 44px 高）
  const spacing = async () =>
    again.evaluate((button) => {
      const block = button.closest('.pur-batch'),
        notes = block.querySelector('.pur-batch-notes-text'),
        range = document.createRange();
      range.selectNodeContents(button);
      const label = range.getBoundingClientRect(),
        padding = parseFloat(getComputedStyle(block).paddingBottom);
      return { gap: label.top - notes.getBoundingClientRect().bottom, tail: block.getBoundingClientRect().bottom - label.bottom - padding };
    });
  const desk = await spacing();
  if (desk.gap > 8 || desk.tail > 8) fail('备注和“编辑备注”之间或块底部空太多（电脑）：' + JSON.stringify(desk));
  else ok('批次备注已保存并显示：' + notice);
  await shot('批次备注已保存');
  // 手机宽度：底部弹层里输入框和按钮放得下，不横向滚动
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await spacing();
  if (phone.gap > 8 || phone.tail > 8) fail('备注和“编辑备注”之间或块底部空太多（手机）：' + JSON.stringify(phone));
  // 手机上订单行：单号不被拆开
  const split = await page.locator('.pur-batch-order > a').evaluateAll((els) => els.filter((a) => a.getClientRects().length > 1).length);
  if (split) fail('手机上有 ' + split + ' 个订单号被拆成两行');
  await again.click();
  await dialog().waitFor();
  const wide = await dialog().evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  if (wide) fail('手机宽度下备注窗出现横向滚动');
  await shot('批次备注窗-手机');
  await dialog().getByRole('button', { name: '取消' }).click();
  await dialog().waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 1440, height: 900 });
});

if (consoleErrors.length) fail('控制台报错：' + consoleErrors.join(' | ').slice(0, 300));
await context.close();
