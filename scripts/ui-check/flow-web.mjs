// 助手联网的过程看得到（照 DeepSeek Harness 的体验）：模型替身先说一句并调搜索 → 正文下面单独一行“正在联网搜索：……”，
// 先说的那句排在上面 → 接着读网页 → 回答出来后上面那句还在，下面有可展开的“来源 N 个”，只给 http、https 的网址做链接、新标签页打开。
// 电脑浅色走一遍，手机宽度（390）深色再走一遍，看新加的三处不超出屏幕。联网结果是 server.mts 的联网替身给的虚构数据。
import { SP, fail, go, login, openAssistant, openChrome } from './lib.mjs';

const query = '瓦楞纸价格 2026';
const read = 'https://example.com/news/' + encodeURIComponent(query) + '/1';
const replies = [
  { message: '我先上网查一下最近的纸价。', toolCalls: [{ name: 'web.search', args: { queries: [query, '箱板纸行情'] } }] },
  { message: '', toolCalls: [{ name: 'web.read', args: { url: read } }] },
  { message: '虚构的回答：本周瓦楞纸价格持平，出自虚构资讯网。', toolCalls: [] },
];

/** 展开后的来源：4 个、只做 https 链接并新标签页打开、读过全文的排最前并标出、小字写真实主机 */
async function checkSourceLinks(last, tag) {
  const links = await last.locator('.ga-sources a').evaluateAll((list) =>
    list.map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel })),
  );
  if (links.length !== 4) fail(tag + '来源链接不是 4 个：' + JSON.stringify(links));
  if (links.some((l) => !/^https:\/\//.test(l.href) || l.target !== '_blank' || l.rel !== 'noopener noreferrer'))
    fail(tag + '来源链接不对：' + JSON.stringify(links));
  if (links[0]?.href !== read) fail(tag + '读过全文的没排在最前：' + links[0]?.href);
  const firstSource = await last.locator('.ga-sources li').first().innerText();
  if (!/已读全文/.test(firstSource)) fail(tag + '读过的没标“已读全文”');
  // 小字写网址的真实主机，不写搜索给的网站名
  if (!firstSource.includes('example.com') || /虚构资讯网/.test(firstSource)) fail(tag + '来源小字没写真实主机：' + firstSource);
}

async function walk({ tag, chrome, dark, mobile }) {
  const { context, page, consoleErrors } = await openChrome(chrome);
  if (dark) await page.emulateMedia({ colorScheme: 'dark' });
  const panel = page.locator('.ga-panel');
  let shots = 0;
  const shot = (label) => (mobile ? page : panel).screenshot({ path: `${SP}/w${tag}${String(++shots).padStart(2, '0')}-${label}.png` });
  /** 面板里超出屏幕右边的元素（手机上看） */
  const overflow = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.ga-panel .ga-status, .ga-panel .ga-interim, .ga-panel .ga-sources, .ga-panel .ga-sources *')]
        .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
        .map((el) => el.className || el.tagName),
    );
  await login(page);
  // 排好模型替身接下来的三次回复：先说一句并搜索、读其中一个网页、给回答
  await page.evaluate(async (list) => fetch('/__ui-check/replies', { method: 'POST', body: JSON.stringify(list) }), replies);
  if (mobile) await go(page, '#dashboard');
  const box = await openAssistant(page, { mobile });
  // 两遍用同一个账号：开新会话，这一遍的断言不会被上一遍留下的消息满足
  const fresh = panel.getByRole('button', { name: '新会话' });
  if (await fresh.isEnabled()) await fresh.click();
  // 回答收到以后页面还要再读一次助手状态：故意放慢它，好看出这段时间里先说的那句有没有显示两遍
  await page.route('**/api/assistant', async (route) => {
    if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const saidText = panel.locator('.ga-interim', { hasText: '我先上网查一下最近的纸价。' });
  const saidBefore = await saidText.count();
  const answers = panel.locator('.ga-message.ga-assistant > .ga-text', { hasText: '虚构的回答' });
  const answersBefore = await answers.count();
  await box.fill('最近瓦楞纸价格走势怎么样');
  await panel.getByRole('button', { name: /发送/ }).first().click();

  // 搜索中：状态行写搜什么，先说的那句在上面、写明是谁说的
  const status = panel.locator('.ga-status');
  await status.filter({ hasText: '正在联网搜索：' + query }).waitFor({ timeout: 8000 }).catch(() => fail(tag + '没看到“正在联网搜索”状态行'));
  const said = await saidText.nth(saidBefore).waitFor({ timeout: 8000 }).then(() => true, () => false);
  if (!said) fail(tag + '搜索时没看到先说的那句');
  else {
    const liveWho = await panel.locator('.ga-message.ga-assistant', { has: page.locator('.ga-interim') }).last().locator('.ga-who').first().innerText();
    if (!/^(小甬|小勒)$/.test(liveWho.trim())) fail(tag + '先说的那句没写是小甬还是小勒：' + liveWho);
  }
  await shot('正在联网搜索');
  await status.filter({ hasText: '正在读网页：example.com/news/' + query }).waitFor({ timeout: 8000 }).catch(() => fail(tag + '没看到“正在读网页”状态行'));
  if ((await overflow()).length) fail(tag + '状态行或先说的那句超出屏幕：' + (await overflow()).join('、'));
  await shot('正在读网页');

  // 回答出来：先说的那句还在、在回答上面；来源默认收起
  // 回答一存下来（还在等页面再读一次助手状态）就数：先说的那句只能多出 1 次
  for (let i = 0; i < 400 && (await answers.count()) === answersBefore; i++) await page.waitForTimeout(50);
  const saidShown = (await saidText.count()) - saidBefore;
  if (saidShown !== 1) fail(tag + '回答出来后先说的那句显示了 ' + saidShown + ' 次');
  await panel.locator('.ga-status').waitFor({ state: 'detached', timeout: 20000 }).catch(() => fail(tag + '20 秒后状态行还在'));
  const last = panel.locator('.ga-message.ga-assistant').last();
  if (!(await last.locator('.ga-text', { hasText: '虚构的回答' }).waitFor({ timeout: 20000 }).then(() => true, () => false))) {
    fail(tag + '20 秒内没等到回答');
    await shot('没等到回答');
    return context.close();
  }
  const order = await last.evaluate((el) => [...el.querySelectorAll('.ga-interim .ga-text, :scope > .ga-text')].map((t) => t.textContent));
  if (order[0] !== '我先上网查一下最近的纸价。' || !/虚构的回答/.test(order[1] ?? '')) fail(tag + '回答后先说的那句不在上面：' + JSON.stringify(order));
  const summary = last.locator('.ga-sources summary');
  const sources = await summary.innerText({ timeout: 8000 }).catch(() => '（没有来源）');
  if (sources !== '来源 4 个') fail(tag + '来源个数不对：' + sources);
  if (await last.locator('.ga-sources ol').isVisible()) fail(tag + '来源默认应收起');
  await shot('回答和来源收起');
  await summary.click();
  await checkSourceLinks(last, tag);
  await last.locator('.ga-sources').scrollIntoViewIfNeeded();
  if ((await overflow()).length) fail(tag + '来源列表超出屏幕：' + (await overflow()).join('、'));
  await shot('来源展开');
  await page.unroute('**/api/assistant');
  console.log(tag + '联网过程：状态行、先说的那句、来源 ok');

  const real = [...new Set(consoleErrors)].filter((e) => !/status of (401|403|404|409|422|429|503)/.test(e));
  if (real.length) fail(tag + '控制台报错 ' + real.join(' | ').slice(0, 300));
  await context.close();
}

await walk({ tag: '电脑', chrome: { width: 1440, height: 900 } });
await walk({
  tag: '手机深色',
  chrome: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  dark: true,
  mobile: true,
});
