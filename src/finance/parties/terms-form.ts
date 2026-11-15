import { centsInput, toCents } from '../../ui/index';
import type { FinData } from '../fin-api';

/* 账期窗口的数据：服务端存的账期 ⇄ 窗口里填的内容。比例全部由人填。 */

/** 服务端存的一个单位的账期（GET /finance/party-terms/:kind/:id，options 已按 termOptions 解析补齐） */
type StoredTerms = NonNullable<FinData<'GET /finance/party-terms/:kind/:id'>>;
type TermOptions = StoredTerms['options'];
/** 现结优惠的一档、分期的一期、压款利息：窗口里填的和存的是同一个样子 */
export type Discount = TermOptions['discounts'][number];
export type Installment = TermOptions['installments'][number];
export type Interest = NonNullable<TermOptions['interest']>;

/** 账期方式：没有账期、压几个月每月固定日付、压若干天 */
export const termTypes = ['none', 'monthly', 'days'] as const;
/** 下拉选中的值换回取值表里的那一项（下拉只列取值表里的，选不出别的） */
export const optionOf = <T extends string>(options: readonly T[], value: string) =>
  options.find((o) => o === value);

export type TermsForm = {
  termType: (typeof termTypes)[number];
  termDays: string;
  termMonths: string;
  paymentDay: string;
  cutoffDay: string;
  taxRate: string;
  taxMode: string;
  creditLimit: string;
  discounts: Discount[];
  installments: Installment[];
  deposits: boolean;
  interest: Interest | null;
};

export const emptyTerms: TermsForm = {
  termType: 'none',
  termDays: '',
  termMonths: '',
  paymentDay: '',
  cutoffDay: '',
  taxRate: '',
  taxMode: '',
  creditLimit: '',
  discounts: [],
  installments: [],
  deposits: false,
  interest: null,
};

/** 数字格子读回成文字：没存的是空 */
const text = (v: number | null) => (v != null ? String(v) : '');

/** 读回服务端存的账期。“没有约定”单独存成 none；压 0 天是当天到期，照常读回成按天。没设置过的是空表。 */
export function termsFormOf(t: StoredTerms | null): TermsForm {
  if (!t) return emptyTerms;
  const { options } = t;
  return {
    termType: t.term_type === 'none' ? 'none' : t.term_type === 'monthly' ? 'monthly' : 'days',
    termDays: t.term_type === 'days' ? text(t.term_days) : '',
    termMonths: text(t.term_months),
    paymentDay: text(t.payment_day),
    cutoffDay: text(t.cutoff_day),
    taxRate: t.tax_rate ?? '',
    taxMode: t.tax_mode ?? '',
    creditLimit: centsInput(t.credit_limit),
    discounts: options.discounts,
    installments: options.installments,
    deposits: options.deposits,
    interest: options.interest,
  };
}

/** 天数、月数这类整数格子：空着按 0 算 */
export const num = (v: string) => (v === '' ? 0 : Number(v));

/** 一项规则都没填（新建时不让这样保存）。 */
export const isBlankTerms = (f: TermsForm) =>
  f.termType === 'none' &&
  !f.taxRate.trim() &&
  !f.taxMode &&
  !f.creditLimit.trim() &&
  !f.discounts.length &&
  !f.installments.length &&
  !f.deposits &&
  !f.interest;

/** 保存时发给服务端的内容（不含版本号）。 */
export type TermsBody = ReturnType<typeof termsBody>;
export function termsBody(f: TermsForm) {
  const term =
    f.termType === 'monthly'
      ? {
          termType: f.termType,
          termMonths: Number(f.termMonths),
          paymentDay: Number(f.paymentDay),
          cutoffDay: f.cutoffDay ? Number(f.cutoffDay) : null,
        }
      : f.termType === 'none'
        ? { termType: 'none' }
        : { termType: 'days', termDays: Number(f.termDays) };
  return {
    ...term,
    taxRate: f.taxRate.trim() || null,
    taxMode: f.taxMode || null,
    creditLimit: f.creditLimit.trim() ? toCents(f.creditLimit) : null,
    options: {
      discounts: f.discounts,
      installments: f.installments,
      deposits: f.deposits,
      interest: f.interest,
    },
  };
}
