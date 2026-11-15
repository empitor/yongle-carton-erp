import type { DatabaseSync } from 'node:sqlite';

/*
 * 写入用的保存点（SAVEPOINT）只有这一份做法：外面已经开了事务或保存点时嵌在里面，没有时自己就是一个事务。
 * 每次用一个新名字，嵌套多少层都不会认错是哪一层。job 必须是同步的：返回 Promise 的话，等它办完时保存点早已提交，
 * 所以返回值是 Promise（thenable）就整段回滚并报错。
 */
let counter = 0;
const nextName = () => 'sp_' + ++counter;
export const ASYNC_JOB = '事务里的函数必须是同步的：返回了 Promise，已整段回滚。';
/** 带 then 方法的值（Promise 和别的 thenable） */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && 'then' in value && typeof value.then === 'function';
}
/** job 返回了 Promise：报错（调用方的 catch / finally 负责回滚）。那个 Promise 之后再失败也不另报，错已经在这里报了 */
function assertSync(result: unknown) {
  if (!isThenable(result)) return;
  result.then(undefined, () => {});
  throw new Error(ASYNC_JOB);
}

/** 在一个保存点里办 job：办完提交（嵌套时并进外层），出错整段回滚，再把原来的错抛出去。 */
export function inSavepoint<T>(db: DatabaseSync, job: () => T): T {
  const name = nextName();
  db.exec('SAVEPOINT ' + name);
  try {
    const result = job();
    assertSync(result);
    db.exec('RELEASE ' + name);
    return result;
  } catch (e) {
    db.exec('ROLLBACK TO ' + name + '; RELEASE ' + name);
    throw e;
  }
}

/** 预演：在保存点里办 job，不管成没成都整段撤回，返回 job 的结果（出错照样抛出去）。 */
export function rehearse<T>(db: DatabaseSync, job: () => T): T {
  const name = nextName();
  db.exec('SAVEPOINT ' + name);
  try {
    const result = job();
    assertSync(result);
    return result;
  } finally {
    db.exec('ROLLBACK TO ' + name + '; RELEASE ' + name);
  }
}
