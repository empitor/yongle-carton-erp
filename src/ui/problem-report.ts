import { listen, readNotice } from './events';
import { textField } from './read-body';

/**
 * 页面上的问题上报给服务端（POST /api/diagnostics/page-problems，存进最近出错，标明来自页面），助手和管理员排查时能看到：
 * 失败的请求（状态、服务端那句话）、连不上服务器、前端报错的第一行、弹过的红色出错提示。
 * 攒 2 秒一批，一批最多 10 条；同样的内容 1 分钟内只报一次，每分钟最多 20 条；每条截短。
 * 上报自己失败了什么都不做：不重试、不提示、不再上报，绝不影响页面。
 */

export type PageProblem = {
  kind: 'request' | 'network' | 'script' | 'notice';
  message: string;
  status?: number;
  method?: string;
  path?: string;
};
type Sent = PageProblem & { page: string };

const ENDPOINT = '/api/diagnostics/page-problems';
const BATCH = 10;
const PER_MINUTE = 20;
const SAME_WITHIN = 60_000;
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const firstLine = (text: string, max: number) => {
  const line = String(text ?? '').split('\n')[0].trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
};

/**
 * 上报器：排队、去重、限量、截短在这里，怎么发（send）、现在几点、当前页面由调用方给，测试直接用它。
 */
export function createProblemReporter(options: {
  send: (problems: Sent[]) => void;
  now?: () => number;
  page?: () => string;
  schedule?: (flush: () => void) => void;
}) {
  const now = options.now ?? Date.now,
    page = options.page ?? (() => ''),
    schedule = options.schedule ?? ((flush) => setTimeout(flush, 2000));
  const recent = new Map<string, number>();
  let queue: Sent[] = [],
    sentTimes: number[] = [],
    waiting = false;
  const flush = () => {
    waiting = false;
    const batch = queue.slice(0, BATCH);
    queue = queue.slice(BATCH);
    if (batch.length)
      try {
        options.send(batch);
      } catch {
        /* 上报失败不影响页面 */
      }
    if (queue.length) {
      waiting = true;
      schedule(flush);
    }
  };
  return (problem: PageProblem) => {
    if (problem.path?.startsWith(ENDPOINT) || problem.status === 401) return;
    const t = now(),
      item: Sent = {
        kind: problem.kind,
        message: firstLine(problem.message, 500),
        ...(problem.status !== undefined ? { status: problem.status } : {}),
        ...(problem.method && methods.includes(problem.method.toUpperCase()) ? { method: problem.method.toUpperCase() } : {}),
        ...(problem.path ? { path: firstLine(problem.path.split('?')[0], 300) } : {}),
        page: firstLine(page(), 200),
      };
    const key = [item.kind, item.status, item.path, item.message].join('|');
    if (t - (recent.get(key) ?? -Infinity) < SAME_WITHIN) return;
    sentTimes = sentTimes.filter((s) => t - s < 60_000);
    if (sentTimes.length >= PER_MINUTE) return;
    recent.set(key, t);
    const oldest = recent.keys().next();
    if (recent.size > 200 && !oldest.done) recent.delete(oldest.value);
    sentTimes.push(t);
    queue.push(item);
    if (!waiting) {
      waiting = true;
      schedule(flush);
    }
  };
}

/** 浏览器里真正用的上报器；startProblemReports 之前（测试、服务端渲染）什么都不做 */
let reporter: ((problem: PageProblem) => void) | null = null;

export function reportPageProblem(problem: PageProblem) {
  reporter?.(problem);
}
/** 开始上报了没有（没开始时调用方连失败响应的正文都不用去读） */
export const reportingPageProblems = () => reporter !== null;

/**
 * 在浏览器里开始上报（只开一次）：收全局报错、没接住的异步错误、红色出错提示。
 * token 取当前的页面凭证；没登录（拿不到凭证）的时候不报。
 */
export function startProblemReports(token: () => string | null) {
  if (reporter || typeof document === 'undefined') return;
  reporter = createProblemReporter({
    page: () => location.hash || location.pathname,
    send: (problems) => {
      const credential = token();
      if (!credential) return;
      fetch(ENDPOINT, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': credential },
        body: JSON.stringify({ problems }),
      }).catch(() => {
        // 上报自己失败了什么都不做（见文件开头）：不重试、不提示、不再上报，绝不影响页面
      });
    },
  });
  window.addEventListener('error', (event) => reportPageProblem({ kind: 'script', message: event.message || '页面脚本出错' }));
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    reportPageProblem({ kind: 'script', message: textField(reason, 'message') ?? String(reason) });
  });
  listen('erp-notice', (detail) => {
    const notice = readNotice(detail);
    if (notice?.tone === 'error') reportPageProblem({ kind: 'notice', message: notice.message });
  });
}
