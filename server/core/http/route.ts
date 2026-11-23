import type { CookieOptions, Request, Response, Router } from 'express';
import { splitApiKey, type ApiKey, type ApiParamName, type ApiTable } from '../../../shared/core/index.js';
import { AppError } from './errors.js';

/*
 * 按接口表注册路由（表的写法见 shared/core/api-table.ts）：
 *   const on = route<RecordsApi>(router);
 *   on('GET /customers/:id', ({ param }) => sales(store).customer(Number(param('id'))) ?? notFound('客户不存在'));
 *   on('POST /customers', ({ body, req }) => save(body, actorOf(req)), { status: 201 });
 * 处理函数的返回值按表检查；路径参数是文字，query、body 是 unknown，进服务先用 zod 校验。req 只用来认人、读请求头，
 * 响应只能经 reply 写缓存头和 Cookie（见 RouteReply）。出错照常抛（AppError 等），由全站的出错处理回答；找不到用 notFound(说明)，就是 AppError 的 404。
 */

/** 服务端注册的键：不带问号的那个（带问号的是同一地址按查询参数分出来的形状） */
type ServedKey<A> = Exclude<keyof A & ApiKey, `${string}?${string}`>;
/** 一个服务端地址要回的：这个键连同按查询参数分出来的键（'GET /orders' 和 'GET /orders?withMetrics=1'）的并集 */
type ServedResponse<A, K extends string> = A[Extract<keyof A, K | `${K}?${string}`>] extends { response: infer R } ? R : never;

/** 拒绝能用的状态码：填得不对、没登录或密码不对、凭证过期或不许、冲突、太频繁 */
type RefusalStatus = 400 | 401 | 403 | 409 | 429;
/**
 * 不经全站出错处理、只回一句话的拒绝：状态码加 { message }（不带类别 code）；没给说法的只回状态码（express 的 sendStatus）。
 * 登录、退出、申请账号、页面上报这几个接口一直这么回，页面按状态码和这句话认；别的接口出错照常抛 AppError。
 */
class Refusal {
  readonly #status: RefusalStatus;
  readonly #message: string | undefined;
  constructor(status: RefusalStatus, message?: string) {
    this.#status = status;
    this.#message = message;
  }
  answer(res: Response) {
    if (this.#message === undefined) res.sendStatus(this.#status);
    else res.status(this.#status).json({ message: this.#message });
  }
}
/** 处理函数返回它就回这个状态码和这句话（见 Refusal），返回值不按表查 */
export const refuse = (status: RefusalStatus, message?: string) => new Refusal(status, message);
/** 办完了、没有别的要回的接口回它（表里写 { ok: true }）；写成有类型的常量，和 refuse 一起返回时 true 不会被放宽成 boolean */
export const done: { readonly ok: true } = { ok: true };
type Answer<A, K extends string> = ServedResponse<A, K> | Refusal;

/**
 * 处理函数能动的响应只有这几样，都不返回东西：拿不到 Response，也就发不了表外的正文、改不了状态码和正文类型。
 * 登录、退出写清会话 Cookie，使用手册写缓存头。
 */
export type RouteReply = {
  /** 缓存头（Cache-Control） */
  cache(value: string): void;
  cookie(name: string, value: string, options: CookieOptions): void;
  clearCookie(name: string, options: CookieOptions): void;
};
function replyTo(res: Response): RouteReply {
  return {
    cache(value) {
      res.set('Cache-Control', value);
    },
    cookie(name, value, options) {
      res.cookie(name, value, options);
    },
    clearCookie(name, options) {
      res.clearCookie(name, options);
    },
  };
}

type RouteInput<K> = {
  /** 路径参数（文字）：名字只能是键里写的（'GET /orders/:id' 只有 'id'） */
  param: (name: ApiParamName<K>) => string;
  query: unknown;
  body: unknown;
  req: Request;
  reply: RouteReply;
};

/** 要找的记录不存在：抛 404 的 AppError（全站出错处理回 { message, code: 'not-found' }），能写在 ?? 后面；路由、服务里都能用 */
export function notFound(message: string): never {
  throw new AppError(message, 404, 'not-found');
}

const verbs = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete' } as const;
/** 键里的 :name 段 express 给的总是一段文字（通配段才给数组，接口表的键不用通配） */
function paramOf(req: Request, name: string) {
  const value = req.params[name];
  if (typeof value !== 'string') throw new Error('路径参数 ' + name + ' 不是一段文字：' + req.path);
  return value;
}

/** 键里的地址去掉挂载段；键不在挂载位置下面是接口表或挂载写错了，注册时就报错 */
function mountedPath(path: string, mount: string) {
  if (!mount) return path;
  if (path !== mount && !path.startsWith(mount + '/')) throw new Error('接口表的键 ' + path + ' 不在挂载位置 ' + mount + ' 下');
  return path.slice(mount.length) || '/';
}

/**
 * mount：这个 router 在 /api 下挂的位置（app.ts 里 app.use('/api/inbox', …) 就是 '/inbox'；挂在 /api 本身的不传）。
 * 键照样写完整地址（'GET /inbox/:id'，前端 call() 按键拼地址），注册时去掉这一段。
 */
export function route<A extends ApiTable>(router: Router, mount = '') {
  return <K extends ServedKey<A>>(
    key: K,
    handler: (input: RouteInput<K>) => Answer<A, K> | Promise<Answer<A, K>>,
    options: { status?: number } = {},
  ) => {
    const { method, path } = splitApiKey(key);
    router.route(mountedPath(path, mount))[verbs[method]](async (req: Request, res: Response) => {
      const out = await handler({ param: (name) => paramOf(req, name), query: req.query, body: req.body, req, reply: replyTo(res) });
      if (out instanceof Refusal) out.answer(res);
      else res.status(options.status ?? 200).json(out);
    });
  };
}
