import { useEffect, useRef } from 'react';
import { z } from 'zod';
import { closeTopLayer } from './ui/index';
import { receiveAppShare } from './import/index';
import type { createAppSaver } from './app-save';

/*
 * 安卓 App（apps/android）的接通通道，消息约定见 docs/架构说明.md“安卓 App 通道”。
 * App 加载完 ERP 页面后发来接通消息并附一个专用端口，之后返回键（back）、分享文件（share-*）、
 * 保存文件（save-*，src/app-save.ts，由 main.tsx 建好交进来）都走这个端口；又收到接通消息就换新端口、关掉旧的。
 * 浏览器和 Windows 外壳里没人发接通消息，这里什么都不做，行为不变。
 */

/** App 在 User-Agent 末尾加的标记（别的网页改不了 ERP 页面的 User-Agent） */
const APP_MARK = / YongleErpAndroid\/[\w.-]+$/;

/** 是不是在安卓 App 里打开的 */
export const inAndroidApp = (userAgent: string) => APP_MARK.test(userAgent);
/** Windows 客户端（apps/desktop，Tauri）往它打开的每个网页注入的对象；浏览器里没有 */
const DESKTOP_MARK = '__TAURI_INTERNALS__';
/** 是不是在两个应用程序（安卓 App、Windows 客户端）里打开的，约定见 docs/架构说明.md“网页怎么认出两个外壳” */
export const inShellApp = (win: { navigator: { userAgent: string } }) =>
  inAndroidApp(win.navigator.userAgent) || DESKTOP_MARK in win;
/** 接通消息，必须一字不差 */
const HELLO = '{"type":"erp-app-bridge","version":1}';

const backMessage = z.object({ type: z.literal('back'), id: z.number().int() }).strict();

/** 只认这几样：App 的标记、顶层窗口、不是别的窗口发的（App 发的没有来源窗口）、恰好一个端口、内容一字不差 */
export function acceptHandshake(
  event: { data: unknown; source: unknown; ports: readonly unknown[] },
  env: { userAgent: string; topLevel: boolean },
): boolean {
  return (
    inAndroidApp(env.userAgent) &&
    env.topLevel &&
    event.source === null &&
    event.ports.length === 1 &&
    event.data === HELLO
  );
}

type Home = { atHome: () => boolean; go: () => void };
/** 登录后由 Shell 登记首页；没登录时为 null */
let home: Home | null = null;

/**
 * 返回键：先关最上面一层弹层（提交中就留在这一层）；没有弹层时，不在首页就回首页；
 * 已在首页或还没登录回 home，由 App 提示“再按一次返回退出”。
 */
export function backResult(): 'handled' | 'home' {
  if (closeTopLayer() !== 'none') return 'handled';
  if (!home || home.atHome()) return 'home';
  home.go();
  return 'handled';
}

/** 登记首页，返回注销函数（注销后按没登录处理） */
export function registerAppHome(next: Home): () => void {
  home = next;
  return () => {
    if (home === next) home = null;
  };
}

/** Shell 登记首页：atHome 是不是正在首页，go 回首页 */
export function useAppHome(atHome: boolean, go: () => void) {
  const latest = useRef({ atHome, go });
  useEffect(() => {
    latest.current = { atHome, go };
  });
  useEffect(() => registerAppHome({ atHome: () => latest.current.atHome, go: () => latest.current.go() }), []);
}

const parse = (data: unknown): unknown => {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
};

type Send = (message: object) => void;
type Saver = ReturnType<typeof createAppSaver>;

/** 端口上收到 App 的一句话：back 回 back-result；save-result 交给保存；share-* 交给 AI 导入；别的不认 */
function answer(send: Send, saver: Saver, data: unknown) {
  const message = parse(data);
  const back = backMessage.safeParse(message);
  if (back.success) send({ type: 'back-result', id: back.data.id, result: backResult() });
  else if (!saver.receive(message) && !receiveAppShare(message, send)) console.warn('安卓 App 通道上不认识的消息');
}

type HelloEvent = { data: unknown; source: unknown; ports: readonly MessagePort[] };
/** 收接通消息的窗口（就是 window；测试里换成假的） */
type Host = {
  addEventListener(type: 'message', listener: (event: HelloEvent) => void): void;
  navigator: { userAgent: string };
  top: unknown;
};

/** 页面启动时调一次：等 App 的接通消息，接通后回 bridge-ready；saver 收 App 回的保存结果，接通新端口时交给它 */
export function startAppBridge(win: Host, saver: Saver) {
  let current: MessagePort | null = null;
  const onMessage = (event: HelloEvent) => {
    const port = event.ports[0];
    if (!port || !acceptHandshake(event, { userAgent: win.navigator.userAgent, topLevel: win.top === win })) return;
    current?.close();
    current = port;
    const send: Send = (message) => port.postMessage(JSON.stringify(message));
    saver.connect(send);
    port.onmessage = (e) => answer(send, saver, e.data);
    send({ type: 'bridge-ready' });
  };
  win.addEventListener('message', onMessage);
}
