/**
 * 多付转抵：某笔往来多付了（比如供应商开了红票、客户多付了货款），把多出来的部分
 * 转去抵同一往来单位的另一笔。做法和常见财务软件的“应付冲应付”一样：生成一张往来对冲凭证
 * （借贷同科目同辅助项，总账余额不变，留下记录），多付那笔记负核销、被抵那笔记正核销，
 * 都挂在当初付款的资金单上，资金单的总核销金额不变。多付分散在几张资金单上的，一次转抵按张拆开转。
 * FinanceAllocations.transferCredit 查完权限、在一次写入里调这里。
 */
import { z } from 'zod';
import { dateSchema } from '../../../shared/core/index.js';
import { versionSchema } from '../../../shared/finance/index.js';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { many, rows } from '../../core/index.js';
import { checkVersion, financeAudit, financeError } from '../base/core.js';
import { allocatedCents, cashVoucher, roleOf } from '../cash/cash-posting.js';
import type { FinanceLedger } from '../ledger/ledger.js';
import { entry, id, money, request, row } from '../base/query.js';
import { reversedCents } from '../base/reversal-pairs.js';
import { sumOf } from '../base/finance-rows.js';

/** 拆成几张资金单转时，每张的子请求号截请求号前 80 字再接资金单号（请求号最长 100 字） */
const TRANSFER_PREFIX = 80;

type ObligationRow = z.output<typeof rows.fin_obligations>;
/** 多付转抵的结果：按资金单拆开的几笔，各自的对冲凭证 */
export const transferred = z.object({
  amount: z.number(),
  parts: z.array(z.object({ cashId: z.number(), amount: z.number(), voucherId: z.number() })),
});
export const transferInput = request.extend({
  date: dateSchema,
  from: z.strictObject({ id, version: versionSchema }),
  to: z.strictObject({ id, version: versionSchema }),
  amount: money,
});
type TransferInput = z.output<typeof transferInput>;

/** 转抵的两笔：同一单位同一方向、凭证已记账、都不是红字冲销那笔；转出那笔确实多付，被抵那笔还欠着，金额都够 */
function checkTransfer(store: Store, ledger: FinanceLedger, user: Actor, pair: { v: TransferInput; from: ObligationRow; to: ObligationRow }) {
  const { v, from, to } = pair,
    db = store.db;
  if (from.id === to.id || from.kind !== to.kind || from.party_id !== to.party_id)
    financeError('只能转到同一往来单位、同一方向的另一笔往来。');
  if (v.date < from.date || v.date < to.date) financeError('转抵日期不能早于两笔往来的日期。');
  for (const o of [from, to])
    if (o.tax_status === 'superseded' || (o.voucher_id && ledger.get(user, o.voucher_id).header.status !== 'posted'))
      financeError('往来凭证须先记账。');
  // 红字冲销成对看（见 reversal-pairs.ts）：冲销那笔不能转出也不能被抵；
  // 被冲销的原往来只能转出冲销后多出来的部分（冲销前已收付的钱），也不能再被抵。
  if (from.reversal_of != null || to.reversal_of != null)
    financeError('红字冲销的那笔不用转抵，请选原来那笔或别的往来。');
  const reversed = (key: number) => sumOf(db, `SELECT ${reversedCents('o')} AS n FROM fin_obligations o WHERE o.id=?`, key);
  if (reversed(v.to.id)) financeError('要抵的那笔已经红字冲销了，请选还没结清的另一笔。');
  const credit = allocatedCents(db, 'obligation_id', v.from.id) - from.amount_cents - reversed(v.from.id),
    owed = to.amount_cents - allocatedCents(db, 'obligation_id', v.to.id);
  if (credit <= 0) financeError('这笔往来没有多付，不能转抵。');
  if (owed <= 0) financeError('要抵的那笔已经结清了。');
  if (v.amount > credit || v.amount > owed) financeError('转抵金额超过多付金额或对方未结金额。');
}

/**
 * 多付的钱出自哪几张资金单：按这笔往来上各张资金单核销的净额从多到少取，一张不够接着取下一张，
 * 每张资金单各一张对冲凭证、各一对正负核销（撤销转抵按张撤，见 FinanceAllocations.revoke 的成对处理）。
 * 整个转抵在一个事务里，任何一张出错全部回滚。
 */
function transferSources(store: Store, v: TransferInput) {
  const sources = many(
    store.db,
    z.object({ cash_id: z.number(), amount: z.number() }),
    `SELECT cash_id,sum(amount_cents) AS amount FROM fin_allocations
    WHERE obligation_id=? AND status='active' GROUP BY cash_id HAVING sum(amount_cents)>0
    ORDER BY sum(amount_cents) DESC,cash_id DESC`,
    v.from.id,
  );
  let left = v.amount;
  const parts = sources.flatMap((s) => {
    const amount = Math.min(left, s.amount);
    left -= amount;
    return amount > 0 ? [{ cashId: s.cash_id, amount }] : [];
  });
  if (left > 0) financeError('这笔往来上核销的资金单不够转抵这么多。');
  return parts;
}

/** 校验、按资金单拆开、每张出一张对冲凭证记一对正负核销，往来加版本并记审计 */
export function transferCredit(store: Store, ledger: FinanceLedger, user: Actor, v: TransferInput): z.output<typeof transferred> {
  const db = store.db;
  const from = row(db, 'fin_obligations', v.from.id),
    to = row(db, 'fin_obligations', v.to.id);
  checkVersion(from, v.from.version);
  checkVersion(to, v.to.version);
  checkTransfer(store, ledger, user, { v, from, to });
  const parts = transferSources(store, v);
  ledger.openPeriod(user, v.date);
  const insert = db.prepare('INSERT INTO fin_allocations(cash_id,obligation_id,date,amount_cents,voucher_id) VALUES(?,?,?,?,?)');
  const done = parts.map((part) => {
    const cash = row(db, 'fin_cash_documents', part.cashId);
    const rule = roleOf(cash.kind) ?? financeError('资金单方向不匹配。');
    const auxiliary = { kind: rule.auxiliary, id: from.party_id, name: from.party_name };
    const voucher = cashVoucher(ledger, user, {
      key: part.cashId,
      date: v.date,
      description: '多付转抵',
      entries: [entry(rule.party, part.amount, 0, auxiliary), entry(rule.party, 0, part.amount, auxiliary)],
      requestId: parts.length > 1 ? v.requestId.slice(0, TRANSFER_PREFIX) + ':' + part.cashId : v.requestId,
      cash: false,
    });
    for (const [o, amount] of [
      [from, -part.amount],
      [to, part.amount],
    ] as const) {
      const key = Number(insert.run(part.cashId, o.id, v.date, amount, voucher).lastInsertRowid);
      financeAudit(store, user, {
        action: 'transfer_credit',
        entity: 'fin_allocations',
        id: key,
        before: null,
        after: row(db, 'fin_allocations', key),
      });
    }
    return { ...part, voucherId: voucher };
  });
  for (const o of [from, to]) {
    db.prepare('UPDATE fin_obligations SET version=version+1 WHERE id=?').run(o.id);
    financeAudit(store, user, {
      action: 'transfer_credit',
      entity: 'fin_obligations',
      id: o.id,
      before: o,
      after: row(db, 'fin_obligations', o.id),
    });
  }
  return { amount: v.amount, parts: done };
}
