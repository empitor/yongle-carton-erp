// 安卓 App 通道（src/app-bridge.ts，消息约定见 docs/架构/外壳和网页.md“安卓 App 通道”）：手机宽度、带 App 标记的 User-Agent 下模拟 App 发来的消息。
// 一、没登录时先接通、发分享（真实 App 页面一加载完就接通）不回话；登录（页面重新加载）后 App 重新接通、重发清单，
//     这回自动到 AI 导入、回 share-ready，文件进工作区待识别、不自动识别，传完提示换成总结；
//     几 MB 的虚构文件照样传上去（打印用时），清单里超过上限（10MB）的不解码、直接回 share-failed；
// 二、返回键按层级：今日回 home，筛选浮层开着只关浮层，附属窗口 → 原订单 → 订单列表 → 今日，库存弹窗 → 原库存详情，独立业务页 → 今日；
//     开着窗口时收到分享先提醒（不压住窗口的标题栏和底栏、不带对勾）、窗口都关了再进 AI 导入并换成“正在传”；手机上助手带去别的页时收起；
// 三、导出订货单经通道交给 App 保存：App 回没存成时窗口里说原因、采购单不变，回存好了才变待到货；
// 四、顶栏跟着滚动收起，滑到顶再往下拉只拉伸内容区；
// 五、纯财务账号收到分享回 share-rejected、不跳页；没有 App 标记的浏览器不接通。虚构数据。
import { BASE, SP, call, checkConsole, dialogOf, fail, go, login, notice, ok, openAssistant, openChrome, signIn, step } from './lib.mjs';

const HELLO = '{"type":"erp-app-bridge","version":1}';
const phone = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const APP_UA = 'Mozilla/5.0 (Linux; Android 16; V2359A) AppleWebKit/537.36 Chrome/156.0 Mobile Safari/537.36 YongleErpAndroid/0.1.0';
const MIB = 1024 * 1024;

/**
 * 像 App 一样接通：发接通消息带一个端口，App 那头的端口和收到的话挂在 window.__app 上。
 * 收到 save-file 时按 window.__app.saveAs 回 save-result（没设就不回）；记下的 save-file 只留内容长度。
 */
const connect = (page) =>
  page.evaluate((hello) => {
    const channel = new MessageChannel(),
      app = { port: channel.port1, got: [], saveAs: null };
    channel.port1.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type !== 'save-file') return void app.got.push(m);
      app.got.push({ ...m, data: m.data.length });
      if (app.saveAs) channel.port1.postMessage(JSON.stringify({ type: 'save-result', id: m.id, ...app.saveAs }));
    };
    window.__app = app;
    window.dispatchEvent(new MessageEvent('message', { data: hello, ports: [channel.port2] }));
  }, HELLO);
const got = (page) => page.evaluate(() => window.__app?.got ?? []);
const send = (page, message) => page.evaluate((m) => window.__app.port.postMessage(JSON.stringify(m)), message);
/** 等 App 那头收到某种话（types 用 | 分开几种，filter 再挑一挑），返回最后一条；每轮等 100 毫秒，最多 tries 轮 */
async function waitFor(page, types, filter = () => true, tries = 50) {
  for (let i = 0; i < tries; i++) {
    const hit = (await got(page)).filter((m) => types.split('|').includes(m.type) && filter(m)).at(-1);
    if (hit) return hit;
    await page.waitForTimeout(100);
  }
  throw new Error('App 没收到 ' + types);
}
let backId = 0;
/** 按一次返回，返回网页的回答（handled / home） */
async function back(page) {
  const id = ++backId;
  await send(page, { type: 'back', id });
  const reply = await waitFor(page, 'back-result', (m) => m.id === id);
  await page.waitForTimeout(400);
  return reply.result;
}
const hash = (page) => page.evaluate(() => location.hash);
const dialogShown = (page) => page.locator('[role="dialog"][aria-modal="true"]').isVisible().catch(() => false);
const detailShown = (page) => page.locator('.detail-panel').isVisible().catch(() => false);
/** 按一次返回，查网页的回答和按完后的样子（弹窗、详情开没开，在哪一页） */
async function expectBack(page, label, want) {
  const now = { result: await back(page), dialog: await dialogShown(page), detail: await detailShown(page), hash: await hash(page) };
  const wrong = Object.keys(want).filter((k) => (k === 'hash' ? !now.hash.startsWith(want.hash) : now[k] !== want[k]));
  if (wrong.length) fail(label + '：按返回后 ' + JSON.stringify(now));
  else ok(label);
}
/** 一份虚构 PDF：大约 size 字节（用注释行垫大），给出实际字节数和 base64 */
function fakePdf(label, size = 0) {
  const pad = ('%' + '0'.repeat(78) + '\n').repeat(Math.ceil(size / 80));
  const bytes = Buffer.from('%PDF-1.4\n% ' + label + '\n' + pad + '%%EOF\n');
  return { size: bytes.length, data: bytes.toString('base64') };
}
const offer = (shareId, name, size) => ({ type: 'share-offer', shareId, files: [{ name, mime: 'application/pdf', size }] });
const ofShare = (shareId) => (m) => m.shareId === shareId;
const shot = (page, label) => page.screenshot({ path: SP + '/app-' + label + '.png' });

