// 手机实测：390×844 触屏，用点按操作常用流程。全站页面巡检（页面清单只在这里列）：手机宽度、深色、900 宽三档，
// 超出屏幕、页面报错、深色没生效都算问题。虚构数据。
import { readFileSync } from 'node:fs';
import { BASE, SERVER_SOURCE, SP, go, openChrome } from './lib.mjs';

const WIDTH = 390;
const seed = readFileSync(SERVER_SOURCE, 'utf8');
const [, name, password] = /add\('(虚构管理员)',\s*'([^']+)'/.exec(seed);
const { context, page, consoleErrors } = await openChrome({
  width: WIDTH,
  height: 844,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const fail = (message) => console.log('ERR: ' + message);
let shots = 0;
const shot = (label) => page.screenshot({ path: `${SP}/m${String(++shots).padStart(2, '0')}-${label}.png` });
/** 手机上超出屏幕的元素。自己带横向滚动的容器（日期条、标签条）不算。 */
const overflow = (scope) =>
  page.evaluate(
    ({ width, scope }) => {
      const root = document.querySelector(scope);
      if (!root) return [];
      return [...root.querySelectorAll('button,input,select,textarea,a,h1,h2,strong')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          if (!r.width || r.right <= width + 1) return false;
          for (let p = e.parentElement; p && p !== root; p = p.parentElement) {
            const o = getComputedStyle(p).overflowX;
            if (o === 'auto' || o === 'scroll') return false;
          }
          return true;
        })
        .slice(0, 4)
        .map((e) => e.tagName.toLowerCase() + ':' + (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 14));
    },
    { width: WIDTH, scope },
  );
const check = async (label, scope = 'main') => {
  await page.waitForTimeout(500);
  const wide = await overflow(scope);
  if (wide.length) fail(label + ' 超出屏幕：' + wide.join('，'));
  else console.log(label + ' ok');
  await shot(label);
};
const dialog = () => page.locator('[role="dialog"][aria-modal="true"]').last();

await page.goto(BASE);
await page.waitForTimeout(500);
await check('登录页', '.login-screen');
await page.locator('.login-screen input').nth(0).fill(name);
await page.locator('.login-screen input').nth(1).fill(password);
await page.locator('.login-screen input').nth(1).press('Enter');
await page.locator('.shell').waitFor();

// 全站页面巡检：手机宽度逐页查超出屏幕；深色、900 宽在后面
const sitePages = [
  ['#dashboard', '今日'], ['#inbox', '收件箱'], ['#ai-import', 'AI导入'], ['#orders', '订单'],
  ['#customers', '客户'], ['#products', '产品'], ['#purchases', '采购'], ['#suppliers', '供应商'],
  ['#production', '生产'], ['#production?view=production', '完工'], ['#warehouse', '库存'],
  ['#warehouse?arrivals=1', '到货'], ['#warehouse?deliveries=1&kind=finished', '送货'], ['#warehouse?flow=1', '流水'],
  ['#finance', '财务概览'], ['#finance-flow', '台账'], ['#finance-ar', '应收应付'], ['#finance-cash', '资金'],
  ['#finance-costs', '费用'], ['#finance-ledger', '凭证'], ['#finance-reports', '报表'], ['#finance-settings', '财务设置'],
  ['#ai-settings', '设置'], ['#trash', '归档'], ['#guide', '说明'],
];
for (const [hash, label] of sitePages) {
  await go(page, hash);
  await check(label);
}

// 底部导航和仓库切换
await go(page, '#dashboard');
if ((await page.locator('.mobile-tab-ai svg.yl-duo[data-still]').count()) !== 1) fail('底部“助手”没有用小甬和小勒的小图标');
await page.getByRole('navigation', { name: '手机底部导航' }).getByRole('button', { name: '仓库' }).tap();
await page.waitForTimeout(500);
await page.getByRole('navigation', { name: '页面切换' }).getByRole('button', { name: '到货' }).tap();
await page.waitForTimeout(500);
if (!(await page.evaluate(() => location.hash)).includes('arrivals=1')) fail('仓库切换到货失败');
else console.log('底部导航和切换 ok');

// 抽屉菜单：能打开，点遮罩能关，选页面后自动关
await page.getByRole('button', { name: '切换导航' }).tap();
await page.waitForTimeout(300);
await shot('抽屉');
await page.locator('.sidebar').getByRole('button', { name: '收件箱' }).tap();
await page.waitForTimeout(500);
if (await page.locator('.mobile-backdrop').count()) fail('选页面后抽屉没关');
if (!(await page.evaluate(() => location.hash)).includes('inbox')) fail('抽屉导航失败');
await page.getByRole('button', { name: '切换导航' }).tap();
await page.waitForTimeout(300);
await page.locator('.mobile-backdrop').tap({ position: { x: 370, y: 400 } });
await page.waitForTimeout(300);
if (await page.locator('.mobile-backdrop').count()) fail('点遮罩抽屉没关');
else console.log('抽屉 ok');

// 筛选默认收起：订单页工具栏只有搜索、待处理 / 全部 / 已归档和“筛选”，客户、状态、日期在弹层里
await go(page, '#orders');
await page.waitForTimeout(500);
const status = page.locator('.filter-popover-panel select').first();
if (await status.isVisible().catch(() => false)) fail('筛选没有默认收起');
await page.getByRole('button', { name: '筛选', exact: true }).tap();
await page.waitForTimeout(300);
if (!(await status.isVisible().catch(() => false))) fail('点筛选后没有展开');
else console.log('筛选 ok');
await check('筛选展开');
await page.locator('.filter-popover-panel').getByRole('button', { name: '完成' }).tap();

// 订单卡片 → 详情 → 编辑
await page.locator('table.m-cards tr.record-row').first().tap();
await page.waitForTimeout(800);
await check('订单详情', '.detail-panel');
await page.getByRole('button', { name: '关闭详情' }).tap();
await page.waitForTimeout(300);

// 新建订单
await page.getByRole('button', { name: /新建订单/ }).first().tap();
await page.waitForTimeout(800);
await check('新建订单', '[role="dialog"][aria-modal="true"]');
await dialog().getByRole('button', { name: '取消', exact: true }).tap();
await page.waitForTimeout(400);

// 到货登记：手机最常用，真的走一遍选供应商和明细
await go(page, '#warehouse?arrivals=1');
// 没有采购单的到货（多送、样品）在页头“更多”里
await page.locator('main summary.more-menu-text').first().tap();
await page.waitForTimeout(300);
await page.getByRole('menuitem', { name: '登记没有采购单的到货' }).tap();
await page.waitForTimeout(800);
await check('到货表单', '[role="dialog"][aria-modal="true"]');
const supplier = dialog().getByLabel(/^供应商 */).first();
await supplier.tap();
await page.waitForTimeout(300);
const option = page.locator('[role="option"]', { hasText: '虚构' }).first();
if (await option.count()) {
  const chosen = (await option.locator('span').first().innerText()).trim();
  await option.tap();
  await page.waitForTimeout(400);
  const value = await supplier.inputValue();
  if (value !== chosen) fail('点选供应商没有生效：' + value);
  else console.log('选供应商 ok');
} else fail('到货表单的供应商选不了');
await check('到货已选供应商', '[role="dialog"][aria-modal="true"]');
// 到货编辑窗的主按钮：新登记是“登记到货”，从计划转过来是“保存修改”
const actions = dialog().getByRole('button', { name: /登记到货|保存修改/ });
if (!(await actions.isVisible())) fail('到货表单看不到保存按钮');
const box = await actions.boundingBox();
if (!box || box.y + box.height > 844) fail('保存按钮在屏幕外');
else console.log('保存按钮可见 ok');
await dialog().getByRole('button', { name: '取消', exact: true }).tap();
await page.waitForTimeout(400);

// 助手：底部导航进入，全屏，输入框可用，发消息，返回
await go(page, '#dashboard');
await page.getByRole('button', { name: '助手', exact: true }).tap();
await page.waitForTimeout(800);
const panel = page.locator('.ga-panel');
const rect = await panel.boundingBox();
if (!rect || rect.width < WIDTH - 1 || rect.x !== 0) fail('助手不是全屏：' + JSON.stringify(rect));
if (await page.locator('.ga-launcher').isVisible().catch(() => false)) fail('手机上还显示悬浮的小甬和小勒');
await check('助手', '.ga-panel');
const input = panel.locator('textarea').first();
await input.tap();
await input.fill('虚构测试消息');
const send = panel.getByRole('button', { name: /发送/ }).first();
if (await send.isEnabled().catch(() => false)) {
  await send.tap();
  await page.waitForTimeout(1500);
  console.log('助手发送 ok');
} else fail('助手发送按钮不可用');
await check('助手已发送', '.ga-panel');
// 面板头部的“返回”和“关闭”效果一样，只留了“关闭”
await panel.getByRole('button', { name: /关闭/ }).first().tap();
await page.waitForTimeout(400);
if (await panel.isVisible().catch(() => false)) fail('助手关闭后还开着');
else console.log('助手返回 ok');

// 新表格和附属品：到货、送货详情的明细表，产品和成品库存里挂在主产品下面的附属品，数据管理的编辑窗
const api = (path, method = 'GET', body) =>
  page.evaluate(
    async ({ path, method, body }) => {
      const state = await (await fetch('/api/auth/state')).json();
      const r = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': state.csrf },
        body: body ? JSON.stringify(body) : undefined,
      });
      return r.json();
    },
    { path, method, body },
  );
