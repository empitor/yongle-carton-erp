// 安卓 App 的接通通道（src/app-bridge.ts）：只认 App 发来的接通；返回键先关弹层、再回首页、最后才算在首页；
// 又接通时换新端口；保存文件的回话交给保存那一头
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptHandshake, backResult, registerAppHome, startAppBridge } from '../src/app-bridge.js';
import { registerBackLayer } from '../src/ui/back-layers.js';
import { createAppSaver } from '../src/app-save.js';

const HELLO = '{"type":"erp-app-bridge","version":1}';
const APP_UA = 'Mozilla/5.0 (Linux; Android 16) Chrome/156.0 Mobile Safari/537.36 YongleErpAndroid/0.1.0';
const app = { userAgent: APP_UA, topLevel: true };
const hello = { data: HELLO, source: null, ports: [{}] };
let cleanup: (() => void)[] = [];

afterEach(() => {
  for (const off of cleanup) off();
  cleanup = [];
});

test('App 里的顶层页面收到一字不差的接通消息时接通', () => {
  assert.equal(acceptHandshake(hello, app), true);
});

test('普通浏览器（没有 App 标记）不接通', () => {
  assert.equal(acceptHandshake(hello, { ...app, userAgent: APP_UA.replace(' YongleErpAndroid/0.1.0', '') }), false);
  assert.equal(acceptHandshake(hello, { ...app, userAgent: APP_UA + ' Other/1' }), false);
});

test('内嵌框架、别的窗口发来、端口不是一个时不接通', () => {
  assert.equal(acceptHandshake(hello, { ...app, topLevel: false }), false);
  assert.equal(acceptHandshake({ ...hello, source: {} }, app), false);
  assert.equal(acceptHandshake({ ...hello, ports: [] }, app), false);
  assert.equal(acceptHandshake({ ...hello, ports: [{}, {}] }, app), false);
});

test('接通消息内容有一点不同就不接通', () => {
  assert.equal(acceptHandshake({ ...hello, data: JSON.parse(HELLO) as unknown }, app), false);
  assert.equal(acceptHandshake({ ...hello, data: '{"type":"erp-app-bridge","version":2}' }, app), false);
  assert.equal(acceptHandshake({ ...hello, data: '{"type":"erp-app-bridge","version":1,"x":1}' }, app), false);
});

function home(atHome: boolean) {
  const went: string[] = [];
  cleanup.push(registerAppHome({ atHome: () => atHome, go: () => went.push('今日') }));
  return went;
}

test('开着弹层时按返回只关那一层，不回首页', () => {
  const went = home(false),
    closed: string[] = [];
  cleanup.push(registerBackLayer({ close: () => closed.push('编辑库存'), busy: () => false }));
  assert.equal(backResult(), 'handled');
  assert.deepEqual(closed, ['编辑库存']);
  assert.deepEqual(went, []);
});

test('提交中的弹层拦下返回时留在当前层，也不算在首页', () => {
  home(true);
  cleanup.push(registerBackLayer({ close: () => assert.fail('不该关'), busy: () => true }));
  assert.equal(backResult(), 'handled');
});

test('没有弹层、在独立业务页时一次回首页', () => {
  const went = home(false);
  assert.equal(backResult(), 'handled');
  assert.deepEqual(went, ['今日']);
});

test('已在首页且没有弹层时告诉 App 在首页', () => {
  const went = home(true);
  assert.equal(backResult(), 'home');
  assert.deepEqual(went, []);
});

test('还没登录（没有登记首页）时按在首页处理', () => {
  assert.equal(backResult(), 'home');
});

type Hello = { data: unknown; source: unknown; ports: readonly MessagePort[] };
/** 假窗口：收下 message 监听，测试里自己派发；起好通道（saver 是这一条测试自己的） */
function bridge(userAgent: string, saver = createAppSaver(1000)) {
  let listener: ((event: Hello) => void) | undefined;
  const win = {
    navigator: { userAgent },
    top: null as unknown,
    addEventListener: (_type: 'message', next: (event: Hello) => void) => {
      listener = next;
    },
  };
  win.top = win;
  startAppBridge(win, saver);
  return (event: Hello) => listener?.(event);
}
/** App 那头：新开一对端口发接通消息，收到的话都记下 */
function connect(dispatch: (event: Hello) => void) {
  const channel = new MessageChannel(),
    got: unknown[] = [];
  cleanup.push(() => channel.port1.close());
  channel.port1.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  dispatch({ data: HELLO, source: null, ports: [channel.port2] });
  return { port: channel.port1, got };
}
/** 等 App 那头收到第 count 句话 */
async function heard(got: unknown[], count: number) {
  for (let i = 0; i < 100 && got.length < count; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  return got.slice(0, count);
}

test('接通后先回 bridge-ready，再按编号回返回结果', async () => {
  home(true);
  const peer = connect(bridge(APP_UA));
  assert.deepEqual(await heard(peer.got, 1), [{ type: 'bridge-ready' }]);
  peer.port.postMessage(JSON.stringify({ type: 'back', id: 7 }));
  assert.deepEqual((await heard(peer.got, 2))[1], { type: 'back-result', id: 7, result: 'home' });
});

test('普通浏览器里收到同样的消息也不接通、不回话', async () => {
  const peer = connect(bridge('Mozilla/5.0 Chrome/156.0'));
  // 走完几轮消息后还没收到回话，就是没接通
  await heard(peer.got, 1);
  assert.deepEqual(peer.got, []);
});

test('又收到接通消息时换成新端口：旧端口关掉、不再回话，新端口照常回', async () => {
  home(true);
  const dispatch = bridge(APP_UA),
    old = connect(dispatch);
  await heard(old.got, 1);
  const fresh = connect(dispatch);
  await heard(fresh.got, 1);
  old.port.postMessage(JSON.stringify({ type: 'back', id: 1 }));
  fresh.port.postMessage(JSON.stringify({ type: 'back', id: 2 }));
  assert.deepEqual((await heard(fresh.got, 2))[1], { type: 'back-result', id: 2, result: 'home' });
  assert.deepEqual(await heard(old.got, 2), [{ type: 'bridge-ready' }]);
});

test('保存文件走通道：发 save-file，App 回存好了才算完', async () => {
  const saver = createAppSaver(1000),
    peer = connect(bridge(APP_UA, saver));
  await heard(peer.got, 1);
  const saved = saver.save(new TextEncoder().encode('虚构送货单').buffer, 'application/pdf', '送货单.pdf');
  const [, request] = await heard(peer.got, 2);
  assert.deepEqual(request, {
    type: 'save-file',
    id: 1,
    name: '送货单.pdf',
    mime: 'application/pdf',
    data: Buffer.from('虚构送货单').toString('base64'),
  });
  peer.port.postMessage(JSON.stringify({ type: 'save-result', id: 1, ok: true }));
  await saved;
});
