// 接口表的两头：服务端 route()（server/core/http/route.ts）、前端 call()（src/ui/call.ts）。
// 运行时的行为（状态码、路径参数、查询参数、正文、返回）用真实的 express 和替身 fetch 测；
// 类型对不上必须编译不过的写法写在文件末尾、用 @ts-expect-error 标着，由 npm run typecheck 守：哪天那一行能编译了，tsc 报“没用上的 @ts-expect-error”。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { z } from 'zod';
import { AppError, notFound, route, refuse } from '../server/core/index.js';
import { apiErrorHandler } from '../server/http-errors.js';
import { call } from '../src/ui/call.js';
import { signedOutMessage } from '../src/ui/http.js';
import { json, signedIn, stubBrowser } from './browser-fixture.js';
import { listen } from './http-fixture.js';

type Item = { id: number; name: string; updatedAt: string };
type TestApi = {
  'GET /items': { query?: { q?: string }; response: Item[] };
  'GET /items?withMetrics=1': { query?: { q?: string }; response: { rows: Item[]; total: number } };
  'GET /items/:id': { response: Item };
  'POST /items': { body: { name: string }; response: Item };
  'PUT /items/:id/parts/:part': { body: { name: string }; response: Item };
  'DELETE /items/:id': { body: { version: number }; response: { removed: number } };
};
const item: Item = { id: 7, name: '虚构纸箱', updatedAt: '2026-01-02T03:04:05.000Z' };

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

/** 起一个按 TestApi 注册路由的服务（出错交给全站的出错处理 apiErrorHandler），跑完关掉；seen 记下处理函数拿到的 query、body */
async function withItems(run: (send: Send, seen: unknown[]) => Promise<void>) {
  const seen: unknown[] = [];
  const router = express.Router();
  const on = route<TestApi>(router);
  on('GET /items', ({ query }) => {
    seen.push(query);
    return z.object({ withMetrics: z.literal('1').optional() }).parse(query).withMetrics ? { rows: [item], total: 1 } : [item];
  });
  on('GET /items/:id', ({ param }) => (param('id') === '7' ? item : notFound('没有这一项')));
  on(
    'POST /items',
    ({ body }) => {
      seen.push(body);
      return Promise.resolve(item);
    },
    { status: 201 },
  );
  on('PUT /items/:id/parts/:part', ({ param }) => ({ ...item, name: param('id') + '/' + param('part') }));
  on('DELETE /items/:id', () => {
    throw new AppError('这一项不能删', 409);
  });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use(apiErrorHandler);
  const served = await listen(app);
  const send: Send = (method, path, body) =>
    fetch(served.api + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    await run(send, seen);
  } finally {
    await served.close();
  }
}
/** 状态码和正文 */
const reply = async (r: Response) => {
  const body: unknown = await r.json();
  return [r.status, body];
};

test('route()：处理函数的返回值回 200；给了 { status: 201 } 的回 201', () =>
  withItems(async (send) => {
    assert.deepEqual(await reply(await send('GET', '/items')), [200, [item]]);
    assert.deepEqual(await reply(await send('POST', '/items', { name: '虚构纸箱' })), [201, item]);
  }));

test('route()：路径参数按键里的名字取，交给处理函数的是文字', () =>
  withItems(async (send) => {
    assert.deepEqual(await reply(await send('PUT', '/items/7/parts/lid', { name: 'x' })), [200, { ...item, name: '7/lid' }]);
  }));

test('route()：query、body 原样交给处理函数，按查询参数回不同形状', () =>
  withItems(async (send, seen) => {
    assert.deepEqual(await reply(await send('GET', '/items?withMetrics=1&q=' + encodeURIComponent('纸箱'))), [200, { rows: [item], total: 1 }]);
    await send('POST', '/items', { name: '虚构纸箱' });
    // express 的查询参数对象没有原型，比内容
    assert.deepEqual([Object.assign({}, seen[0]), seen[1]], [{ withMetrics: '1', q: '纸箱' }, { name: '虚构纸箱' }]);
  }));

