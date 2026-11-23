/**
 * 服务端补扫：财务的每个请求（router.ts）和助手查财务（assistant.ts 的 readFinanceTool）之前，先把还没记进财务的
 * 业务单据同步进来（每批一个写事务，events.ts 的 FinanceEvents.sync）。没有要补的只读，不开写事务；财务没启用什么都不做。
 *
 * 财务不卡业务：业务保存不调它；node:sqlite 是同步调用，补扫时整个服务都在等，所以一次最多扫 CATCH_UP_BATCHES 批，
 * 剩下的留给后面的财务请求（每个请求都会接着扫）。没扫完时还没同步的单据照样算“还没同步”，结账、正式报表照样拦；
 * 财务看来源撤没撤销、删没删（source-scan.ts 的 sourceIs）把还没补扫进来的也算上，写入照样拦得住撤销过的单据。
 *
 * 这是系统按固定规则做的同步，不是谁要写财务：审计记发起这次读取的人（financeActor，要财务查看权限），
 * 只做同步本身（建事件、挂暂估往来、记“来源已删除”、已撤销送货的自动收尾；采购退货暂估要财务编辑权限才记，
 * 见 return-estimates.ts），只读账号不会因此做到别的写入。助手查财务前也这样补，写什么助手决定不了。
 *
 * 出错怎么办：内容读不出来的单据、采购退货单逐条跳过（unreadable.ts），第一次跳过时记进出错记录，它一直算“还没同步”。
 * 别的错（程序或财务自己的数据出了问题）这一批整批回滚，记进出错记录（同一个原因只记一次），读请求照常回答
 * 已经进财务的数；结账、正式报表按“补扫没成功”拦（sync-health.ts 的 catchUpFailed，reports.ts 的 readiness），
 * 要按来源单据状态核对的财务写入（核销、关联发票、红冲这类，名单见 sync-health.ts）拦下，别的写入照常。下次补扫成功就放开。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Actor, ProblemLog, Store } from '../../core/index.js';
import { errorReason } from '../../core/index.js';
import { errorMessage } from '../../../shared/core/index.js';
import type { SourceHead } from '../../flow/index.js';
import { financeActor } from '../base/core.js';
import { FinanceEvents } from './events.js';
import { ReturnEstimates } from './return-estimates.js';
import { scanSources, sourceKey, sourceTexts } from './source-scan.js';
import { noteCatchUp } from '../base/sync-health.js';
import { unreportedSkips } from '../base/unreadable.js';

/** 出错记录：只用到记一条（装配时给的 server/core 的 ProblemLog，测试给假的；必传，记过的才标成已记） */
export type SkipLog = Pick<ProblemLog, 'record'>;

/** 一次补扫最多扫几批（每批最多 100 条来源）：大批历史单据（刚启用、批量导入后）分到几个请求里扫，批与批之间别的请求能进来 */
export const CATCH_UP_BATCHES = 2;
/** 出错记录里这件事的叫法 */
const OPERATION = '同步业务单据进财务';

/**
 * 补扫：最多 CATCH_UP_BATCHES 批。返回这次新增或改动了几条、还有没有没扫的（remaining）、这次是不是没成功（failed）。
 * 只有没权限（财务查看）的会抛错；补扫本身出错不抛，见文件开头“出错怎么办”。
 */
export function catchUp(store: Store, actor: Actor | null | undefined, log: SkipLog) {
  const user = financeActor(actor),
    db = store.db;
  let result: { processed: number; remaining: boolean; failed: boolean };
  try {
    result = { ...syncBatches(store, user), failed: false };
    noteCatchUp(db, null);
  } catch (error) {
    const reason = errorReason(error);
    if (noteCatchUp(db, reason)) {
      console.error('[财务补扫] 业务单据没能同步进财务：' + errorMessage(error), error);
      log.record({
        ...entry(user, 500),
        message: '业务单据没能同步进财务，财务的数可能不是最新的；结账、正式报表和要核对业务单据的财务操作先拦着，请联系维护人员。',
        reason,
      });
    }
    result = { processed: 0, remaining: true, failed: true };
  }
  for (const skip of unreportedSkips(db))
    log.record({
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

/** 有要补的就扫，最多 CATCH_UP_BATCHES 批；要看的采购退货只读一次，判断要不要补和真去记共用（ReturnEstimates） */
function syncBatches(store: Store, user: Actor) {
  const events = new FinanceEvents(store),
    returns = new ReturnEstimates(store, user);
  let processed = 0,
    remaining = events.pending(user, returns);
  for (let batch = 0; remaining && batch < CATCH_UP_BATCHES; batch++) {
    const done = events.sync(user, returns);
    processed += done.processed;
    remaining = done.remaining;
  }
  return { processed, remaining };
}

/** 文字按编码先后比（和 SQL 的 ORDER BY 一样，不按语言习惯） */
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** 先后：日期、种类、编号（编号按文字比） */
const byDateKindId = (a: SourceHead, b: SourceHead) => compareText(a.date, b.date) || compareText(a.kind, b.kind) || compareText(a.id, b.id);
/**
 * 截至 end（含）还没同步进财务、来源还在的前 limit 张（unseenSources 数的那些，不含已被删的）：种类、编号、单号（盘点流水是拼的说明），
 * 正式报表、结账拦下时写明是哪几张。读之前已经补扫到完，剩下的就是内容读不出来、补扫跳过的。
 */
export function unseenSourceList(db: DatabaseSync, end: string, limit: number) {
  const listed = scanSources(db)
    .unseen.filter((s) => s.date <= end)
    .sort(byDateKindId)
    .slice(0, limit);
  const texts = sourceTexts(db, listed);
  return listed.map((s) => ({ kind: s.kind, id: s.id, number: texts.get(sourceKey(s))?.number ?? null }));
}
