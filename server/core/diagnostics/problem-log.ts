import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Actor } from '../http/actor.js';
import { rows } from '../schema/rows.js';
import { DAY_MS, MINUTE_MS, PROBLEM_TEXT, errorMessage } from '../../../shared/core/index.js';
import { count, many } from '../storage/sqlite/sql.js';
import { openVersionedSqlite } from '../backup/versioned-sqlite.js';
import type { VersionedSqliteSpec } from '../backup/versioned-sqlite-spec.js';
import { isSuperAdmin, isoTime, pageWindow, RECORD_PAGE, requireSignedIn } from './reading.js';
import { safeText } from './redact.js';
import type { ProblemCategory } from './problem-kinds.js';

/**
 * 最近出错（logs/problems.sqlite）：服务端的出错、被拒的请求，和页面上报的失败请求、报错、出错提示。
 * 单独一个小库，不进业务库；留 30 天，总共最多 5000 条，分三份各算各的上限（见 pools），互相挤不掉；
 * 每记一条顺手清掉过期的和这一份超出的。请求体一律不存。
 * 基线是 0.9.0 的第 1 版；以后改结构在 steps 加一步（规矩见 server/core/backup/versioned-sqlite-spec.ts 开头）。
 */
export const problemLogDatabase: VersionedSqliteSpec = {
  label: '出错记录库',
  baseline: 1,
  steps: [],
  create(db) {
    db.exec(`-- 库文件旁边的 run.log 是运行日志（超 2 MB 换一份，留两份），不是数据库

      -- 服务端失败的请求和页面上报，存前打码、截断；留 30 天，按来源分份限条数
      CREATE TABLE recent_problems(
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('server','page')),
        account TEXT,
        method TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL DEFAULT '',
        operation TEXT NOT NULL,
        category TEXT NOT NULL,
        status INTEGER NOT NULL,
        message TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        stack TEXT NOT NULL DEFAULT '',
        page TEXT NOT NULL DEFAULT '');
      CREATE INDEX recent_problems_at ON recent_problems(at);`);
  },
};

const KEEP_DAYS = 30;
/** 记不进去时服务端日志里那句原因最多几个字 */
const WARNING_CHARS = 200;
/** 记出错记录的限量按这么长的窗口算（服务端按访客、按账号，页面上报按账号，见 request-recorder.ts、page-problems.ts） */
const PROBLEM_WINDOW_MINUTES = 10;
export const PROBLEM_WINDOW = PROBLEM_WINDOW_MINUTES * MINUTE_MS;
/**
 * 三份各自的条数上限（合计 5000）：登录账号的服务端记录 3500，没登录的服务端记录 500，页面上报 1000。
 * 没登录的、页面上报的被人灌满了，也只挤掉自己那一份，挤不掉登录账号的服务端记录。
 */
const pools = {
  signedIn: { where: "source='server' AND account IS NOT NULL", keep: 3500 },
  anonymous: { where: "source='server' AND account IS NULL", keep: 500 },
  page: { where: "source='page'", keep: 1000 },
};
const poolOf = (entry: ProblemEntry) =>
  entry.source === 'page' ? pools.page : entry.account === null ? pools.anonymous : pools.signedIn;

/** 记一条：source 是服务端还是页面；account 是账号名，没登录的为 null */
export type ProblemEntry = {
  source: ProblemSource;
  account: string | null;
  method?: string;
  path?: string;
  operation: string;
  category: ProblemCategory;
  status: number;
  message: string;
  reason?: string;
  stack?: string[];
  page?: string;
};

/** 筛选：时间段（不给就是最近 24 小时）、账号名、操作（叫法或接口地址里含这几个字）、类别、来源；分页 */
export type ProblemFilter = {
  from?: string;
  to?: string;
  account?: string;
  operation?: string;
  category?: string;
  source?: ProblemSource;
  limit?: number;
  offset?: number;
};

/** 出错记录的来源只有服务端、页面两种（建表有同样的 CHECK），叫法按它逐个写 */
const problemSources = ['server', 'page'] as const;
type ProblemSource = (typeof problemSources)[number];
const sourceNames: Record<ProblemSource, string> = { server: '服务端', page: '页面' };
/** 出错记录的一行 */
const problemRow = rows.recent_problems.extend({ source: z.enum(problemSources) });

