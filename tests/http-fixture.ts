// 起真实服务的测试共用的准备：随机端口起服务、建第一个管理员、拿登录 cookie 和请求头、关服务。
// 部署模式（本机入口 + 代理入口）用 startProxied。
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type RequestListener } from 'node:http';
import { createApp } from '../server/app.js';
import { AuthManager } from '../server/accounts/index.js';
import type { Actor } from '../server/core/actor.js';
import { permissionNames, userRoles } from '../shared/core/accounts.js';
import { pageActor } from './actor-fixture.js';
import type { Store } from '../server/core/db.js';
import { readDeployment, type Deployment } from '../server/core/deployment.js';
import { ProblemLog } from '../server/core/index.js';

/** createApp 的选项；出错记录不给时夹具给一个内存库（testProblems），服务关掉时一起关 */
export type AppOptions = Omit<Parameters<typeof createApp>[1], 'problems'> & { problems?: ProblemLog };
/** 测试用的出错记录：内存库，和正式的同一个类（createApp 必传，测试不看出错记录的给它） */
export const testProblems = () => new ProblemLog();
/** 选项里没给出错记录就给一个内存库；owned 是夹具自己建的（关服务时关掉） */
function withProblems<T extends { problems?: ProblemLog }>({ problems, ...rest }: T) {
  if (problems) return { options: { ...rest, problems }, owned: null };
  const own = testProblems();
  return { options: { ...rest, problems: own }, owned: own };
}
export type Account = { name: string; password: string };
export const testAdmin: Account = { name: '虚构管理员', password: 'Fictional-admin-123' };
/** 有响应头的回答：fetch 的 Response，或 startProxied 的 call() 回答 */
type Answered = Response | { headers: IncomingHttpHeaders };
/** 回答发的第一条 Set-Cookie 原文（带 Path、Secure 这些属性）；没发就让测试失败 */
export function setCookieOf(r: Answered): string {
  const cookie = r instanceof Response ? r.headers.get('set-cookie') : r.headers['set-cookie']?.[0];
  assert.ok(cookie, '回答发了 Set-Cookie');
  return cookie;
}
/** 回答发的登录 cookie（名=值），后面的请求照这个带；没发就让测试失败 */
export const cookieOf = (r: Answered) => setCookieOf(r).split(';')[0];

/** 在 127.0.0.1 的随机端口起服务：origin 不带 /api，api 带。 */
export async function listen(handler: RequestListener) {
  const server = createServer(handler);
  // 测试中同步准备数据可能跨过空闲期限。连接由夹具的 close() 统一关闭。
  server.keepAliveTimeout = 0;
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务没有拿到端口');
  const port = address.port,
    origin = 'http://127.0.0.1:' + port;
  // 先断开还连着的连接再关：哪条测试中途失败、响应没读完时，server.close() 会一直等那条连接，整份测试就卡死不结束
  const close = () =>
    new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  return { server, port, origin, api: origin + '/api', close };
}

type SendOptions = { csrf?: string | null; method?: string; headers?: Record<string, string> };

/**
 * 起带登录的服务。createApp 的选项照传，没给 auth 就建一个内存账号库。
 * 默认先建好第一个管理员（admin，默认 testAdmin），cookie、headers 是它的；admin: false 时先不建，要用时调 setup()。
 * close() 关服务和账号库（传进来的 auth 也关），store 由调用方关。
 */