const { context, page, consoleErrors } = await openChrome({ ...phone, userAgent: APP_UA });
await page.goto(BASE);
await page.locator('.login-screen input').first().waitFor();
await connect(page);

await step(page, '没登录时收到分享', async () => {
  await waitFor(page, 'bridge-ready');
  const pdf = fakePdf('ui-check 虚构分享文件');
  await send(page, offer('share-1', '虚构分享订单.pdf', pdf.size));
  await page.waitForTimeout(800);
  if ((await got(page)).some(ofShare('share-1'))) fail('还没登录就回了分享的话');
  // 登录后页面会重新加载；App 在页面加载完（这时登录状态多半还在读）就重新接通、重发这批的清单
  await signIn(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await connect(page);
  await waitFor(page, 'bridge-ready');
  await send(page, offer('share-1', '虚构分享订单.pdf', pdf.size));
  await waitFor(page, 'share-ready', ofShare('share-1'));
  if (!(await hash(page)).startsWith('#ai-import')) fail('登录后应自动打开 AI 导入');
  await send(page, { type: 'share-file', shareId: 'share-1', index: 0, data: pdf.data });
  const result = await waitFor(page, 'share-uploaded|share-failed', ofShare('share-1'));
  await page.getByText('虚构分享订单.pdf').first().waitFor();
  const row = page.locator('.oi-left').getByText('待识别').first();
  if (result.type !== 'share-uploaded') fail('分享的文件没传上：' + result.message);
  else if (!(await row.isVisible().catch(() => false))) fail('分享的文件应在工作区显示待识别');
  else ok('没登录时收到分享，登录后进 AI 导入、文件待识别（duplicate=' + result.duplicate + '）');
  // 传完了，“正在传”那句换成总结，不和页面上“已保存原件”打架
  const summary = await notice(page, '已传进 AI 导入');
  await shot(page, '分享传完后的提示');
  if (!summary.startsWith('分享的 1 份文件已传进')) fail('分享传完后提示没换成总结：' + summary);
  else ok('分享传完后提示换成：' + summary);
});

await step(page, '几 MB 的分享文件和超过上限的', async () => {
  const pdf = fakePdf('ui-check 虚构大文件', 3 * MIB);
  await send(page, offer('share-2', '虚构大文件.pdf', pdf.size));
  await waitFor(page, 'share-ready', ofShare('share-2'));
  const started = Date.now();
  await send(page, { type: 'share-file', shareId: 'share-2', index: 0, data: pdf.data });
  const result = await waitFor(page, 'share-uploaded|share-failed', ofShare('share-2'), 300);
  if (result.type !== 'share-uploaded') fail('几 MB 的分享文件没传上：' + result.message);
  else ok((pdf.size / MIB).toFixed(1) + 'MB 的分享文件解码、上传用了 ' + (Date.now() - started) + 'ms');
  // 上限从 AI 导入的状态接口读（服务端 ORIGINAL_MAX_MB；流程脚本用普通 node 跑，引不了 .ts 里的常量）
  const maxMb = (await call(page, 'GET', '/ai/imports')).limits.maxFileMB;
  await send(page, offer('share-3', '虚构超大.pdf', maxMb * MIB + 1));
  await waitFor(page, 'share-ready', ofShare('share-3'));
  // 内容故意给一小段：清单上超了就不该解码、不该上传
  await send(page, { type: 'share-file', shareId: 'share-3', index: 0, data: 'AA==' });
  const refused = await waitFor(page, 'share-uploaded|share-failed', ofShare('share-3'));
  if (refused.type !== 'share-failed' || !refused.message.includes(maxMb + 'MB')) fail('超过上限的应直接回 share-failed：' + JSON.stringify(refused));
  else ok('清单里超过 ' + maxMb + 'MB 的不上传，回 share-failed：' + refused.message);
});

await step(page, '今日回首页', async () => {
  await go(page, '#dashboard');
  await expectBack(page, '今日按返回告诉 App 已在首页', { result: 'home', hash: '#dashboard' });
});

await step(page, '筛选浮层', async () => {
  await go(page, '#orders');
  await page.getByRole('button', { name: '筛选', exact: true }).tap();
  const filters = page.getByRole('dialog', { name: '筛选条件' });
  await filters.waitFor();
  const box = await filters.boundingBox(),
    margins = [box.x, phone.width - box.x - box.width].map(Math.round);
  if (margins[0] !== margins[1]) fail('手机上筛选浮层左右边距不一样：' + margins.join(' / '));
  await shot(page, '筛选浮层');
  const result = await back(page);
  const still = await filters.isVisible().catch(() => false);
  if (result !== 'handled' || still || !(await hash(page)).startsWith('#orders')) fail('筛选浮层开着按返回应只关浮层：' + result + ' ' + still);
  else ok('筛选浮层开着按返回只关浮层，还在订单页');
});

await step(page, '订单附属窗口', async () => {
  await go(page, '#orders');
  await page.locator('table.m-cards tr.record-row').first().tap();
  await page.locator('.detail-panel').waitFor();
  // 叠在订单详情上的窗口（“编辑”是换掉详情打开编辑窗，× 回列表，不算叠层）
  await page.locator('.detail-panel').getByRole('button', { name: /^(安排订料|安排生产|安排送货)$/ }).first().tap();
  await dialogOf(page).waitFor();
  await expectBack(page, '附属窗口 → 原订单', { result: 'handled', dialog: false, detail: true });
  await expectBack(page, '订单详情 → 订单列表', { result: 'handled', detail: false, hash: '#orders' });
  await expectBack(page, '订单页 → 今日', { result: 'handled', hash: '#dashboard' });
});

await step(page, '库存编辑', async () => {
  await go(page, '#warehouse');
  await page.locator('table.m-cards tr.record-row').first().tap();
  await page.locator('.detail-panel').waitFor();
  await page.locator('.detail-panel').getByRole('button', { name: /出入库|盘点|编辑/ }).first().tap();
  await dialogOf(page).waitFor();
  await expectBack(page, '库存编辑 → 原库存详情', { result: 'handled', dialog: false, detail: true });
});

/** 提示条压没压住最上面那个窗口的标题栏、底栏；图标是不是提醒（i）而不是对勾 */
const toastPlace = (page) =>
  page.evaluate(() => {
    const toast = document.querySelector('.toast'),
      box = toast?.getBoundingClientRect(),
      dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1);
    const bars = [dialog?.querySelector('.modal-head'), dialog?.querySelector('.editor-footer')].filter(Boolean);
    const covered = bars.some((bar) => {
      const r = bar.getBoundingClientRect();
      return box && box.top < r.bottom && box.bottom > r.top;
    });
    return { covered, icon: toast?.querySelector('svg')?.getAttribute('class') ?? '' };
  });
