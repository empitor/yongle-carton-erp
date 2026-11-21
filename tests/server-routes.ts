// 服务端真正挂了哪些地址：按全部选项装一遍 createApp（内存库、临时目录、假模型），装的时候记下每个 express
// 路由器挂了哪些子路由器和路由，拼成完整地址，连同请求方法和注册它的源文件（调用栈里第一个 server/ 下的文件）。
// 给“登记的地址都还在”（功能清单的接口、地址前缀归属）和“写地址都登记在一条业务动作上”这类检查用。
import express from 'express';
import { createApp } from '../server/app.js';
import { AuthManager, ProblemLog } from '../server/core/index.js';
import { assistantFixture } from './assistant-fixture.js';

type Fn = (...args: unknown[]) => unknown;
type Registered = { path: string; route: { methods: Record<string, boolean> }; file: string };
/** express 路由器原型上要换掉的两个方法（装的时候记下挂了什么） */
type RouterProto = { use: Fn; route: (path: unknown) => Registered['route'] };
const isRouterProto = (v: unknown): v is RouterProto =>
  (typeof v === 'object' || typeof v === 'function') && v !== null && 'use' in v && typeof v.use === 'function' && 'route' in v && typeof v.route === 'function';
/** 一条路由：地址拆成段，methods 是小写的请求方法，file 是注册它的源文件（相对项目根、正斜杠） */
type ServerRoute = { segments: string[]; methods: string[]; file: string };
const segments = (path: string) => path.split('?')[0].split('/').filter(Boolean);
const serverFrame = /[\\/](server[\\/][^:()]+\.ts)/;
/** 按接口表注册路由的 route()：它替调用方注册，注册文件算调用它的那个文件 */
const registrar = 'server/core/route.ts';
const callerFile = () =>
  (new Error().stack ?? '')
    .split('\n')
    .map((l) => serverFrame.exec(l)?.[1]?.replace(/\\/g, '/'))
    .find((f) => f !== undefined && f !== registrar) ?? '';

/** 装一遍应用，返回全部路由（前端页面的兜底路由 /{*path} 不算） */
function collect(): ServerRoute[] {
  const proto: unknown = express.Router.prototype;
  if (!isRouterProto(proto)) throw new Error('express 的路由器原型上没有 use、route，认不出挂了哪些路由');
  const { use, route } = proto;
  const mounts = new Map<object, [string, object][]>(), paths = new Map<object, Registered[]>();
  const list = <T>(m: Map<object, T[]>, k: object) => {
    const found = m.get(k);
    if (found) return found;
    const made: T[] = [];
    m.set(k, made);
    return made;
  };
  proto.use = function (this: object, ...args: unknown[]) {
    const at = typeof args[0] === 'string' ? args[0] : '/';
    for (const fn of args.flat()) if (typeof fn === 'function' && 'stack' in fn) list(mounts, this).push([at, fn]);
    return use.apply(this, args);
  };
  proto.route = function (this: object, path: unknown) {
    const r = route.call(this, path);
    // 一条路由挂几个地址的写法（router.post(['/setup', '/login'], …)）每个地址各算一条
    for (const p of [path].flat()) if (typeof p === 'string') list(paths, this).push({ path: p, route: r, file: callerFile() });
    return r;
  };
  const f = assistantFixture();
  const auth = new AuthManager(':memory:');
  const problems = new ProblemLog();
  try {
    // 和正式装配一样：助手、识别导入、正式导入、到货识别、提示词设置页用的是同一套
    const app = createApp(f.store, {
      auth,
      assistant: f.manager,
      aiSettings: f.settings,
      imports: f.deps.imports,
      execution: f.deps.execution,
      receiptAi: f.deps.receiptAi,
      promptModules: f.deps.prompts,
      problems,
    });
    const out: ServerRoute[] = [];
    const walk = (router: object, prefix: string[]) => {
      for (const p of paths.get(router) || [])
        if (!p.path.includes('*'))
          out.push({ segments: [...prefix, ...segments(p.path)], methods: Object.keys(p.route.methods), file: p.file });
      for (const [at, child] of mounts.get(router) || []) walk(child, [...prefix, ...segments(at)]);
    };
    walk(app.router, []);
    return out;
  } finally {
    Object.assign(proto, { use, route });
    problems.close();
    auth.close();
    f.close();
  }
}

let routes: ServerRoute[] | undefined;
const same = (want: string[], route: string[]) =>
  want.every((s, i) => route[i] === s || (route[i]?.startsWith(':') && route[i] !== undefined));

/** 有路由挂在这个前缀下面（或者就是它） */
export const hasRouteUnder = (prefix: string) => {
  const want = segments(prefix);
  return (routes ??= collect()).some((r) => r.segments.length >= want.length && same(want, r.segments));
};

/** 全部路由：一条路由一个方法一条，method 大写，path 去掉 /api、变量段统一写成 :id（'/flow/:id/correct'），file 是注册它的源文件 */
export const serverRouteList = () =>
  (routes ??= collect()).flatMap((r) =>
    r.methods.map((m) => ({
      method: m.toUpperCase(),
      path: '/' + r.segments.slice(1).map((s) => (s.startsWith(':') ? ':id' : s)).join('/'),
      file: r.file,
    })),
  );