test('route()：notFound 回 404，正文是全站出错处理给的说明', () =>
  withItems(async (send) => {
    assert.deepEqual(await reply(await send('GET', '/items/8')), [404, { message: '没有这一项', code: 'not-found' }]);
  }));

test('route()：处理函数抛的错交给全站的出错处理', () =>
  withItems(async (send) => {
    assert.deepEqual(await reply(await send('DELETE', '/items/7', { version: 1 })), [409, { message: '这一项不能删', code: 'validation' }]);
  }));

test('route()：router 挂在 /api 下的一段（mount）时，键写完整地址、注册时去掉这一段；键不在它下面的注册时就报错', async () => {
  const router = express.Router();
  const on = route<TestApi>(router, '/items');
  on('GET /items', () => [item]);
  on('GET /items/:id', ({ param }) => ({ ...item, name: param('id') }));
  assert.throws(() => route<TestApi>(express.Router(), '/parts')('GET /items', () => [item]), /不在挂载位置 \/parts 下/);
  const app = express();
  app.use('/api/items', router);
  const served = await listen(app);
  try {
    assert.deepEqual(await reply(await fetch(served.api + '/items')), [200, [item]]);
    assert.deepEqual(await reply(await fetch(served.api + '/items/9')), [200, { ...item, name: '9' }]);
  } finally {
    await served.close();
  }
});

test('route()：返回 refuse(状态码, 说法) 回这个状态码和 { message }（不带 code），没给说法只回状态码；reply 能写缓存头和 Cookie', async () => {
  const router = express.Router();
  const on = route<TestApi>(router);
  on('GET /items', (input) => {
    input.reply.cache('no-cache');
    input.reply.cookie('seen', '1', {});
    return [item];
  });
  on('POST /items', () => refuse(429, '提交太频繁'), { status: 201 });
  on('GET /items/:id', () => refuse(403));
  const app = express().use(express.json()).use('/api', router).use(apiErrorHandler);
  const served = await listen(app);
  try {
    const listed = await fetch(served.api + '/items');
    assert.deepEqual([listed.headers.get('cache-control'), listed.headers.get('set-cookie')], ['no-cache', 'seen=1; Path=/']);
    const posted = await fetch(served.api + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.deepEqual(await reply(posted), [429, { message: '提交太频繁' }]);
    const bare = await fetch(served.api + '/items/7');
    assert.deepEqual([bare.status, await bare.text()], [403, 'Forbidden']);
  } finally {
    await served.close();
  }
});

test('call()：按键拼地址（路径参数编码，键里的查询参数在前），读和写都先拿页面凭证再发，写带正文', async () => {
  const browser = stubBrowser((url) => (url === '/api/auth/state' ? signedIn() : json(200, item)));
  const items = call<TestApi>();
  try {
    assert.deepEqual(await items('GET /items?withMetrics=1', { query: { q: '纸 箱' } }), item);
    assert.deepEqual(await items('GET /items/:id', { params: { id: 'a/b' } }), item);
    assert.deepEqual(await items('GET /items'), item);
    assert.deepEqual(await items('POST /items', { body: { name: '虚构纸箱' } }), item);
    assert.deepEqual(await items('PUT /items/:id/parts/:part', { params: { id: 7, part: 'lid' }, body: { name: 'x' } }), item);
    assert.deepEqual(
      browser.calls.map((c) => [c.init?.method ?? 'GET', c.url, new Headers(c.init?.headers).get('X-ERP-Auth-Token'), c.init?.body ?? null]),
      [
        ['GET', '/api/auth/state', null, null],
        ['GET', '/api/items?withMetrics=1&q=%E7%BA%B8+%E7%AE%B1', 'csrf-test', null],
        ['GET', '/api/items/a%2Fb', 'csrf-test', null],
        ['GET', '/api/items', 'csrf-test', null],
        ['POST', '/api/items', 'csrf-test', '{"name":"虚构纸箱"}'],
        ['PUT', '/api/items/7/parts/lid', 'csrf-test', '{"name":"x"}'],
      ],
    );
  } finally {
    browser.restore();
  }
});

test('call()：本地没登录直接说“请先登录账号。”，读写都不发', async () => {
  const browser = stubBrowser((url) =>
    url === '/api/auth/state' ? json(200, { configured: true, actor: null, csrf: 'csrf-test' }) : json(200, item),
  );
  const items = call<TestApi>();
  try {
    await assert.rejects(items('GET /items'), { message: signedOutMessage });
    await assert.rejects(items('POST /items', { body: { name: '虚构纸箱' } }), { message: signedOutMessage });
    assert.deepEqual([...new Set(browser.calls.map((c) => c.url))], ['/api/auth/state']);
  } finally {
    browser.restore();
  }
});

test('call()：浏览器没有 URLSearchParams.size（Safari 16、Chrome 107）时查询参数照样带上', async () => {
  const size = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, 'size');
  const browser = stubBrowser((url) => (url === '/api/auth/state' ? signedIn() : json(200, item)));
  try {
    Reflect.deleteProperty(URLSearchParams.prototype, 'size');
    assert.equal('size' in new URLSearchParams('a=1'), false);
    await call<TestApi>()('GET /items?withMetrics=1', { query: { q: '纸箱' } });
    assert.equal(browser.calls.at(-1)?.url, '/api/items?withMetrics=1&q=%E7%BA%B8%E7%AE%B1');
  } finally {
    if (size) Object.defineProperty(URLSearchParams.prototype, 'size', size);
    browser.restore();
  }
});

