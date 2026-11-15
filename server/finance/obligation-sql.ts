/**
 * 往来余额怎么算的 SQL 片段：已核销合计、按单位余额、还欠着的往来和分期到期、有效的收付款核销。
 * 往来、到期、账龄、对账单、月度台账、结账检查都用这几段，口径只有这一份。
 * 红字冲销成对的判断在 reversal-pairs.ts。
 */
import { isReversed } from './reversal-pairs.js';

/**
 * 凭证 v（表别名）已被红冲（红字凭证没作废就算；posted 为真时只认已记账的红字凭证）。
 * 财务派生凭证（保证金、利息、坏账、票据……）红冲以后，来源记录的效果都按它排除，见 derived-vouchers.ts。
 */
export const voucherReversed = (v: string, posted = false) =>
  `EXISTS(SELECT 1 FROM fin_vouchers vr WHERE vr.reversal_of=${v}.id AND vr.status ${posted ? "='posted'" : "<>'void'"})`;
/** 凭证 v 还算数：没作废、也没被红冲 */
export const voucherStands = (v: string) => `(${v}.status<>'void' AND NOT ${voucherReversed(v)})`;
/** 派生凭证撤回、红冲以后的标记（列表的 *voucher_state）；还算数的是 NULL */
export const voucherUndone = { withdrawn: 'withdrawn', reversed: 'reversed' } as const;
export const voucherState = (v: string) =>
  `CASE WHEN ${v}.status='void' THEN '${voucherUndone.withdrawn}' WHEN ${voucherReversed(v)} THEN '${voucherUndone.reversed}' END`;
/**
 * 列表里带一张凭证的三列（来源页面给撤回、红冲入口用）：{prefix}voucher_id、{prefix}voucher_status（凭证状态）、
 * {prefix}voucher_state（voucherState）。idExpr 是凭证编号的 SQL 表达式；都是子查询列，和列表同一条查询取。
 */
export const voucherColumns = (idExpr: string, prefix: string) => `${idExpr} AS ${prefix}voucher_id,
  (SELECT y.status FROM fin_vouchers y WHERE y.id=${idExpr}) AS ${prefix}voucher_status,
  (SELECT ${voucherState('y')} FROM fin_vouchers y WHERE y.id=${idExpr}) AS ${prefix}voucher_state`;
/** 某个来源记录最近一张原凭证（不含红字）的编号 */
export const latestSourceVoucher = (module: string, idExpr: string) =>
  `(SELECT max(x.id) FROM fin_vouchers x WHERE x.module_source='${module}' AND x.module_id=${idExpr} AND x.reversal_of IS NULL)`;
const allocations = (posted: boolean) => `(
    SELECT id,cash_id,obligation_id,date,amount_cents,voucher_id,status,discount_cents FROM fin_allocations
    UNION ALL SELECT NULL,NULL,obligation_id,date,amount_cents,voucher_id,'active',0 FROM fin_deposit_actions WHERE kind='apply'
    UNION ALL SELECT NULL,NULL,obligation_id,date,amount_cents,voucher_id,'active',0 FROM fin_bad_debts WHERE kind IN ('writeoff','note')
  ) a JOIN fin_vouchers av ON av.id=a.voucher_id
  WHERE (a.status IN ('active','reversing') OR (a.status='revoked' AND EXISTS(
    SELECT 1 FROM fin_allocations r WHERE r.reversal_of=a.id))) AND av.status ${posted ? "='posted'" : "<>'void'"}
    -- 保证金转抵、坏账核销、票据结算的凭证被红冲就不算了（收付款核销撤销时另记反向核销，不走这条）
    AND (a.id IS NOT NULL OR NOT ${voucherReversed('av', posted)})`;
/**
 * 往来已核销的金额：收付款核销、保证金抵扣、坏账核销，加上承兑票据结算（fin_bad_debts 里 kind='note'，见 notes.ts）。
 */
export const allocationSum = (condition: string, posted = false) => `coalesce((
  SELECT sum(a.amount_cents ${condition.startsWith('a.cash_id') ? '-a.discount_cents' : ''}) FROM ${allocations(posted)}
  AND (${condition})
),0)`;
/** 往来 o 按日期的核销（和 allocationSum 同一口径，撤销核销是负数）：压款利息按每天的余额算 */
export const allocationsByDate = (o: string) =>
  `SELECT a.date,sum(a.amount_cents) AS amount FROM ${allocations(false)} AND a.obligation_id=${o} GROUP BY a.date`;
/**
 * 往来单位的余额，对账单期初、期末和应收应付“按单位”的“还欠”共用这一个算法，两边对得上：
 * 总账里这个单位的应收（应付）加预收（预付）的期初和已记账发生额（红字凭证反号），
 * 再加还没记账的送货、到货往来（手工往来、期初往来不加，它们记账后才进总账）。
 * - amount：按应收（应付）方向的净额，预收（预付）已扣掉；
 * - advance：其中还没抵货款的预收（预付），正数是对方多付、钱还挂着。
 * before 为 true 时算到 date 前一天（对账单期初），否则算到 date 当天。partyId 为 null 时按单位分组返回全部。
 */
