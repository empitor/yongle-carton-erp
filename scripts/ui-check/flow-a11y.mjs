// 在隔离实例上用 axe 检查 WCAG 2.1 A/AA，每个登记外的违规都会让 test:ui 失败。
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE, SP, a11yViolations, call, dialogOf, fail, go, login, ok, openAssistant, openChrome, step } from './lib.mjs';

const known = JSON.parse(readFileSync(new URL('./a11y-known.json', import.meta.url), 'utf8'));
const { hostname, port } = new URL(BASE);
if (hostname !== '127.0.0.1' || Number(port) < 3201) throw new Error('用 npm run test:ui -- a11y 启动隔离实例');

const { context, page } = await openChrome({ width: 1440, height: 900, colorScheme: 'light', reducedMotion: 'reduce' });
page.setDefaultTimeout(10000);
await login(page);

const dialog = dialogOf(page);
const panel = page.locator('.detail-panel');
const orderRows = 'main tbody tr.record-row';
const deliveries = '#warehouse?kind=finished&deliveries=1';

function button(name, scope = page) {
  return scope.getByRole('button', { name, exact: true });
}

async function visit(hash, ready) {
  await go(page, hash);
  await page.locator(ready).first().waitFor();
}

async function enableFinance() {
  await go(page, '#finance-settings');
  await button('启用财务').click();
  await dialog.getByLabel('纳税人身份').selectOption('general');
  await button('确认启用', dialog).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function financeTab(hash, label) {
  await go(page, hash);
  await button(label, page.locator('.fin-subbar .fin-segmented')).and(page.locator('.selected')).waitFor();
}

async function openDelivery() {
  const seeded = await call(page, 'GET', '/flow?kind=delivery&status=draft');
  if (!Array.isArray(seeded) || !seeded.length) throw new Error('隔离实例没有待送货单');
  await visit(deliveries + '&doc=' + seeded[0].id, '.detail-panel');
}

async function openDelete() {
  await openDelivery();
  await panel.locator('summary', { hasText: '更多' }).click();
  await panel.getByRole('menuitem', { name: '删除', exact: true }).click();
  await dialog.getByText(/会删除/).first().waitFor();
}

async function openConversation() {
  await visit('#dashboard', '.td-groups');
  const answer = '这是一条虚构的无障碍检查回复。';
  const queued = await page.request.post(new URL('__ui-check/replies', BASE).href, {
    data: [{ message: answer, toolCalls: [] }],
  });
  if (!queued.ok()) throw new Error('排入模型替身回复失败：' + queued.status());
  const box = await openAssistant(page);
  await box.fill('请简单问候。');
  const assistant = page.locator('[data-global-assistant]');
  await button('发送', assistant).click();
  await assistant.locator('.ga-message.ga-assistant .ga-text').getByText(answer).waitFor();
}

const seen = new Set();
const report = [];
let plannedScans = 0;

async function matchKnown(violations) {
  return page.evaluate(
    ({ violations, known }) => violations.flatMap(({ rule, nodes }) => nodes.map(({ target }) => {
      if (target.length !== 1 || typeof target[0] !== 'string') return -1;
      const elements = document.querySelectorAll(target[0]);
      if (elements.length !== 1) return -1;
      const element = elements[0];
      return known.findIndex((entry) => entry.rule === rule && element.matches(entry.selector) &&
        (entry.text === undefined || element.textContent.trim() === entry.text));
    })),
    { violations, known },
  );
}

async function scan(name, prepare, close) {
  plannedScans++;
  await step(page, name, async () => {
    await prepare();
    const violations = await a11yViolations(page);
    const matches = await matchKnown(violations);
    report.push({ page: name, violations });
    let total = 0;
    let unregistered = 0;
    for (const { rule, help, nodes } of violations) {
      for (const node of nodes) {
        total++;
        const entry = known[matches[total - 1]];
        if (entry) {
          seen.add(entry);
          node.known = entry.selector;
        } else {
          unregistered++;
          const details = node.failureSummary?.trim().replace(/\s*\n\s*/g, '；') || help;
          fail(`${name} / ${rule} / ${JSON.stringify(node.target)}：${details}`);
        }
      }
    }
    ok(`${name}：${violations.length} 条规则，${total} 处，其中登记外 ${unregistered} 处`);
    await close?.();
  });
}

async function dismissDialog() {
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
}

await scan('今日', () => visit('#dashboard', '.td-groups'));
await scan('订单', () => visit('#orders', orderRows));
await scan('仓库', () => visit('#warehouse', orderRows));
await scan('采购', () => visit('#purchases', orderRows));
await scan('财务概览', () => visit('#finance', '.fin-page'));
await scan('新建订单弹窗', async () => {
  await visit('#orders', orderRows);
  await button('新建订单').first().click();
  await dialog.getByRole('heading', { name: '新建订单' }).waitFor();
}, dismissDialog);
await scan('订单详情', async () => {
  await visit('#orders', orderRows);
  await page.locator(orderRows).first().click();
  await panel.waitFor();
}, () => button('关闭详情', panel).click());
await scan('库存品详情', async () => {
  await visit('#warehouse', orderRows);
  await page.locator(orderRows).first().click();
  await panel.waitFor();
}, () => button('关闭详情', panel).click());
await scan('送货单详情', openDelivery);
await scan('删除送货单确认窗', openDelete, dismissDialog);
await scan('安排送货弹窗', async () => {
  await go(page, deliveries);
  await button('安排送货').click();
  await dialog.getByRole('heading', { name: '安排送货' }).waitFor();
  await dialog.getByText('正在读取库存、订单和客户…').waitFor({ state: 'hidden' });
}, dismissDialog);

await enableFinance();
await scan('财务·账簿', () => financeTab('#finance-ledger?tab=books', '账簿'));
await scan('财务·往来账期', () => financeTab('#finance-ar?tab=terms', '账期'));
await scan('财务·正式报表', () => financeTab('#finance-reports?tab=reports', '正式报表'));
await scan('识别导入', () => visit('#ai-import', '.order-import'));
await scan('数据管理表格', async () => {
  await visit('#dashboard', '.td-groups');
  await page.locator('.oi-account').click();
  await page.locator('.account-menu').getByRole('menuitem', { name: '数据管理' }).click();
  await dialog.locator('.adm-data-table tbody tr').first().waitFor();
}, dismissDialog);
await scan('使用说明', () => visit('#guide', '.guide-body'));
await scan('助手对话', openConversation, () => button('关闭聊天窗口').click());

await scan('手机今日', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await visit('#dashboard', '.td-groups');
  await page.locator('.mobile-tabbar').waitFor();
});
await scan('手机订单', () => visit('#orders', orderRows));
await scan('深色订单', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('html[data-theme="dark"]').waitFor({ state: 'attached' });
  await visit('#orders', orderRows);
});

if (report.length === plannedScans) {
  for (const entry of known.filter((entry) => !seen.has(entry))) {
    const element = entry.text ? `${entry.selector} / ${entry.text}` : entry.selector;
    console.log(`可删除登记：${entry.rule} / ${element}（本次各场景均未出现）`);
  }
}
const reportPath = join(SP || tmpdir(), 'a11y.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log('无障碍清单：' + reportPath);
await context.close();
