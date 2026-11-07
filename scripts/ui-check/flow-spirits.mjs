// 小甬和小勒：点哪个都打开同一个助手、拖动、贴边、自动小剧场、AI 忙碌和做完、减少动效、深色。虚构数据。
import { readFileSync } from 'node:fs';
import { BASE, SERVER_SOURCE, SP, openChrome } from './lib.mjs';

const seed = readFileSync(SERVER_SOURCE, 'utf8');
const [, name, password] = /add\('(虚构管理员)',\s*'([^']+)'/.exec(seed);
const { context, page, consoleErrors } = await openChrome({ width: 1440, height: 900 });
const fail = (message) => console.log('ERR: ' + message);
let shots = 0;
const launcher = page.locator('.ga-launcher');
const duo = page.locator('.ga-launcher .yl-duo');
const panel = page.locator('.ga-panel');
const shot = async (label) => {
  const box = await launcher.boundingBox();
  const x = Math.max(0, box.x - 40), y = Math.max(0, box.y - 40);
  await page.screenshot({
    path: `${SP}/s${String(++shots).padStart(2, '0')}-${label}.png`,
    clip: { x, y, width: Math.min(1440 - x, box.width + 80), height: Math.min(900 - y, box.height + 60) },
  });
};
const closePanel = async () => {
  await page.getByRole('button', { name: '关闭聊天窗口' }).click();
  await launcher.waitFor();
};
// 真的拖过去：抓住能看到的部分，放到目标位置
const dragTo = async (x, y) => {
  const box = await launcher.boundingBox();
  const fromX = Math.min(1435, Math.max(5, box.x + box.width / 2));
  const fromY = box.y + box.height / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(700);
};
const running = () =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => a.animationName)
      .filter((n) => n && n.startsWith('yl-')),
  );

await page.goto(BASE);
await page.locator('.login-screen input').nth(0).fill(name);
await page.locator('.login-screen input').nth(1).fill(password);
await page.locator('.login-screen input').nth(1).press('Enter');
await page.locator('.shell').waitFor();
await launcher.waitFor();
await page.mouse.move(10, 10);
await page.waitForTimeout(900);
await shot('平时');
const size = await launcher.boundingBox();
if (Math.round(size.width) !== 104 || Math.round(size.height) !== 108) fail('按钮尺寸不对 ' + JSON.stringify(size));

// 点小甬、点小勒，打开的都是同一个助手
for (const [label, fx, fy] of [['小甬', 0.32, 0.6], ['小勒', 0.66, 0.6], ['纸箱', 0.84, 0.62]]) {
  await page.mouse.click(size.x + size.width * fx, size.y + size.height * fy);
  await panel.waitFor();
  console.log('点' + label + '打开助手 ok');
  await closePanel();
}

// 重新出现时依次跳出来，播完不再重播
await page.waitForTimeout(900);
if ((await running()).includes('yl-enter')) fail('出场动画一直在播');

// 鼠标靠近眼睛跟着看，走远看回对方
await page.mouse.move(size.x - 80, size.y + 20);
await page.waitForTimeout(250);
if (!(await duo.getAttribute('data-tracking'))) fail('鼠标靠近时眼睛没有跟着看');
await page.mouse.move(10, 10);
await page.waitForTimeout(250);
if (await duo.getAttribute('data-tracking')) fail('鼠标走远后眼睛没有收回');
else console.log('眼睛跟随 ok');

// 鼠标移上去
await launcher.hover();
await page.waitForTimeout(350);
await shot('鼠标移上去');
if (!(await running()).includes('yl-wave-l')) fail('鼠标移上去没有挥手');
else console.log('挥手 ok');
await page.mouse.move(10, 10);

// 拖动，不会误打开
const center = { x: size.x + size.width / 2, y: size.y + size.height / 2 };
await page.mouse.move(center.x, center.y);
await page.mouse.down();
await page.mouse.move(center.x - 200, center.y - 150, { steps: 8 });
await page.waitForTimeout(150);
if (!(await page.locator('.ga-launcher.ga-moving').count())) fail('拖动状态没有生效');
await shot('拖动中');
await page.mouse.up();
await page.waitForTimeout(500);
if (await panel.count()) fail('拖动后误打开了助手');
else console.log('拖动 ok');

