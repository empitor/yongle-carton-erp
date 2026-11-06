import { z } from 'zod';
import { adjacentPeriod, endOfMonth, safeCents } from './query.js';
import { financeError } from './core.js';
export const percentage = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,6})?$/)
  .refine((v) => /^\d{1,3}(\.\d{1,6})?$/.test(v) && percent(v) <= 100_000_000n);
export function percent(v: string) {
  const [a, b = ''] = v.split('.');
  return BigInt(a + b.padEnd(6, '0'));
}
export function percentCents(amount: number, rate: string, numerator = 1, denominator = 1) {
  const d = 100_000_000n * BigInt(denominator);
  return safeCents((2n * BigInt(amount) * percent(rate) * BigInt(numerator) + d) / (2n * d));
}
const days = z.number().int().min(0).max(3650);
const calendar = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('days'), days }),
  z.strictObject({
    type: z.literal('monthly'),
    months: z.number().int().min(0).max(120),
    paymentDay: z.number().int().min(1).max(31),
    cutoffDay: z.number().int().min(1).max(31).optional(),
  }),
]);
export const termOptions = z
  .strictObject({
    discounts: z
      .array(
        z.strictObject({
          type: z.enum(['month', 'days', 'before_due']),
          days: days.default(0),
          rate: percentage,
        }),
      )
      .max(20)
      .default([]),
    installments: z
      .array(z.strictObject({ rate: percentage, rule: calendar }))
      .max(24)
      .default([])
      .refine(
        (v) => !v.length || v.reduce((n, r) => n + percent(r.rate), 0n) === 100_000_000n,
        '分期比例合计须为 100%。',
      ),
    deposits: z.boolean().default(false),
    interest: z
      .strictObject({
        rate: percentage,
        unit: z.enum(['annual', 'monthly']),
        basis: z.enum(['overdue', 'document']),
        freeDays: days.default(0),
      })
      .nullable()
      .default(null),
  })
  .default(() => ({ discounts: [], installments: [], deposits: false, interest: null }));
export function shiftDays(date: string, offset: number) {
  const time = new Date(date + 'T00:00:00Z');
  time.setUTCDate(time.getUTCDate() + offset);
  return time.toISOString().slice(0, 10);
}
export function dayDistance(a: string, b: string) {
  return (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000;
}
export function dueDate(date: string, terms: Record<string, unknown> | undefined) {
  if (!terms) return null;
  if (terms.term_type !== 'monthly') return shiftDays(date, Number(terms.term_days));
  const period = date.slice(0, 7);
  const target = adjacentPeriod(
    period,
    Number(terms.term_months) + Number(Number(date.slice(-2)) > Number(terms.cutoff_day ?? 31)),
  );
  return (
    target +
    '-' +
    String(Math.min(Number(terms.payment_day), Number(endOfMonth(target).slice(-2)))).padStart(
      2,
      '0',
    )
  );
}
export function installments(
  amount: number,
  date: string,
  terms: Record<string, unknown> | undefined,
) {
  const options = termOptions.parse(JSON.parse(String(terms?.options ?? '{}')));
  const shares = options.installments.map(({ rate, rule }, i) => {
    const units = BigInt(amount) * percent(rate),
      divisor = 100_000_000n;
    const due =
      rule.type === 'days'
        ? shiftDays(date, rule.days)
        : dueDate(date, {
            term_type: 'monthly',
            term_months: rule.months,
            payment_day: rule.paymentDay,
            cutoff_day: rule.cutoffDay,
          });
    return { i, due, amount: Number(units / divisor), remainder: units % divisor };
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
export function discount(
  date: string,
  due: string | null,
  paid: string,
  amount: number,
  raw: unknown,
) {
  const options = termOptions.parse(raw);
  const valid = options.discounts.flatMap((rule) => {
    const deadline =
      rule.type === 'month'
        ? endOfMonth(date.slice(0, 7))
        : rule.type === 'days'
          ? shiftDays(date, rule.days)
          : due
            ? shiftDays(due, -rule.days)
            : null;
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
                numerator: String(percent(rule.rate) * 365n),
                denominator: String(BigInt(early) * 1_000_000n),
              }
            : null,
      },
    ];
  });
  return valid.sort((a, b) => b.amount - a.amount)[0] ?? null;
}
