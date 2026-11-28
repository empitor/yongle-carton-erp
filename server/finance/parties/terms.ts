import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { many, one, parseStoredJson, rows } from '../../core/index.js';
import { financeError } from '../base/core.js';
import { HUNDRED_PERCENT, PERCENT_SCALE, percent, percentCents, percentage, safeCents } from '../base/amounts.js';
import { adjacentPeriod, endOfMonth } from '../base/periods.js';
import { DAYS_PER_YEAR, MAX_DAY_OF_MONTH, MONTHS_PER_YEAR, dayDistance, dayOf, periodOf, shiftDays } from '../base/days.js';

/** 账期最长 3650 天（十年）、月结最多隔 120 个月；建表的 CHECK 同样的数 */
const TERM_MAX_DAYS = 3650;
const TERM_MAX_MONTHS = 120;
/** 一个单位最多几条现结优惠、分几期 */
const MAX_DISCOUNT_RULES = 20;
const MAX_INSTALLMENTS = 24;

export const termDays = z.number().int().min(0).max(TERM_MAX_DAYS);
export const termMonths = z.number().int().min(0).max(TERM_MAX_MONTHS);
/** 月结的付款日、截止日：1 到 31 号 */
export const dayOfMonth = z.number().int().min(1).max(MAX_DAY_OF_MONTH);
const calendar = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('days'), days: termDays }),
  z.strictObject({
    type: z.literal('monthly'),
    months: termMonths,
    paymentDay: dayOfMonth,
    cutoffDay: dayOfMonth.optional(),
  }),
]);
/** 账期里的其他约定（fin_party_terms.options）：现结优惠、分期、保证金、压款利息。存的就是它解析后的样子 */
export const termOptions = z
  .strictObject({
    discounts: z
      .array(
        z.strictObject({
          type: z.enum(['month', 'days', 'before_due']),
          days: termDays.default(0),
          rate: percentage,
        }),
      )
      .max(MAX_DISCOUNT_RULES)
      .default([]),
    installments: z
      .array(z.strictObject({ rate: percentage, rule: calendar }))
      .max(MAX_INSTALLMENTS)
      .default([])
      .refine(
        (v) => !v.length || v.reduce((n, r) => n + percent(r.rate), 0n) === HUNDRED_PERCENT,
        '分期比例合计须为 100%。',
      ),
    deposits: z.boolean().default(false),
    interest: z
      .strictObject({
        rate: percentage,
        unit: z.enum(['annual', 'monthly']),
        basis: z.enum(['overdue', 'document']),
        freeDays: termDays.default(0),
      })
      .nullable()
      .default(null),
  })
  .default(() => ({ discounts: [], installments: [], deposits: false, interest: null }));
type TermOptions = z.output<typeof termOptions>;

/** 一个单位的账期（fin_party_terms 一行）；kind 是 customer 或 supplier，没设过是 undefined */
export function partyTerms(db: DatabaseSync, kind: string, partyId: string) {
  return one(db, rows.fin_party_terms, 'SELECT * FROM fin_party_terms WHERE kind=? AND party_id=?', kind, partyId);
}

/** 读账期约定的文字（没有就是空的约定） */
export function readTermOptions(text: string | undefined, where: string) {
  return parseStoredJson(termOptions, text ?? '{}', where);
}

/**
 * 往来上记的账期快照（fin_obligations.terms_snapshot）：挂往来时这个单位的账期（fin_party_terms 一行；
 * 手工往来存整行，业务往来存账期几列和 options）。以后账期改了，这笔的到期日、优惠、分期、利息仍按当时的。
 */
const termsSnapshot = rows.fin_party_terms.partial();
export type TermsSnapshot = z.output<typeof termsSnapshot>;
/** 写进 terms_snapshot 的文字；没有账期是 NULL */
export function termsSnapshotText(terms: TermsSnapshot | null | undefined) {
  return terms ? JSON.stringify(termsSnapshot.parse(terms)) : null;
}
/** 读 terms_snapshot；NULL（没有账期）是 null */
export function readTermsSnapshot(text: string | null, where: string) {
  return text === null ? null : parseStoredJson(termsSnapshot.nullable(), text, where);
}
/** 往来账期快照里的约定：没有账期、快照里没有约定都按空的约定 */
export function snapshotOptions(text: string | null, where: string) {
  return readTermOptions(readTermsSnapshot(text, where)?.options, where + ' 的 options');
}