// 上一步留着库存详情（一层），再打开编辑窗（第二层）：收到分享先提醒、不跳页，提醒不压住窗口的标题栏和底栏、不带对勾；
// 两层都关掉后再进 AI 导入，提醒换成“正在传”
await step(page, '开着窗口时收到分享', async () => {
  await page.locator('.detail-panel').getByRole('button', { name: /出入库|盘点|编辑/ }).first().tap();
  await dialogOf(page).waitFor();
  await send(page, offer('share-4', '虚构窗口外分享.pdf', 40));
  const said = await notice(page, '关掉当前窗口后进入 AI 导入');
  await shot(page, '开着窗口时收到分享');
  const place = await toastPlace(page);
  if (!(await hash(page)).startsWith('#warehouse')) fail('开着窗口时收到分享不该马上跳页：' + (await hash(page)));
  else if (place.covered) fail('提醒压住了窗口的标题栏或底栏');
  else if (!place.icon.includes('lucide-info')) fail('等窗口的提醒不该带对勾：' + place.icon);
  else ok('开着窗口时收到分享先提醒，不压住窗口的标题栏和底栏：' + said);
  await expectBack(page, '关掉编辑窗，还开着详情不跳页', { result: 'handled', dialog: false, detail: true, hash: '#warehouse' });
  await expectBack(page, '再关掉详情后进入 AI 导入', { result: 'handled', detail: false, hash: '#ai-import' });
  const moved = await notice(page, '传进 AI 导入');
  await shot(page, '跳到 AI 导入后的提醒');
  if (moved.includes('关掉当前窗口')) fail('跳到 AI 导入后提醒没换：' + moved);
  else ok('跳到 AI 导入后提醒换成：' + moved);
  await waitFor(page, 'share-ready', ofShare('share-4'));
});

