// 助手输入框的回车：电脑上回车发送、Shift+回车换行；输入法选字中的回车、空内容的回车都不发送也不换行；
// 手机宽度回车换行、提示文字不写“回车发送”。助手回答用 server.mts 的模型替身，虚构数据。
import { checkConsole, fail, go, login, ok, openAssistant, openChrome } from './lib.mjs';

const ANSWER = '虚构回答：收到回车发送的消息。';

async function walk({ tag, chrome, mobile }) {
  const { context, page, consoleErrors } = await openChrome(chrome);
  await login(page);
  await page.evaluate(async (message) => fetch('/__ui-check/replies', { method: 'POST', body: JSON.stringify([{ message, toolCalls: [] }]) }), ANSWER);
  if (mobile) await go(page, '#dashboard');
  const box = await openAssistant(page, { mobile });
  const panel = page.locator('.ga-panel');
  // 开新会话，回答好认
  const fresh = panel.getByRole('button', { name: '新会话' });
  if (await fresh.isEnabled()) await fresh.click();
  // 发没发出去按发消息的请求数（助手的 …/threads/编号/chat）算：页面上的消息条数会被晚一步读出来的旧会话带偏
  let sent = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/chat')) sent++;
  });
  const sentSince = async () => sent;
  const hint = (await box.getAttribute('placeholder')) ?? '';

  if (mobile) {
    if (/回车发送/.test(hint)) fail(tag + '手机的提示文字不该写回车发送：' + hint);
    await box.fill('第一行');
    await box.press('Enter');
    await box.pressSequentially('第二行');
    await page.waitForTimeout(300);
    if ((await box.inputValue()) !== '第一行\n第二行' || (await sentSince()) !== 0) fail(tag + '手机上回车应换行、不发送：' + JSON.stringify(await box.inputValue()));
    else ok(tag + '回车换行，没发送');
    checkConsole(consoleErrors);
    return context.close();
  }

  if (!/回车发送/.test(hint) || !/Shift\+回车换行/.test(hint)) fail(tag + '提示文字没写怎么发送和换行：' + hint);
  // 空着、只有空格时回车：不发送，也不换行
  await box.focus();
  await box.press('Enter');
  await box.fill('   ');
  await box.press('Enter');
  await page.waitForTimeout(300);
  if ((await box.inputValue()) !== '   ' || (await sentSince()) !== 0) fail(tag + '没内容时回车应什么都不做：' + JSON.stringify(await box.inputValue()));
  else ok(tag + '没内容时回车什么都不做（不发送、不换行）');
  // Shift+回车换行，没发出去
  await box.fill('第一行');
  await box.press('Shift+Enter');
  await box.pressSequentially('第二行');
  await page.waitForTimeout(300);
  if ((await box.inputValue()) !== '第一行\n第二行' || (await sentSince()) !== 0) fail(tag + 'Shift+回车应换行、不发送：' + JSON.stringify(await box.inputValue()));
  else ok(tag + 'Shift+回车换行，没发送');
  // 输入法选字中的回车（isComposing）：不发送，也不拦浏览器的上屏
  const prevented = await box.evaluate((el) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  await page.waitForTimeout(300);
  if (prevented || (await sentSince()) !== 0 || (await box.inputValue()) !== '第一行\n第二行') fail(tag + '输入法选字时回车不该发送或被拦下');
  else ok(tag + '输入法选字时回车不发送');
  // 单按回车：发出去，输入框清空，收到回答
  await box.press('Enter');
  await panel.locator('.ga-message.ga-assistant .ga-text', { hasText: ANSWER }).last().waitFor({ timeout: 15000 }).catch(() => fail(tag + '回车后没等到回答'));
  if ((await sentSince()) !== 1 || (await box.inputValue()) !== '') fail(tag + '回车应发出 1 条并清空输入框：' + (await sentSince()) + ' 条，' + JSON.stringify(await box.inputValue()));
  else ok(tag + '回车发送，输入框清空');
  checkConsole(consoleErrors);
  await context.close();
}

await walk({ tag: '电脑', chrome: { width: 1440, height: 900 } });
await walk({ tag: '手机', chrome: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, mobile: true });