/** 算到期日要的账期那几列 */
type TermsRule = Pick<TermsSnapshot, 'term_type' | 'term_days' | 'term_months' | 'payment_day' | 'cutoff_day'>;

/**
 * 按账期算到期日。term_type='none' 是“没有约定”：只保存税率、额度等其他规则，到期日留空，
 * 不算逾期、不进到期提醒，和“压 0 天”（当天到期）是两回事。
 */
export function dueDate(date: string, terms: TermsRule | null | undefined) {
  if (!terms || terms.term_type === 'none') return null;
  if (terms.term_type !== 'monthly') return shiftDays(date, Number(terms.term_days));
  const target = adjacentPeriod(
    periodOf(date),
    Number(terms.term_months) + Number(dayOf(date) > Number(terms.cutoff_day ?? MAX_DAY_OF_MONTH)),
  );
  return target + '-' + String(Math.min(Number(terms.payment_day), dayOf(endOfMonth(target)))).padStart(2, '0');
}

/** 算利息要的往来那几列（往来一行；base_date 是来源单据的日期，见 obligationBaseDate，没有按往来日期） */
type InterestItem = {
  id?: number;
  terms_snapshot: string | null;
  date: string;
  due_date: string | null;
  amount_cents: number;
  base_date?: string | null;
};

/** 每天按那天的余额计息：把“余额 × 天数”从 from 的第二天起逐段加到 asOf，核销当天仍按核销前的余额 */
function weightedBalance(start: bigint, from: string, asOf: string, paid: readonly { date: string; amount: number }[]) {
  const changes = [...paid].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  // 从 from 的第二天起，每段 (cursor, 下一个核销日] 按段首余额计
  const next = shiftDays(from, 1);
  let balance = start;
  for (const c of changes) if (c.date < next) balance -= BigInt(c.amount);
  let weighted = 0n,
    days = 0,
    cursor = from;
  const add = (to: string) => {
    const span = Math.max(0, dayDistance(cursor, to));
    if (balance > 0n && span) {
      weighted += balance * BigInt(span);
      days += span;
    }
    if (to > cursor) cursor = to;
  };
  for (const c of changes) {
    if (c.date < next || c.date >= asOf) continue;
    add(c.date);
    balance -= BigInt(c.amount);
  }
  add(asOf);
  return { weighted, days, balance };
}

/**
 * 压款利息建议：从上次确认算到的那天之后（after，不含；没确认过从起算日）算到 asOf，只算已经过去的天数。
 * 每天按那天的余额计息：核销当天仍按核销前的余额，第二天起扣掉，所以付清的第二天起就没有利息；
 * 几次确认合起来正好是实际逾期天数的利息。o 是往来一行（amount_cents、date、due_date、terms_snapshot），
 * paid 是它按日期的核销（allocationsByDate）。先把“余额 × 天数”加总，最后只取整一次。
 * 没设利息规则或没有起算日返回 null。
 */
