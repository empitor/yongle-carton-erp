import type { Request, RequestHandler, Response } from 'express';
import type { Actor } from '../actor.js';
import { Throttle } from '../throttle.js';
import { operationName, routePath } from './operation-names.js';
import { errorReason, problemCategory, stackLines } from './problem-kinds.js';
import { PROBLEM_WINDOW, type ProblemLog } from './problem-log.js';

/**
 * 记下 /api 上失败的回答（服务端出错和被拒的请求）。装在请求关卡的最前面，各模块路由、关卡自己回的 4xx 和
 * 统一出错回答（server/http-errors.ts）回的都能记到。记的是回给用户的那句话，不碰请求体。
 * 5xx 的错误对象由统一出错回答放在 res.locals.failure，这里取堆栈前 5 行和原因摘要。
 *
 * 地址不存原样，只存按路由归一的前两段（routePath）：地址谁都能写成任意文字，会被当成话交给助手。
 * 没登录的请求只记 5xx（4xx 谁都能随手造），而且每个访客地址 10 分钟最多记 20 条。
 */

/** 页面上报自己的失败不记（上报被限流时会刷屏） */
const ownPath = '/api/diagnostics/page-problems';
const ANONYMOUS_PER_CLIENT = 20;
/** 登录账号也按人限量：一个账号灌失败请求挤不掉别人的出错记录 */
const PER_ACCOUNT = 200;

export type RequestIdentity = {
  /** 登录的账号；没登录 null */
  actorOf(req: Request): Actor | null;
  /** 访客地址（代理后面的取转发来的地址），没登录的按它限量 */
  clientOf(req: Request): string;
};

export function recordFailedRequests(log: ProblemLog, who: RequestIdentity, now: () => number = Date.now): RequestHandler {
  const throttle = new Throttle(now);
  return (req, res, next) => {
    const path = req.originalUrl.split('?')[0].toLowerCase();
    if (!path.startsWith('/api/') || path === ownPath) return next();
    let answer: unknown;
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      answer = body;
      return json(body);
    };
    res.on('finish', () => record({ log, who, throttle }, req, res, answer));
    next();
  };
}

/** 记录要用的：记到哪、认人的办法、限量 */
type Recorder = { log: ProblemLog; who: RequestIdentity; throttle: Throttle };

function record({ log, who, throttle }: Recorder, req: Request, res: Response, answer: unknown) {
  const status = res.statusCode,
    body = (answer && typeof answer === 'object' ? answer : {}) as { message?: unknown; code?: unknown },
    category = problemCategory(status, body.code, body.message);
  if (!category) return;
  let account: string | null = null;
  try {
    account = who.actorOf(req)?.name ?? null;
  } catch {
    /* 账号库关了、会话读不出：当没登录记 */
  }
  if (account === null) {
    if (status < 500) return;
    let client = '';
    try {
      client = who.clientOf(req);
    } catch {
      /* 读不出访客地址的都算一个 */
    }
    if (throttle.hit('anonymous:' + client, ANONYMOUS_PER_CLIENT, PROBLEM_WINDOW)) return;
  } else if (throttle.hit('account:' + account, PER_ACCOUNT, PROBLEM_WINDOW)) return;
  const failure: unknown = status >= 500 ? res.locals.failure : undefined,
    path = req.originalUrl.split('?')[0];
  log.record({
    source: 'server',
    account,
    method: req.method,
    path: routePath(path),
    operation: operationName(req.method, path),
    category,
    status,
    message: typeof body.message === 'string' ? body.message : '',
    ...(failure === undefined ? {} : { reason: errorReason(failure), stack: stackLines(failure) }),
  });
}