export async function startHttp(store: Store, options: AppOptions & { admin?: Account | false } = {}) {
  const { admin = testAdmin, ...appOptions } = options;
  const auth = appOptions.auth ?? new AuthManager(':memory:');
  const app = withProblems({ ...appOptions, auth });
  const served = await listen(createApp(store, app.options));
  /** path 从 /api 后面写。没有 body 是 GET；默认不带 cookie、带页面凭证（csrf: null 不带）。读完响应才返回，不能用于 SSE。 */
  const send = async (path: string, body?: unknown, cookie = '', o: SendOptions = {}) => {
    const csrf = o.csrf === undefined ? auth.csrf : o.csrf;
    const response = await fetch(served.api + path, {
      method: o.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        ...(csrf ? { 'X-ERP-Auth-Token': csrf } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...o.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // 只看状态码的用例也先读完，不留没读的响应，并行时连接回收不出岔子
    await response.clone().arrayBuffer();
    return response;
  };
  const login = async (name: string, password: string) => {
    const response = await send('/auth/login', { name, password });
    assert.equal(response.status, 200, name + ' 应该能登录');
    return cookieOf(response);
  };
  let owner = admin || testAdmin;
  const headers: Record<string, string> = {};
  const http = {
    ...served,
    auth,
    send,
    login,
    /** 管理员的登录 cookie；headers 是 JSON + 页面凭证 + 这个 cookie */
    cookie: '',
    headers,
    /** 管理员进超级管理员模式（改账号、AI 设置、提示词、机器人、工具启停要先进），15 分钟，按账号库的时钟算 */
    async enterSuperMode(cookie?: string, password = owner.password): Promise<void> {
      const response = await send('/auth/super-admin/enter', { password }, cookie ?? http.cookie);
      assert.equal(response.status, 200, '进超级管理员模式');
    },
    async setup(account: Account = testAdmin) {
      const response = await send('/auth/setup', account);
      assert.equal(response.status, 200, '建第一个管理员');
      owner = account;
      http.cookie = cookieOf(response);
      http.headers = { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf, Cookie: http.cookie };
      return http.cookie;
    },
    /** 管理员身份的 GET，只带 cookie */
    get: (path: string) => fetch(served.api + path, { headers: { Cookie: http.cookie } }),
    /** 管理员身份的 POST，带页面凭证（传空串或 null 就不带） */
    post: (path: string, body: unknown, csrf: string | null = auth.csrf) =>
      fetch(served.api + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: http.cookie, ...(csrf ? { 'X-ERP-Auth-Token': csrf } : {}) },
        body: JSON.stringify(body),
      }),
    async close() {
      await served.close();
      auth.close();
      app.owned?.close();
    },
  };
  if (admin) await http.setup(admin);
  return http;
}

const stateActorSchema = z.object({
  id: z.string(),
  name: z.string(),
  permissions: z.array(z.enum(permissionNames)),
  role: z.enum(userRoles).optional(),
  superAdminUntil: z.number().optional(),
  superAdminMode: z.boolean().optional(),
  localAdministrator: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
});
/** 登录状态（/auth/state）回答里的账号，没登录是 null；和登录会话一样记成从页面来 */
export function stateActor(state: Record<string, unknown>): Actor | null {
  return state.actor === null ? null : pageActor(stateActorSchema.parse(state.actor));
}
/** 账号管理（/auth/users）回答里的账号列表 */
export const userList = (value: Record<string, unknown>) =>
  z.object({ users: z.array(z.looseObject({ id: z.string(), name: z.string() })) }).parse(value).users;

type CallOptions = { body?: unknown; headers?: Record<string, string>; cookie?: string; method?: string; raw?: Buffer };
const jsonObject = z.record(z.string(), z.unknown());
/** call 的回答：状态码、响应头、正文原文；正文是 JSON 对象时 value 是它，不是时是 {} */
type Answer = { code: number; headers: IncomingMessage['headers']; value: Record<string, unknown>; text: string };

/**
 * 部署模式：本机入口和代理入口两个口接同一个服务，允许的域名是 host。
 * fetch 改不了 Host，所以 call 用 http.request；remote 是从域名经代理来的请求头。
 * makeAuth 默认是内存账号库（开着本机管理）；restart() 关掉账号库、按 makeAuth 重开并换上新服务。
 */
export async function startProxied(
  store: Store,
  options: Omit<AppOptions, 'auth' | 'deployment'> = {},
  setup: { makeAuth?: (deployment: Deployment) => AuthManager; clientIp?: string } = {},
) {
  const makeAuth =
    setup.makeAuth ?? ((deployment) => new AuthManager(':memory:', Date.now, { deployment, localAdministration: true }));
  let handle: RequestListener = () => {};
  const local = await listen((q, s) => handle(q, s)),
    proxy = await listen((q, s) => handle(q, s));
  const host = 'erp.example.invalid';
  const deployment = readDeployment(
    { ERP_DEPLOYMENT: '1', ERP_ALLOWED_HOSTS: host, ERP_PROXY_PORT: String(proxy.port) },
    local.port,
  );
  if (!deployment) throw new Error('部署模式的环境变量没有读成部署配置');
  let auth = makeAuth(deployment);
  const app = withProblems(options);
  handle = createApp(store, { ...app.options, auth, deployment });
  const call = (port: number, path: string, o: CallOptions = {}) => {
    const data = o.raw ?? (o.body === undefined ? '' : JSON.stringify(o.body));
    return new Promise<Answer>((done, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api' + path,
          method: o.method ?? (data ? 'POST' : 'GET'),
          headers: {
            'content-type': 'application/json',
            'x-erp-auth-token': auth.csrf,
            ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
            ...(o.cookie ? { cookie: o.cookie } : {}),
            ...o.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            if (res.statusCode === undefined) return reject(new Error('响应没有状态码'));
            done({ code: res.statusCode, headers: res.headers, value: text.startsWith('{') ? jsonObject.parse(JSON.parse(text)) : {}, text });
          });
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  };
  return {
    host,
    remote: { host, origin: 'https://' + host, 'x-erp-client-ip': setup.clientIp ?? '192.0.2.18' },
    deployment,
    localPort: local.port,
    proxyPort: proxy.port,
    get auth() {
      return auth;
    },
    call,
    restart() {
      auth.close();
      auth = makeAuth(deployment);
      handle = createApp(store, { ...app.options, auth, deployment });
    },
    async close() {
      await Promise.all([local.close(), proxy.close()]);
      auth.close();
      app.owned?.close();
    },
  };
}