export function partyBalances(kind: 'receivable' | 'payable', date: string, before: boolean, partyId: string | null) {
  const ar = kind === 'receivable';
  const code = ar ? '1122' : '2202',
    adv = ar ? '2203' : '1123',
    aux = ar ? 'customer' : 'supplier',
    sign = ar ? 1 : -1,
    cmp = before ? '<' : '<=';
  const on = (e: string) => `(${e}.account_code LIKE '${code}%' OR ${e}.account_code LIKE '${adv}%')`;
  const isAdvance = (e: string) => `(CASE WHEN ${e}.account_code LIKE '${adv}%' THEN 1 ELSE 0 END)`;
  const red = `(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)`;
  return {
    sql: `SELECT party_id,max(party_name) AS party_name,sum(amount) AS amount,sum(advance) AS advance FROM (
      SELECT o.auxiliary_id AS party_id,o.auxiliary_name AS party_name,${sign}*(o.debit-o.credit) AS amount,
        ${-sign}*${isAdvance('o')}*(o.debit-o.credit) AS advance
        FROM fin_opening o WHERE ${on('o')} AND o.auxiliary_kind='${aux}' AND (? IS NULL OR o.auxiliary_id=?)
      UNION ALL SELECT e.auxiliary_id,e.auxiliary_name,${sign}*${red}*(e.debit-e.credit),${-sign}*${isAdvance('e')}*${red}*(e.debit-e.credit)
        FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id
        WHERE v.status='posted' AND ${on('e')} AND e.auxiliary_kind='${aux}' AND (? IS NULL OR e.auxiliary_id=?) AND v.date${cmp}?
      UNION ALL SELECT o.party_id,o.party_name,o.amount_cents,0
        FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
        WHERE o.kind='${kind}' AND (? IS NULL OR o.party_id=?) AND o.date${cmp}? AND o.opening_id IS NULL AND o.tax_status<>'superseded'
        AND (o.voucher_id IS NULL OR (v.status<>'posted' AND v.status<>'void' AND o.event_id IS NOT NULL))
      ) GROUP BY party_id`,
    args: [partyId, partyId, partyId, partyId, date, partyId, partyId, date] as (string | null)[],
  };
}

/**
 * 往来 o 算到期日、分期、现金折扣期限、按开单日的账龄用的基准日：来源单据的日期，单据所在月份已结账、晚记账的
 * 不让对方多出账期；手工往来、期初往来没有来源单据，用往来日期。
 */
export const obligationBaseDate = (o: string) =>
  `coalesce((SELECT be.date FROM fin_events be WHERE be.id=${o}.event_id),${o}.date)`;
export const openItems = `SELECT o.*,${obligationBaseDate('o')} AS base_date,o.amount_cents-${allocationSum('a.obligation_id=o.id')} AS balance
  FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
  WHERE o.amount_cents>0 AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status<>'void')
  AND NOT ${isReversed('o')}`;
export const dueItems = `WITH items AS (${openItems}),
  plans AS (SELECT p.*,sum(p.amount_cents) OVER(PARTITION BY p.obligation_id ORDER BY p.due_date,p.position
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative FROM fin_installments p)
  SELECT o.id,o.kind,o.party_id,o.party_name,o.date,coalesce(p.id,0) AS installment_id,
    CASE WHEN p.id IS NULL THEN o.due_date ELSE p.due_date END AS due_date,
    CASE WHEN p.id IS NULL THEN o.balance ELSE min(p.amount_cents,max(0,p.cumulative-(o.amount_cents-o.balance))) END AS balance
  FROM items o LEFT JOIN plans p ON p.obligation_id=o.id`;

/**
 * 账龄分档，逐笔和合计都读这一列，只有这一份。没有到期日（没有账期）的单独一档 -1，
 * 和“按单位”的“没有账期”一列同一个判断（due_date IS NULL），不按天数进 1–30 天；
 * 其余按账龄天数 days 分段：0 天及以内第 0 档，第 i 段 i，超过最后一段 bands+1。
 * 占位参数依次是各段天数。
 */
export const noTermsBucket = -1;
export const agingBucket = (bands: number) =>
  `CASE WHEN due_date IS NULL THEN ${noTermsBucket} WHEN days<=0 THEN 0 ` +
  Array.from({ length: bands }, (_, i) => 'WHEN days<=? THEN ' + (i + 1)).join(' ') +
  ` ELSE ${bands + 1} END`;

export const activeCashAllocation = `a.reversal_of IS NULL AND original.status<>'void' AND NOT EXISTS(
  SELECT 1 FROM fin_allocations r JOIN fin_vouchers rv ON rv.id=r.voucher_id
  WHERE r.reversal_of=a.id AND rv.status='posted')`;
export const allocationReversalMessage = '送货单已冲销，请先撤销核销并记账相关红冲。';