const products = await api('/api/products');
const big = products.find((p) => p.name === '五金配件箱 大'),
  small = products.find((p) => p.name === '五金配件箱 小');
await api('/api/products/' + small.id, 'PUT', { ...small, parentProductId: big.id });
// 直接调接口改的，页面里的产品缓存不知道，重新打开页面（在界面上改会自己刷新）
await page.reload();
await page.locator('.shell').waitFor();
for (const [hash, label] of [
  ['#products', '产品附属品'],
  ['#warehouse?kind=finished', '成品附属品'],
]) {
  await go(page, hash);
  await page.waitForTimeout(600);
  if (!(await page.locator('main .record-tree-branch').count())) fail(label + '：手机上看不到附属品的连接线');
  await check(label);
}
const arrival = (await api('/api/flow?kind=arrival')).find((a) => a.status === 'confirmed');
await go(page, '#warehouse?arrivals=1&doc=' + arrival.id);
await page.waitForTimeout(800);
await check('到货详情', '.detail-panel');
const delivery = (await api('/api/flow?kind=delivery')).find((d) => d.status === 'confirmed');
await go(page, '#warehouse?kind=finished&deliveries=1&doc=' + delivery.id);
await page.waitForTimeout(800);
await check('送货详情', '.detail-panel');
await page.getByRole('button', { name: '关闭详情' }).tap();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /^账号菜单/ }).tap();
await page.getByRole('menuitem', { name: '数据管理' }).tap();
await page.waitForTimeout(1000);
await check('数据管理', '[role="dialog"][aria-modal="true"]');
const editButton = dialog().locator('.adm-data-actions button', { hasText: '编辑' }).first();
if (await editButton.count()) {
  await editButton.tap();
  await page.waitForTimeout(800);
  await check('数据管理编辑窗', '[role="dialog"][aria-modal="true"]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
} else fail('数据管理里没有可编辑的记录');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// 深色模式
await page.emulateMedia({ colorScheme: 'dark' });
await page.reload();
await page.locator('.shell').waitFor();
await go(page, '#orders');
await check('深色订单');
await page.emulateMedia({ colorScheme: 'light' });
await page.reload();
await page.locator('.shell').waitFor();

// 深色：每页没有报错、页面底色确实变深；900 宽：整页不横向溢出、没有报错
const pageErrors = () => page.locator('main .form-message.tone-danger, main [role=alert]').allInnerTexts();
// 主题跟随系统只在打开页面时定一次（src/ui/theme.ts），换了系统深浅要重新载入
const scheme = async (colorScheme) => {
  await page.emulateMedia({ colorScheme });
  await page.reload();
  await page.locator('.shell').waitFor();
};
await scheme('dark');
for (const [hash, label] of sitePages) {
  await go(page, hash);
  const dark = await page.evaluate(() => {
    // 从主区域往外找第一层有底色的
    let bg = '';
    for (let el = document.querySelector('main'); el; el = el.parentElement)
      if (!/rgba\(0, 0, 0, 0\)|transparent/.test((bg = getComputedStyle(el).backgroundColor))) break;
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    return (r + g + b) / 3 < 80;
  });
  const errors = await pageErrors();
  if (!dark) fail('深色 ' + label + ' 页面底色没变深');
  if (errors.length) fail('深色 ' + label + ' 页面报错：' + errors.join(' | ').slice(0, 120));
}
await scheme('light');
console.log('深色巡检 ' + sitePages.length + ' 页 ok');
await page.setViewportSize({ width: 900, height: 800 });
for (const [hash, label] of sitePages) {
  await go(page, hash);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const errors = await pageErrors();
  if (over > 0) fail('900 宽 ' + label + ' 横向溢出 ' + over + 'px');
  if (errors.length) fail('900 宽 ' + label + ' 页面报错：' + errors.join(' | ').slice(0, 120));
}
console.log('900 宽巡检 ' + sitePages.length + ' 页 ok');
await page.setViewportSize({ width: WIDTH, height: 844 });

const real = [...new Set(consoleErrors)].filter((e) => !/status of (401|403|404|422|503)/.test(e));
if (real.length) fail('控制台报错 ' + real.join(' | ').slice(0, 300));
await context.close();