await step(page, '独立业务页', async () => {
  await go(page, '#purchases');
  await expectBack(page, '独立业务页 → 今日', { result: 'handled', hash: '#dashboard' });
  await expectBack(page, '今日再按 → 交给 App 提示退出', { result: 'home', hash: '#dashboard' });
});

await step(page, '导出订货单交给 App 保存', async () => {
  const purchase = (await call(page, 'GET', '/purchases')).find((p) => p.businessStatus === '待订货');
  if (!purchase) throw new Error('种子里没有待订货的采购单');
  const status = async () => (await call(page, 'GET', '/purchases')).find((p) => p.id === purchase.id).businessStatus;
  const saveAs = (reply) => page.evaluate((r) => (window.__app.saveAs = r), reply);
  await go(page, '#purchases?record=' + purchase.id);
  await page.locator('.detail-panel').getByRole('button', { name: '导出订货单', exact: true }).tap();
  const dialog = dialogOf(page);
  await dialog.waitFor();
  await saveAs({ ok: false, message: '虚构：手机存储空间不够，没有保存。' });
  await dialog.getByRole('button', { name: '导出订货单', exact: true }).tap();
  await dialog.getByText('虚构：手机存储空间不够').waitFor({ timeout: 15000 });
  await shot(page, '保存没成');
  if ((await status()) !== '待订货') fail('App 没存成，采购单却变了：' + (await status()));
  else ok('App 回没存成：窗口里说原因，采购单 ' + purchase.number + ' 还是待订货');
  await saveAs({ ok: true });
  await dialog.getByRole('button', { name: '导出订货单', exact: true }).tap();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  const saved = (await got(page)).filter((m) => m.type === 'save-file');
  if ((await status()) !== '已订货') fail('App 回存好了，采购单应变待到货：' + (await status()));
  else if (saved.length !== 2 || saved.some((m) => !m.name || !(m.data > 0))) fail('save-file 不对：' + JSON.stringify(saved));
  else ok('App 回存好了采购单才变待到货（save-file 两次：' + saved.map((m) => m.id + ' ' + m.name).join('、') + '）');
});

