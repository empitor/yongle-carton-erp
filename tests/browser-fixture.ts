// 前端请求入口（src/ui/http.ts、call.ts）的测试替身：不开浏览器、不连真实服务，fetch 和 window 换成替身。
import { forgetAuthState } from '../src/ui/auth-state.js';

type SentRequest = { url: string; init?: RequestInit };

/** 换掉 fetch 和 window，记下请求和“登录状态变了”的通知。用完调 restore() 还原。 */
export function stubBrowser(
  handler: (url: string, init?: RequestInit) => Response = () => {
    throw new Error('不应发请求');
  },
) {
  const calls: SentRequest[] = [],
    events: string[] = [],
    target = new EventTarget(),
    saved = { fetch: globalThis.fetch, window: Object.getOwnPropertyDescriptor(globalThis, 'window') };
  target.addEventListener('erp-auth-changed', () => events.push('auth'));
  // 每条用例从“还没读过登录状态”开始，不沿用上一条记下的页面凭证
  forgetAuthState();
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true, writable: true });
  return {
    calls,
    events,
    restore() {
      // 记下的登录状态（含页面凭证）是模块里的缓存，用完一起清掉
      forgetAuthState();
      globalThis.fetch = saved.fetch;
      if (saved.window) Object.defineProperty(globalThis, 'window', saved.window);
      else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** 登录着、有业务编辑权限的登录状态，页面凭证是 csrf-test */
export const signedIn = () =>
  json(200, {
    configured: true,
    actor: { id: 'u1', name: '虚构用户', permissions: ['business:edit'] },
    csrf: 'csrf-test',
  });
