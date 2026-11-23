import { DAY_MS, HOUR_MS, MINUTE_MS, errorMessage } from '../../../shared/core/index.js';
import type { Store } from '../storage/db.js';

/** 启动几分钟后跑第一次 */
const FIRST_RUN_MINUTES = 5;

/** 每日清理里的一项：name 给日志看，run 返回清了多少，unit 是日志里写的单位（不写就是“条”，回收空间写“页”） */
export type CleanupJob = { name: string; run: () => number; unit?: string };

/**
 * 跑一轮清理。库正开着事务就整轮跳过（返回 null），等下一次再看：助手执行方案时会把保存点跨着 await 开着，
 * 清理语句不能混进别人的事务里（那边退回，清理也跟着退回；那边提交，清理就成了它的一部分）。
 * 某一项失败只记日志，不影响别的项，也不影响业务。
 */
export function runCleanup(store: Store, jobs: CleanupJob[], log: (message: string) => void = console.error) {
  if (store.db.isTransaction) return null;
  const cleaned: Record<string, number> = {};
  for (const job of jobs) {
    try {
      cleaned[job.name] = job.run();
    } catch (error) {
      log('每日清理失败（' + job.name + '）：' + errorMessage(error));
    }
  }
  return cleaned;
}

/**
 * 每日清理：启动五分钟后跑第一次，之后每小时看一次，距上次清理满 24 小时才再清；
 * 碰上库正开着事务的那次不算，下个小时再看。清什么由装配层传进来（各模块提供自己的清理函数）。
 * 返回停止定时器的函数，关闭服务时调。
 */
export function scheduleDailyCleanup(store: Store, jobs: CleanupJob[]) {
  let last = 0;
  const run = () => {
    if (Date.now() - last < DAY_MS) return;
    try {
      const cleaned = runCleanup(store, jobs);
      if (!cleaned) return;
      last = Date.now();
      const done = jobs.filter((job) => (cleaned[job.name] ?? 0) > 0);
      if (done.length)
        console.log('每日清理：' + done.map((job) => job.name + ' ' + cleaned[job.name] + ' ' + (job.unit ?? '条')).join('，'));
    } catch (error) {
      console.error('每日清理失败：', errorMessage(error)); // 库已关闭等
    }
  };
  const first = setTimeout(run, FIRST_RUN_MINUTES * MINUTE_MS),
    timer = setInterval(run, HOUR_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
