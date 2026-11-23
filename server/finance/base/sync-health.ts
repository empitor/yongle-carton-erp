/**
 * 最近一次补扫成没成功（catch-up.ts 记），和补扫没成功时拦哪些财务写入。
 *
 * 补扫没成功（程序或财务自己的数据出了问题）时，财务的读照常、登记收付款、改往来条款这类和来源单据无关的写入照常
 * （AGENTS.md“财务不卡业务……卡点越少越好”）；结账、正式报表按 catchUpFailed 拦（reports.ts 的 readiness）；
 * 只有要按来源单据状态核对的写入在核对前调 assertSourcesCaughtUp 拦下。调它的地方就是这份名单（docs/架构/财务.md“补扫”列着）：
 * 收付款核销（cash-posting.ts 的 addAllocation）、发票关联和确认（invoice-rules.ts 的 assertInvoiceableObligation）、
 * 业务单据的财务事件处理（event-handling.ts 的补资料、批量补税率、红字冲销并重做、核对无误，event-voucher.ts 的生成凭证）。
 * 收到、开出票据时自动冲往来（note-settlements.ts 的 planSettlement）算收付款，照常不拦（用户定的“收付款全部照常，
 * 卡点越少越好”）：它挑往来时照样排除已撤销的送货（source-scan.ts 的 sourceIs），核销后来源才撤销的另有处理。
 * 这个文件不引补扫本身，财务各处都能引，不会成环。
 */
import type { DatabaseSync } from 'node:sqlite';
import { financeError } from './core.js';

/** 补扫没成功的原因（每个库一份，只记在进程里）：补扫成功就清掉 */
const failures = new WeakMap<DatabaseSync, string>();
/** 补扫没成功时拦下要按来源单据状态核对的写入的说法 */
const SOURCES_STALE = '业务单据没能同步进财务（原因已记进出错记录），先不能做要核对业务单据的财务操作（核销、关联发票、红冲这类），请联系维护人员。';

/** 最近一次补扫没成功（还没有成功过一次） */
export const catchUpFailed = (db: DatabaseSync) => failures.has(db);

/** 记下这次补扫的结果：reason 是没成功的原因，成功是 null。返回这个原因是不是新的（同一个原因只记一次出错记录） */
export function noteCatchUp(db: DatabaseSync, reason: string | null) {
  const fresh = reason !== null && failures.get(db) !== reason;
  if (reason === null) failures.delete(db);
  else failures.set(db, reason);
  return fresh;
}

/** 要按来源单据状态核对的财务写入在核对之前调：最近一次补扫没成功就拦下（503） */
export function assertSourcesCaughtUp(db: DatabaseSync) {
  if (failures.has(db)) financeError(SOURCES_STALE, 503);
}