// 贴边
await dragTo(40, 500);
if ((await duo.getAttribute('data-pose')) !== 'dock-left') fail('没有贴左边');
await page.mouse.move(10, 10);
await shot('贴左边');
{
  // 只露头和脸：两张脸都要在屏幕里，纸箱和脚不显示
  const faces = await page.evaluate(() =>
    ['.ga-launcher .yl-eyes-y', '.ga-launcher .yl-eyes-l'].map((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { left: r.left, right: r.right };
    }),
  );
  for (const f of faces) if (f.left < 0 || f.right > 1440) fail('贴左边脸被切掉了 ' + JSON.stringify(f));
  if (await page.evaluate(() => getComputedStyle(document.querySelector('.ga-launcher .yl-box')).opacity !== '0')) fail('贴边时纸箱还显示');
}
await dragTo(1420, 500);
if ((await duo.getAttribute('data-pose')) !== 'dock-right') fail('没有贴右边');
await page.mouse.move(700, 400);
await shot('贴右边');
{
  const faces = await page.evaluate(() =>
    ['.ga-launcher .yl-eyes-y', '.ga-launcher .yl-eyes-l'].map((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { left: r.left, right: r.right };
    }),
  );
  for (const f of faces) if (f.left < 0 || f.right > 1440) fail('贴右边脸被切掉了 ' + JSON.stringify(f));
}
await launcher.hover();
await page.waitForTimeout(500);
await shot('贴右边鼠标移上去');
await page.mouse.move(700, 400);
const docked = await launcher.boundingBox();
await page.mouse.click(1440 - 20, docked.y + docked.height * 0.6);
await panel.waitFor();
console.log('贴边能点开 ok');
await closePanel();

// 自动小剧场：第一段 6 秒左右开始，演完自己清掉
await dragTo(1100, 600);
if ((await duo.getAttribute('data-pose')) !== 'free') fail('拖回中间后还是贴边');
await page.reload();
await launcher.waitFor();
await page.mouse.move(10, 10);
await duo.locator('xpath=self::*[@data-scene]').waitFor({ timeout: 9000 });
const scene = await duo.getAttribute('data-scene');
console.log('小剧场开始：' + scene);
await page.waitForTimeout(500);
await shot('小剧场-' + scene);
await page.waitForFunction(() => !document.querySelector('.yl-duo[data-scene]'), null, { timeout: 5000 });
await page.waitForTimeout(150);
if ((await running()).includes('yl-enter')) fail('小剧场结束后重播了出场动画');
else console.log('小剧场结束 ok');

// AI 处理中和做完：发消息后收起聊天窗口。接口放慢一点，好看到中间状态
await page.route('**/api/assistant/**', async (route) => {
  if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 2500));
  await route.continue();
});
await launcher.click();
await panel.waitFor();
await panel.locator('textarea').first().fill('虚构测试消息');
await panel.getByRole('button', { name: /发送/ }).first().click();
await page.waitForTimeout(200);
await closePanel();
await page.locator('.yl-duo[data-busy]').waitFor({ timeout: 4000 });
await page.mouse.move(10, 10);
await page.waitForTimeout(400);
await shot('AI处理中');
if (!(await running()).includes('yl-think')) fail('处理中小星没有动');
console.log('AI 处理中 ok');
await page.locator('.yl-duo[data-scene="highfive"]').waitFor({ timeout: 30000 });
await page.waitForTimeout(600);
await shot('AI做完击掌');
console.log('AI 做完击掌 ok');
// 窗口收起时冒气泡，点它打开聊天，能看到是谁说的
await page.locator('.yl-bubble').waitFor({ timeout: 5000 });
const bubble = await page.locator('.yl-bubble').innerText();
if (!/小甬|小勒/.test(bubble)) fail('气泡没有说是谁：' + bubble);
await page.screenshot({ path: SP + '/s' + String(++shots).padStart(2, '0') + '-气泡.png', clip: { x: 900, y: 450, width: 540, height: 450 } });
await page.locator('.yl-bubble').click();
await panel.waitFor();
if (await page.locator('.yl-bubble').count()) fail('打开聊天后气泡还在');
const who = await panel.locator('.ga-message.ga-assistant .ga-who').last().innerText();
if (!/小甬|小勒/.test(who)) fail('消息没有显示说话人：' + who);
if (!(await panel.locator('.ga-message.ga-assistant .yl-avatar').count())) fail('消息没有头像');
if (!(await panel.locator('.ga-header .yl-duo[data-compact]').count())) fail('窗口顶部没有小甬和小勒');
await page.screenshot({ path: SP + '/s' + String(++shots).padStart(2, '0') + '-聊天窗口.png' });
console.log('气泡和说话人 ok');
await closePanel();
await page.unroute('**/api/assistant/**');

// 深色
await page.emulateMedia({ colorScheme: 'dark' });
await page.reload();
await launcher.waitFor();
await page.mouse.move(10, 10);
await page.waitForTimeout(900);
await shot('深色');
await page.emulateMedia({ colorScheme: 'light' });

// 减少动效：完全不动，也不演小剧场
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.reload();
await launcher.waitFor();
await page.waitForTimeout(7000);
if ((await running()).length) fail('减少动效时还在动：' + (await running()).join());
if (await duo.getAttribute('data-scene')) fail('减少动效时还在演小剧场');
else console.log('减少动效 ok');

const real = [...new Set(consoleErrors)].filter((e) => !/status of (401|403|404|409|422|429|503)/.test(e));
if (real.length) fail('控制台报错 ' + real.join(' | ').slice(0, 300));
await context.close();