export class ProblemLog {
  readonly db: DatabaseSync;
  constructor(
    file = ':memory:',
    private now: () => number = Date.now,
  ) {
    this.db = openVersionedSqlite(file, problemLogDatabase);
  }

  /** 记一条。文字在这里统一打码、截断；记不进去（磁盘满、库被占）不影响原来的请求，只在服务端日志说一句 */
  record(entry: ProblemEntry) {
    try {
      const at = new Date(this.now()).toISOString();
      this.db
        .prepare(
          `INSERT INTO recent_problems(at,source,account,method,path,operation,category,status,message,reason,stack,page)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          at,
          entry.source,
          entry.account === null ? null : safeText(entry.account, PROBLEM_TEXT.account),
          safeText(entry.method ?? '', PROBLEM_TEXT.method),
          safeText((entry.path ?? '').split('?')[0], PROBLEM_TEXT.path),
          safeText(entry.operation, PROBLEM_TEXT.operation),
          entry.category,
          Math.trunc(entry.status) || 0,
          safeText(entry.message, PROBLEM_TEXT.message),
          safeText(entry.reason ?? '', PROBLEM_TEXT.reason),
          (entry.stack ?? []).slice(0, PROBLEM_TEXT.stackLines).map((l) => safeText(l, PROBLEM_TEXT.stackLine)).join('\n'),
          safeText(entry.page ?? '', PROBLEM_TEXT.page),
        );
      const cutoff = new Date(this.now() - KEEP_DAYS * DAY_MS).toISOString();
      this.db.prepare('DELETE FROM recent_problems WHERE at<?').run(cutoff);
      const pool = poolOf(entry);
      this.db
        .prepare(`DELETE FROM recent_problems WHERE id IN (SELECT id FROM recent_problems WHERE ${pool.where} ORDER BY id DESC LIMIT -1 OFFSET ?)`)
        .run(pool.keep);
    } catch (error) {
      console.warn('出错记录没有记下：' + safeText(errorMessage(error), WARNING_CHARS));
    }
  }

  /** 按条件查（不判权限，读取方用 readRecentProblems） */
  list(filter: ProblemFilter = {}) {
    const where: string[] = [],
      args: (string | number)[] = [];
    const from = filter.from ? isoTime(filter.from, '开始') : filter.to ? '' : new Date(this.now() - DAY_MS).toISOString();
    if (from) where.push('at>=?'), args.push(from);
    if (filter.to) where.push('at<=?'), args.push(isoTime(filter.to, '结束'));
    if (filter.account) where.push('account=?'), args.push(filter.account);
    if (filter.category) where.push('category=?'), args.push(filter.category);
    if (filter.source) where.push('source=?'), args.push(filter.source);
    if (filter.operation)
      where.push("(instr(operation,?)>0 OR instr(path,?)>0)"), args.push(filter.operation, filter.operation);
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const { limit, offset } = pageWindow(filter.limit, filter.offset, RECORD_PAGE);
    const total = count(this.db, 'SELECT COUNT(*) AS n FROM recent_problems' + clause, ...args);
    const found = many(this.db, problemRow, 'SELECT * FROM recent_problems' + clause + ' ORDER BY id DESC LIMIT ? OFFSET ?', ...args, limit, offset);
    // 返回的字段逐个挑，不把库里的行原样交出去
    const items = found.map((r) => ({
      time: r.at,
      source: sourceNames[r.source],
      account: r.account ?? '未登录',
      operation: r.operation,
      method: r.method,
      path: r.path,
      category: r.category,
      status: r.status,
      message: r.message,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.stack ? { stack: r.stack.split('\n') } : {}),
      ...(r.page ? { page: r.page } : {}),
    }));
    return { total, more: offset + items.length < total, items };
  }

  close() {
    this.db.close();
  }
}

/**
 * 读最近出错。超级管理员看全部；别的账号只看自己的（账号名筛选被换成本人）。没登录的拒绝。
 */
export function readRecentProblems(log: ProblemLog, actor: Actor | null | undefined, filter: ProblemFilter = {}) {
  const who = requireSignedIn(actor);
  return log.list(isSuperAdmin(who) ? filter : { ...filter, account: who.name });
}
