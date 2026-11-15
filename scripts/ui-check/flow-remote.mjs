// 模拟从域名访问（请求带 X-Forwarded-For，服务器不当成本机管理员）：账号菜单“系统维护”输错密码、进入超级管理员模式，
// 横幅和窗口说明同一句；助手删除卡片改选库存处理，另一页改过后旧卡片被拒。和 operations 同一组，接在它后面。全部虚构数据。
import { BASE, SP, fail, login, ok, openAssistant, openChrome, passwordOf, reviewButtonsFit, step as stepOn } from './lib.mjs';
// 超级管理员模式的说明：页面顶上的横幅和“系统维护”窗口是同一句（src/App.tsx、src/admin/MaintenancePanel.tsx）
const SUPER_SCOPE =
  '可以做平时会被拦下的维护操作，比如管理账号，修改 AI 设置、提示词、消息接入和助手工具启停，查看和修改已归档的记录，删除已核对的单据和档案，撤销生产任务、完工和采购退货，批准超出订单数量的发货；删已核对的单据和档案时，每次仍要核对会一起处理的记录，并输本人密码确认。';
const adminPassword = passwordOf('虚构管理员');
const remote = await openChrome({ width: 1440, height: 900, extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.9' } });
const rp = remote.page;
const step = (name, fn) => stepOn(rp, name, fn);
const rshot = (label) => rp.screenshot({ path: `${SP}/o-域名-${label}.png` });
/** 带页面凭证调接口（和页面上 call() 发的一样） */
const rcall = (path, body) =>
  rp.evaluate(
    async ([p, b]) => {
      const auth = await (await fetch('/api/auth/state')).json();
      const r = await fetch(p, {
        method: b === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
  );
let superOn = false;
await step('域名模式：系统维护进入超级管理员模式', async () => {
  await login(rp);
  const state = (await rcall('/api/auth/state')).body;
  if (state.actor?.localAdministrator) throw new Error('模拟从域名访问没有生效：还是本机管理员');
  await rp.getByRole('button', { name: /^账号菜单/ }).click();
  await rp.getByRole('menuitem', { name: '系统维护' }).click();
  const box = rp.locator('[role="dialog"][aria-modal="true"]').last();
  await box.waitFor();
  const text = await box.innerText();
  if (!text.includes('输入本人密码，临时开启 15 分钟。' + SUPER_SCOPE)) fail('系统维护窗口的说明不是统一的那句：' + text.slice(0, 200));
  if (/删除都要|永久删除/.test(text)) fail('系统维护窗口还有不准确的说法：' + text.slice(0, 200));
  await rshot('系统维护');
  // 输错一次：只说密码不对，不再冒“标红的必填项还没填”（密码框是系统清空的，不是人没填）
  await box.getByLabel('本人密码').fill('虚构的错误密码');
  await box.getByRole('button', { name: '进入超级管理员模式' }).click();
  await box.getByText('密码不正确').waitFor({ timeout: 8000 });
  await rp.waitForTimeout(800);
  const wrong = await box.innerText();
  await rshot('系统维护-输错密码');
  if (/必填项/.test(wrong) || (await box.locator('.is-missing').count())) fail('输错密码后又冒出必填提示：' + wrong.slice(0, 200));
  else ok('系统维护输错密码：只提示密码不正确，没有必填提示');
  await box.getByLabel('本人密码').fill(adminPassword);
  await box.getByRole('button', { name: '进入超级管理员模式' }).click();
  await box.waitFor({ state: 'detached', timeout: 8000 });
  const banner = rp.locator('.super-mode-banner');
  await banner.waitFor({ timeout: 8000 });
  const bannerText = await banner.innerText();
  await rshot('超级管理员横幅');
  if (!bannerText.replace(/\s+/g, '').includes(SUPER_SCOPE.replace(/\s+/g, ''))) fail('横幅说明和系统维护窗口不是同一句：' + bannerText);
  else ok('从域名访问：系统维护里输密码进入超级管理员模式，横幅和窗口说明是同一句');
  superOn = true;
  // 再打开：已开启、有效期、退出按钮
  await rp.getByRole('button', { name: /^账号菜单/ }).click();
  await rp.getByRole('menuitem', { name: '系统维护' }).click();
  await box.waitFor();
  if (!(await box.getByText('已开启').count()) || !(await box.getByRole('button', { name: '退出超级管理员模式' }).count()))
    fail('进入后再打开系统维护，没有显示已开启和“退出超级管理员模式”');
  await box.getByRole('button', { name: '取消', exact: true }).click();
  await box.waitFor({ state: 'detached', timeout: 5000 });
});

await step('域名模式：助手删除卡片改选库存处理，旧卡片不能按新选项执行', async () => {
  if (!superOn) throw new Error('没进超级管理员模式，这一步没测');
  // 找一家删了会连带动过库存的单据、两种库存处理方式都删得了的供应商
  let target = null;
  for (const s of (await rcall('/api/suppliers')).body) {
    const selection = { module: 'suppliers', items: [{ id: s.id, version: s.version }] };
    const [re, keep] = await Promise.all(
      ['recalculate', 'preserve'].map((inventoryPolicy) => rcall('/api/deletions/preview', { ...selection, inventoryPolicy })),
    );
    if (re.status === 200 && keep.status === 200 && re.body.inventoryChoice > 0) {
      target = s;
      break;
    }
  }
  if (!target) throw new Error('种子里没有删了会动库存、两种方式都删得了的供应商');
  const balances = async () =>
    Object.fromEntries((await rcall('/api/warehouse/items')).body.map((i) => [i.id, i.balanceUnits]));
  const before = await balances();
  await rp.evaluate(
    (id) =>
      fetch('/__ui-check/replies', {
        method: 'POST',
        body: JSON.stringify([{ message: '', toolCalls: [{ name: 'records.delete', args: { module: 'suppliers', id } }] }]),
      }),
    target.id,
  );
  await rp.goto(BASE + '#dashboard');
  await rp.locator('main').first().waitFor();
  const ga = rp.locator('[data-global-assistant]');
  const box = await openAssistant(rp);
  await box.fill('把供应商 ' + target.name + ' 删掉');
  await ga.getByRole('button', { name: '发送' }).click();
  await ga.getByRole('button', { name: '查看修改内容并确认' }).last().click({ timeout: 15000 });
  const policy = ga.locator('select[aria-label="库存怎么处理"]');
  await policy.waitFor({ timeout: 8000 });
  const options = await policy.locator('option').allInnerTexts();
  if (options.join('|') !== '库存一起改回（当连带删掉的单据没发生过）|库存数量不动，只删记录')
    fail('卡片上的选项文字和页面删除窗口不一样：' + options.join('|'));
  if ((await policy.inputValue()) !== 'recalculate') fail('卡片默认不是“库存一起改回”');
  const review = ga.locator('.ga-review');
  await reviewButtonsFit(rp);
  await rshot('删除卡片-库存一起改回');
  // 改选“库存数量不动”：服务器重新核算，库存说明换成保留系统维护流水
  await policy.selectOption('preserve');
  await review.getByText(/改成“系统维护”流水/).first().waitFor({ timeout: 8000 });
  await rshot('删除卡片-库存数量不动');
  // 另一个标签页把它改回“库存一起改回”：这一页的卡片还停在“库存数量不动”
  const thread = (await rcall('/api/assistant')).body.threads[0];
  const messages = (await rcall('/api/assistant/threads/' + thread.id)).body.messages;
  const plan = messages.flatMap((m) => m.plans || []).filter((p) => p.tool === 'records.delete').at(-1);
  const other = await rcall('/api/assistant/previews/' + plan.id + '/inventory-policy', { inventoryPolicy: 'recalculate' });
  if (other.status !== 200) throw new Error('模拟另一页改选失败：' + JSON.stringify(other.body));
  if ((await policy.inputValue()) !== 'preserve') fail('这一页的卡片不该自己变');
  await ga.locator('input[type=password]').fill(adminPassword);
  await ga.locator('.ga-review-actions').getByRole('button', { name: '确认删除' }).click();
  const alert = ga.locator('.ga-error');
  await alert.waitFor({ timeout: 8000 });
  const said = await alert.innerText();
  // 卡片重新载入，显示服务器上现在这一版
  for (let i = 0; i < 40 && (await policy.inputValue()) !== 'recalculate'; i++) await rp.waitForTimeout(100);
  await rshot('删除卡片-旧卡片被拒');
  const still = (await rcall('/api/suppliers')).body.some((s) => s.id === target.id);
  if (!/重新核算/.test(said) || !still) fail('旧卡片按别的选项执行了，或没说清：' + said + ' 供应商还在=' + still);
  else if ((await policy.inputValue()) !== 'recalculate') fail('被拒后卡片没换成最新的一版');
  else ok('旧卡片点确认被拒（' + said + '），卡片换成服务器上现在的选项');
  // 看过最新的卡片，重新选“库存数量不动”再确认：按选的删，库存数量不变
  await policy.selectOption('preserve');
  await review.getByText(/改成“系统维护”流水/).first().waitFor({ timeout: 8000 });
  await ga.locator('input[type=password]').fill(adminPassword);
  await ga.locator('.ga-review-actions').getByRole('button', { name: '确认删除' }).click();
  for (let i = 0; i < 60 && (await rcall('/api/suppliers')).body.some((s) => s.id === target.id); i++) await rp.waitForTimeout(150);
  const after = await balances();
  const gone = !(await rcall('/api/suppliers')).body.some((s) => s.id === target.id);
  const changed = Object.keys(before).filter((id) => id in after && after[id] !== before[id]);
  await rshot('删除卡片-按库存数量不动删完');
  if (!gone) fail('点了删除，供应商 ' + target.name + ' 还在');
  else if (changed.length) fail('选了“库存数量不动”，库存却变了：' + changed.join(','));
  else ok('从域名访问：助手卡片改选“库存数量不动”后确认，删了供应商 ' + target.name + '，库存数量没变');
});
const remoteErrors = [...new Set(remote.consoleErrors)].filter((e) => !/status of (401|403|409)/.test(e));
if (remoteErrors.length) fail('域名模式控制台报错：' + remoteErrors.join(' | ').slice(0, 300));
await remote.context.close();
