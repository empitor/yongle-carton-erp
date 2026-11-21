// 补扫测试共用（server/finance/catch-up.ts）：数开了几次事务、库的改动数，出错记录里补扫记的几条
import type { Store } from '../server/core/db.js';
import { count, type ProblemLog } from '../server/core/index.js';
import type { SkipLog } from '../server/finance/catch-up.js';

/** 假的出错记录：补扫、助手查财务必传，不看出错记录的测试给它（记下的都丢掉） */
export const quietLog: SkipLog = { record: () => undefined };

/** 记下这个库从现在起开的事务（BEGIN 开头的语句），返回记下的列表，清空用 begun.length = 0 */
export function watchBegins(s: Store) {
  const begun: string[] = [];
  const exec = s.db.exec.bind(s.db);
  s.db.exec = (sql: string) => {
    if (/^\s*BEGIN/i.test(sql)) begun.push(sql);
    exec(sql);
  };
  return begun;
}

/** 这个库连接到现在一共改了几行 */
export const totalChanges = (s: Store) => count(s.db, 'SELECT total_changes()');

/** 出错记录里补扫记的说法 */
export const catchUpProblems = (log: ProblemLog) => log.list({ operation: '同步业务单据进财务' }).items.map((p) => p.message);
