import { Router, type Request } from 'express';
import type { z } from 'zod';
import { pageProblemsSchema, type DiagnosticsApi } from '../../../shared/core/index.js';
import type { Actor } from '../actor.js';
import { done, refuse, route } from '../route.js';
import { Throttle } from '../throttle.js';
import { operationName, routePath } from './operation-names.js';
import { problemCategory, type ProblemCategory } from './problem-kinds.js';
import { PROBLEM_WINDOW, type ProblemLog } from './problem-log.js';

/**
 * 页面上报（POST /api/diagnostics/page-problems，接口表和收什么在 shared/core/diagnostics-api.ts）：页面上失败的请求、
 * 前端报错的第一行、弹过的出错提示，记进最近出错，标明来自页面。登录和页面凭证由请求关卡统一查；每个账号 10 分钟最多收 60 条，
 * 超了直接丢，回答一律 202，上报的成败不影响页面。内容不对只回 { message }（refuse，不带 code）。
 */

/** 页面位置留几个字 */
const PAGE_LOCATION_CHARS = 120;
type PageReport = z.output<typeof pageProblemsSchema>['problems'][number];

const PER_ACCOUNT = 60;

/**
 * 页面上报的一条算哪一类：类别只用页面自己的四种，不和服务端的“出错”这些混用（页面上报的文字没核实过）；
 * 不该记的（401、页面凭证过期）返回 null
 */
export function pageCategory(item: PageReport): ProblemCategory | null {
  if (item.kind === 'network') return '连不上服务器';
  if (item.kind === 'script') return '页面报错';
  if (item.kind === 'notice') return '出错提示';
  return problemCategory(item.status ?? 0, undefined, item.message) ? '页面请求失败' : null;
}
/** 页面位置（#warehouse?arrivals=1 这种）只留地址里常见的字符 */
const pageLocation = (page: string) => page.replace(/[^A-Za-z0-9#?=&/_.%-]/g, '').slice(0, PAGE_LOCATION_CHARS);

export function pageProblemRouter(log: ProblemLog, actorOf: (req: Request) => Actor | null, now: () => number = Date.now) {
  const router = Router(),
    throttle = new Throttle(now);
  route<DiagnosticsApi>(router, '/diagnostics')('POST /diagnostics/page-problems', ({ body, req }) => {
    const parsed = pageProblemsSchema.safeParse(body);
    if (!parsed.success) return refuse(400, '上报内容不对。');
    const account = actorOf(req)?.name ?? null;
    for (const item of parsed.data.problems) {
      const category = pageCategory(item);
      if (!category) continue;
      if (throttle.hit('page:' + (account ?? req.ip), PER_ACCOUNT, PROBLEM_WINDOW)) break;
      // 叫法按原地址对（叫法只出自固定的词表），存的地址按路由归一，不留页面发来的任意文字
      const written = (item.path ?? '').split('?')[0];
      log.record({
        source: 'page',
        account,
        method: item.method ?? '',
        path: written ? routePath(written) : '',
        operation: item.kind === 'request' || item.kind === 'network' ? operationName(item.method ?? '', written) : '页面',
        category,
        status: item.status ?? 0,
        message: item.message,
        page: pageLocation(item.page ?? ''),
      });
    }
    return done;
  }, { status: 202 });
  return router;
}
