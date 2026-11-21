/**
 * 服务端补扫：财务的每个请求（router.ts）和助手查财务（assistant.ts 的 readFinanceTool）之前，先把还没记进财务的
 * 业务单据同步进来（每批一个写事务，events.ts 的 FinanceEvents.sync）。没有要补的只读，不开写事务；财务没启用什么都不做。
 *
 * 财务不卡业务：业务保存不调它；node:sqlite 是同步调用，补扫时整个服务都在等，所以一次最多扫 CATCH_UP_BATCHES 批，
 * 剩下的留给后面的财务请求（每个请求都会接着扫）。没扫完时还没同步的单据照样算“还没同步”，结账、正式报表照样拦。
 *
 * 这是系统按固定规则做的同步，不是谁要写财务：审计记发起这次读取的人（financeActor，要财务查看权限），
 * 只做同步本身（建事件、挂暂估往来、记“来源已删除”、已撤销送货的自动收尾；采购退货暂估要财务编辑权限才记，
 * 见 return-estimates.ts），只读账号不会因此做到别的写入。助手查财务前也这样补，写什么助手决定不了。
 *
 * 出错怎么办：内容读不出来的单据、采购退货单逐条跳过（unreadable.ts），第一次跳过时记进出错记录，它一直算“还没同步”。
 * 别的错（程序或财务自己的数据出了问题）这一批整批回滚，记进出错记录（同一个原因只记一次），读请求照常回答
 * 已经进财务的数；结账、正式报表按“补扫没成功”拦（catchUpFailed，reports.ts 的 readiness），
 * 财务的写请求由 router.ts 拦下（写入要按最新的单据状态核对，比如核销前看送货单撤没撤销）。下次补扫成功就放开。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Actor, ProblemLog, Store } from '../core/index.js';
import { errorReason, many } from '../core/index.js';
import { errorMessage } from '../../shared/core/index.js';
import { sourceRow, sourcesCte, sourceUnseen } from './business-source.js';
import { financeActor } from './core.js';
import { FinanceEvents } from './events.js';
import type { observationStatuses } from './stored-values.js';
import { unreportedSkips } from './unreadable.js';

/** 出错记录：只用到记一条（装配时给的 server/core 的 ProblemLog；没给就不记） */
export type SkipLog = Pick<ProblemLog, 'record'>;

/** 一次补扫最多扫几批（每批最多 100 条来源）：大批历史单据（刚启用、批量导入后）分到几个请求里扫，批与批之间别的请求能进来 */
export const CATCH_UP_BATCHES = 2;
/** 出错记录里这件事的叫法 */
const OPERATION = '同步业务单据进财务';
/** 补扫没成功的原因（每个库一份，只记在进程里）：同一个原因只记一次出错记录，补扫成功就清掉 */
const failures = new WeakMap<DatabaseSync, string>();
/** 最近一次补扫没成功（还没有成功过一次）：结账、正式报表要拦 */
export const catchUpFailed = (db: DatabaseSync) => failures.has(db);

/**
 * 补扫：最多 CATCH_UP_BATCHES 批。返回这次新增或改动了几条、还有没有没扫的（remaining）、这次是不是没成功（failed）。
 * 只有没权限（财务查看）的会抛错；补扫本身出错不抛，见文件开头“出错怎么办”。
 */
export function catchUp(store: Store, actor: Actor | null | undefined, log: SkipLog | undefined) {
  const user = financeActor(actor),
    db = store.db;
  let result: { processed: number; remaining: boolean; failed: boolean };
  try {
    result = { ...syncBatches(store, user), failed: false };
    failures.delete(db);
  } catch (error) {
    const reason = errorReason(error);
    if (failures.get(db) !== reason) {
      console.error('[财务补扫] 业务单据没能同步进财务：' + errorMessage(error), error);
      log?.record({
        ...entry(user, 500),
        message: '业务单据没能同步进财务，财务的数可能不是最新的；结账、正式报表和财务的修改先拦着，请联系维护人员。',
        reason,
      });
    }
    failures.set(db, reason);
    result = { processed: 0, remaining: true, failed: true };
  }
  for (const skip of unreportedSkips(db))
    log?.record({
      ...entry(user, skip.error.status),
      message: `单据 ${skip.number ?? skip.id} 的内容读不出来，没有同步进财务；在库里改好后下次打开财务自动补上，结账前要修好。`,
      reason: errorReason(skip.error),
    });
  return result;
}

type ProblemEntry = Parameters<SkipLog['record']>[0];
/** 出错记录一条的共用部分 */
const entry = (user: Actor, status: number): Omit<ProblemEntry, 'message'> => ({
  source: 'server',
  account: user.name,
  operation: OPERATION,
  category: '出错',
  status,
});

/** 有要补的就扫，最多 CATCH_UP_BATCHES 批 */
function syncBatches(store: Store, user: Actor) {
  const events = new FinanceEvents(store);
  let processed = 0,
    remaining = events.pending(user);
  for (let batch = 0; remaining && batch < CATCH_UP_BATCHES; batch++) {
    const done = events.sync(user);
    processed += done.processed;
    remaining = done.remaining;
  }
  return { processed, remaining };
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