export function overdueInterest(
  o: InterestItem,
  asOf: string,
  after: string | null,
  paid: readonly { date: string; amount: number }[],
) {
  const terms = snapshotOptions(o.terms_snapshot, '往来 ' + String(o.id) + ' 的账期快照').interest;
  if (!terms) return null;
  // 按开单日起息：基准是来源单据的日期（obligationBaseDate，行里的 base_date），晚记账不少算利息
  const base = terms.basis === 'document' ? (o.base_date ?? o.date) : o.due_date;
  if (!base) return null;
  const begins = shiftDays(base, terms.freeDays);
  const from = after && after > begins ? after : begins;
  const { weighted, days, balance } = weightedBalance(BigInt(o.amount_cents), from, asOf, paid);
  const amount = percentCents(weighted, terms.rate, terms.unit === 'monthly' ? MONTHS_PER_YEAR : 1, DAYS_PER_YEAR);
  return {
    amount,
    begins,
    from,
    asOf,
    days,
    balance: Number(balance > 0n ? balance : 0n),
    rate: terms.rate,
    unit: terms.unit,
    basis: terms.basis,
  };
}
export function installments(
  amount: number,
  date: string,
  terms: Pick<TermsSnapshot, 'options'> | null | undefined,
) {
  const options = readTermOptions(terms?.options, '账期约定（分期）');
  const shares = options.installments.map(({ rate, rule }, i) => {
    const units = BigInt(amount) * percent(rate);
    const due =
      rule.type === 'days'
        ? shiftDays(date, rule.days)
        : dueDate(date, {
            term_type: 'monthly',
            term_months: rule.months,
            payment_day: rule.paymentDay,
            cutoff_day: rule.cutoffDay,
          });
    return { i, due, amount: Number(units / HUNDRED_PERCENT), remainder: units % HUNDRED_PERCENT };
  });
  if (!shares.length) return [];
  const left = amount - shares.reduce((n, r) => n + r.amount, 0);
  if (left < 0 || left > shares.length) financeError('分期金额不可分摊。');
  const priority = [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1,
  );
  for (const item of priority.slice(0, left)) item.amount++;
  return shares.map(({ i, due, amount }) => ({ position: i + 1, due, amount }));
}
/**
 * 往来金额变了（收到含税发票、红票冲减、补了税率），已有的分期按原来各期金额的比例重算：
 * 前面各期按比例取整到分，尾差都落在最后一期，合计正好等于新金额。没有分期的往来不动。
 * 返回是否改过。
 */
export function rescaleInstallments(db: DatabaseSync, obligationId: number, amount: number) {
  const plan = many(
    db,
    rows.fin_installments.pick({ id: true, amount_cents: true }),
    'SELECT id,amount_cents FROM fin_installments WHERE obligation_id=? ORDER BY position',
    obligationId,
  );
  if (!plan.length) return false;
  const target = BigInt(amount);
  const old = plan.reduce((n, r) => n + BigInt(r.amount_cents), 0n);
  if (old === target) return false;
  const update = db.prepare('UPDATE fin_installments SET amount_cents=?,version=version+1 WHERE id=?');
  let used = 0n;
  plan.forEach((r, i) => {
    const before = BigInt(r.amount_cents);
    const value = i === plan.length - 1 ? target - used : old === 0n ? 0n : (target * before) / old;
    used += value;
    if (value !== before) update.run(safeCents(value), r.id);
  });
  return true;
}
/** 现结优惠到哪天截止：本月底、开单后几天、到期前几天；没有到期日的“到期前”不算 */
function discountDeadline(rule: TermOptions['discounts'][number], date: string, due: string | null) {
  if (rule.type === 'month') return endOfMonth(periodOf(date));
  if (rule.type === 'days') return shiftDays(date, rule.days);
  return due ? shiftDays(due, -rule.days) : null;
}
/** 这笔往来在 paid 这天付能享受的现结优惠（取最多的一条），没有返回 null */
export function discount(date: string, due: string | null, paid: string, amount: number, options: TermOptions) {
  const valid = options.discounts.flatMap((rule) => {
    const deadline = discountDeadline(rule, date, due);
    if (!deadline || paid > deadline || paid < date) return [];
    const early = due ? dayDistance(paid, due) : 0;
    return [
      {
        rate: rule.rate,
        amount: percentCents(amount, rule.rate),
        deadline,
        annualized:
          early > 0
            ? {
                numerator: String(percent(rule.rate) * BigInt(DAYS_PER_YEAR)),
                denominator: String(BigInt(early) * PERCENT_SCALE),
              }
            : null,
      },
    ];
  });
  return valid.sort((a, b) => b.amount - a.amount)[0] ?? null;
}