// 手机上助手全屏：地址一变（点了回复里的记录链接、助手带去某页）就收起，返回键不会先关一层看不见的
await step(page, '助手带去别的页时收起', async () => {
  await go(page, '#dashboard');
  await openAssistant(page, { mobile: true });
  await go(page, '#orders');
  if (await page.locator('[data-global-assistant] .ga-panel').isVisible().catch(() => false)) fail('手机上地址变了助手应收起');
  else await expectBack(page, '助手收起后按返回 → 今日', { result: 'handled', hash: '#dashboard' });
});

const transformOf = (page, selector) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).transform, selector);
await step(page, '顶栏跟着滚动收起', async () => {
  await go(page, '#orders');
  const height = await page.evaluate(() => document.querySelector('.topbar').offsetHeight);
  for (let y = 40; y <= 400; y += 40) await page.evaluate((top) => window.scrollTo(0, top), y);
  await page.waitForTimeout(500);
  const hidden = await transformOf(page, '.topbar');
  if (!hidden.endsWith(`, -${height})`)) fail('往下滚后顶栏应收起：' + hidden);
  else ok('往下滚，顶栏收起');
  for (let y = 360; y >= 200; y -= 40) await page.evaluate((top) => window.scrollTo(0, top), y);
  await page.waitForTimeout(500);
  const shown = await transformOf(page, '.topbar');
  if (!/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(shown)) fail('往回滚后顶栏应露出：' + shown);
  else ok('往回滚，顶栏露出');
});

await step(page, '滑到顶再往下拉只拉伸内容区', async () => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const cdp = await context.newCDPSession(page);
  const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: 200, y }] });
  await touch('touchStart', 300);
  for (let y = 310; y <= 500; y += 10) await touch('touchMove', y);
  const pulled = { main: await transformOf(page, 'main'), bar: await transformOf(page, '.topbar'), tab: await transformOf(page, '.mobile-tabbar') };
  const scale = Number(/^matrix\(1, 0, 0, ([\d.]+)/.exec(pulled.main)?.[1] ?? 1);
  const still = (t) => /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(t);
  if (!(scale > 1) || !still(pulled.bar) || !still(pulled.tab)) fail('往下拉时只有内容区伸长：' + JSON.stringify(pulled));
  else ok('往下拉，内容区伸长 ' + scale.toFixed(3) + ' 倍，顶栏、底栏不动');
  await touch('touchEnd');
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => document.querySelector('main').style.transform);
  if (after) fail('松手后内容区应回弹并清掉样式：' + after);
  else ok('松手回弹');
});
checkConsole(consoleErrors);
await context.close();

// 纯财务账号进不了 AI 导入：收到分享回 share-rejected，不跳页
const cashier = await openChrome({ ...phone, userAgent: APP_UA });
await login(cashier.page, '虚构出纳');
await connect(cashier.page);
await step(cashier.page, '纯财务账号收到分享', async () => {
  await waitFor(cashier.page, 'bridge-ready');
  await send(cashier.page, offer('share-cashier', '虚构出纳分享.pdf', 40));
  const answer = await waitFor(cashier.page, 'share-ready|share-rejected', ofShare('share-cashier'));
  if (answer.type !== 'share-rejected' || !answer.message) fail('纯财务账号收到分享应回 share-rejected：' + JSON.stringify(answer));
  else if ((await hash(cashier.page)).startsWith('#ai-import')) fail('纯财务账号收到分享不该跳到 AI 导入');
  else ok('纯财务账号收到分享回 share-rejected：' + answer.message);
});
// 纯财务账号读不到的业务接口回 403，和 flow-cashier 一样不算
checkConsole(cashier.consoleErrors, /status of (401|403)/);
await cashier.context.close();

// 没有 App 标记的浏览器：同样的接通消息不理，返回行为不受影响
const plain = await openChrome(phone);
await login(plain.page);
await connect(plain.page);
await plain.page.waitForTimeout(800);
if ((await got(plain.page)).length) fail('普通浏览器不应接通');
else ok('普通浏览器不接通');
checkConsole(plain.consoleErrors);
await plain.context.close();