/** 只给类型检查看的写法：不运行 */
const typeOnly = (_check: () => unknown) => undefined;

typeOnly(() => {
  const on = route<TestApi>(express.Router());
  // @ts-expect-error 返回值和表对不上
  on('GET /items/:id', () => ({ id: '7' }));
  // @ts-expect-error 路径参数名不在键里
  on('GET /items/:id', ({ param }) => ({ ...item, name: param('name') }));
  // @ts-expect-error 带问号的键是同一地址按查询参数分出来的形状，服务端只注册不带问号的
  on('GET /items?withMetrics=1', () => ({ rows: [], total: 0 }));
  // @ts-expect-error 表里没有的键
  on('GET /things', () => []);
  // @ts-expect-error 处理函数拿不到 Response（没有 res），正文只能按返回值回
  on('GET /items', ({ res }) => [item]);
  // @ts-expect-error reply 的几样都不返回东西，链不出能发正文的 Response
  on('GET /items', ({ reply: r }): express.Response => r.cookie('seen', '1', {}));
  // @ts-expect-error refuse 只收出错的状态码
  on('GET /items', () => refuse(200, '好了'));
  // 同一地址的几种形状：处理函数回哪一种都行
  on('GET /items', () => ({ rows: [], total: 0 }));
});

typeOnly(async () => {
  const items = call<TestApi>();
  // @ts-expect-error 表里没有的键
  await items('GET /things', {});
  // @ts-expect-error 少了路径参数
  await items('GET /items/:id');
  // @ts-expect-error 路径参数名不对
  await items('GET /items/:id', { params: { key: 7 } });
  // @ts-expect-error 写接口少了正文
  await items('POST /items');
  // @ts-expect-error 正文和表对不上
  await items('POST /items', { body: { title: 'x' } });
  // @ts-expect-error 这条接口不收查询参数
  await items('GET /items/:id', { params: { id: 7 }, query: { q: 'x' } });
  const one = await items('GET /items/:id', { params: { id: 7 } });
  // @ts-expect-error 返回值按表有类型：表里没有的字段读不到
  void one.price;
  const page = await items('GET /items?withMetrics=1');
  // @ts-expect-error 带 withMetrics=1 的键回分页，不是数组
  void page.length;
});

typeOnly(() => {
  // @ts-expect-error 写接口必须有正文
  call<{ 'POST /items': { response: Item } }>();
  // @ts-expect-error 响应只能是 JSON 原样来回的值，不能有 Date
  call<{ 'GET /items': { response: { at: Date } } }>();
});
