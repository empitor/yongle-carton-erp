import { quantityString, quantityUnits } from '../core/index.js';

/*
 * 生产任务完工了多少：计划、已核对入库（completed）、已登记待入库（pendingCompleted），都按千分整数算。
 * 服务端组装任务视图（server/flow/read.ts）、登记完工的剩余量（server/flow/completion-plan.ts），
 * 前端的“还差”、能不能登记完工都用这里，只此一份。
 */

type TaskCounts = { quantity: string; completed?: string; pendingCompleted?: string };

/** 任务视图里的进度：已核对入库、已登记待入库的数量文本和百分比（先乘后除、整数运算：29/100 不能因浮点算成 28%） */
export function taskProgress(quantity: string, completedUnits: number, waitingUnits: number) {
  return {
    completed: quantityString(completedUnits),
    pendingCompleted: quantityString(waitingUnits),
    progress: Math.min(100, Math.floor((completedUnits * 100) / quantityUnits(quantity))),
  };
}

/** 还能登记的数量（千分整数）= 计划 − 已核对入库 − 已登记待入库；预填的合格数不会被服务端拒 */
export const taskLeftUnits = (t: TaskCounts) =>
  quantityUnits(String(t.quantity)) - quantityUnits(String(t.completed || '0')) - quantityUnits(String(t.pendingCompleted || '0'));

/** 能登记完工的任务：已下达、没做完、没归档，而且剩下的还没全部登记成待入库 */
export const completableTask = (t: TaskCounts & { archived?: boolean; status: string; progress?: number }) =>
  !t.archived && t.status === 'confirmed' && Number(t.progress ?? 0) < 100 && taskLeftUnits(t) > 0;

/** 剩下的数量都已登记成待入库：下一步是核对入库，不是再登记完工 */
export const allWaitingReview = (t: TaskCounts & { archived?: boolean; status: string; progress?: number }) =>
  quantityUnits(String(t.pendingCompleted || '0')) > 0 && !completableTask(t);
