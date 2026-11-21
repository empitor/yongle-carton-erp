/**
 * 服务端补扫：财务的每个请求（router.ts）和助手查财务（assistant.ts 的 readFinanceTool）之前，先把还没记进财务的
 * 业务单据同步进来，一批一批扫到完（每批一个写事务，events.ts 的 FinanceEvents.sync）。没有要补的只读，不开写事务；
 * 财务没启用什么都不做。业务保存不调它（财务不卡业务）。
 *
 * 这是系统按固定规则做的同步，不是谁要写财务：审计记发起这次读取的人（financeActor，要财务查看权限），
 * 只做同步本身（建事件、挂暂估往来、记“来源已删除”；采购退货暂估要财务编辑权限才记，见 return-estimates.ts），
 * 只读账号不会因此做到别的写入。助手查财务前也这样补，写什么助手决定不了。
 *
 * 读不出来的单据逐条跳过（events.ts），第一次跳过时记进出错记录；这条来源一直算“还没同步”，结账、正式报表照样拦。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Actor, ProblemLog, Store } from '../core/index.js';
import { errorReason, many } from '../core/index.js';
import { sourceRow, sourcesCte, sourceUnseen } from './business-source.js';
import { financeActor } from './core.js';
import { FinanceEvents, unreportedSkips } from './events.js';
import type { observationStatuses } from './stored-values.js';

/** 出错记录：只用到记一条（装配时给的 server/core 的 ProblemLog；没给就不记） */
export type SkipLog = Pick<ProblemLog, 'record'>;

/** 补扫到完：返回这次新增或改动了几条（扫到完了，remaining 总是 false） */
export function catchUp(store: Store, actor: Actor | null | undefined, log: SkipLog | undefined) {
  const user = financeActor(actor),
    events = new FinanceEvents(store);
  let processed = 0;
  if (events.pending(user))
    for (let more = true; more; ) {
      const batch = events.sync(user);
      processed += batch.processed;
      more = batch.remaining;
    }
  if (log)
    for (const skip of unreportedSkips(store.db))
      log.record({
        source: 'server',
        account: user.name,
        operation: '同步业务单据进财务',
        category: '出错',
        status: skip.error.status,
        message: `单据 ${skip.number ?? skip.id} 的内容读不出来，没有同步进财务，结账前要修好。`,
        reason: errorReason(skip.error),
      });
  return { processed, remaining: false };
}

/** 还没同步的来源一条：种类、编号、单号（盘点流水是拼的说明） */
const unseenListed = sourceRow.pick({ kind: true, id: true, number: true });
/**
 * 截至 end（含）还没同步进财务、来源还在的前 limit 张（unseenSources 数的那些，不含已被删的），正式报表、结账拦下时写明是哪几张。
 * 读之前已经补扫到完，剩下的就是内容读不出来、补扫跳过的。
 */
export function unseenSourceList(db: DatabaseSync, end: string, limit: number) {
  return many(
    db,
    unseenListed,
    `${sourcesCte}
    SELECT s.kind,s.id,s.number FROM sources s LEFT JOIN fin_source_observations o ON o.source_kind=s.kind AND o.source_id=s.id
      WHERE s.date<=? AND ${sourceUnseen('s', 'o')} ORDER BY s.date,s.kind,s.id LIMIT ?`,
    end,
    limit,
  );
}

/**
 * 财务事件 e 的来源最近一次被补扫看到时是 status（财务自己的 fin_source_observations，不读业务表）：
 * 已撤销、被更正替代的原单都是 reversed，被删的是 deleted。读之前已经补扫过（catchUp）才准。条件。
 */
export const sourceObserved = (e: string, status: (typeof observationStatuses)[number]) =>
  `EXISTS(SELECT 1 FROM fin_source_observations seen
    WHERE seen.source_kind=${e}.source_kind AND seen.source_id=${e}.source_id AND seen.status='${status}')`;
