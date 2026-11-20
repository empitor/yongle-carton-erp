import { z } from 'zod';
import { dateSchema } from '../core/index.js';

export const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const accountCodeSchema = z.string().regex(/^\d{4}(\d{2}){0,3}$/);
export const accountCategories = ['asset', 'liability', 'equity', 'cost', 'profit'] as const;
export const auxiliaryKinds = [
  'customer',
  'supplier',
  'department',
  'employee',
  'project',
] as const;
/** 正式报表的种类：资产负债表、利润表、现金流量表、试算平衡表 */
export const reportKinds = ['balance', 'profit', 'cashflow', 'trial'] as const;
/** 结账时存快照、归档时打包的三张报表（试算平衡表不存） */
export const snapshotKinds = ['balance', 'profit', 'cashflow'] as const;
/**
 * 存进库、页面下拉也按这个顺序列的两组（建表 CHECK 由 tests/schema-constraints.test.ts 比对）：
 * 收付方式（fin_cash_documents.method）；账期方式（fin_party_terms.term_type）：没有账期、月结、按天
 */
export const cashMethods = ['银行', '现金', '承兑汇票', '微信', '支付宝', '其他'] as const;
export const termTypes = ['none', 'monthly', 'days'] as const;
export const centsSchema = z.number().int().nonnegative();
export const versionSchema = z.number().int().positive();
export const requestIdSchema = z.string().trim().min(1).max(100);
/** 税率、比例按万分之几存（10000 是 100%） */
export const BASIS_POINTS = 10000;
/** 账龄分几段、每段最长多少天（十年） */
const AGING_BANDS = 5;
const AGING_MAX_DAYS = 3650;
/** 凭证、分录摘要最长几个字 */
const DESCRIPTION_MAX = 200;
/** 期初一次最多录几行、凭证附件张数上限 */
const OPENING_ROWS_MAX = 10000;
const ATTACHMENT_COUNT_MAX = 10000;
/** 一种小税种的税率：万分之几，没填是 null */
const taxRate = z.number().int().min(0).max(BASIS_POINTS).nullable();
export const accountSchema = z.strictObject({
  code: accountCodeSchema,
  name: z.string().trim().min(1).max(100),
  category: z.enum(accountCategories),
  direction: z.enum(['debit', 'credit']),
  cashKind: z.enum(['cash', 'bank']).nullable().default(null),
  auxiliary: z.enum(auxiliaryKinds).nullable().default(null),
  enabled: z.boolean().default(true),
});
export const taxpayerSchema = z.enum(['general', 'small']);
export const settingsPatchSchema = z.strictObject({
  version: versionSchema,
  requestId: requestIdSchema,
  requireSeparateApprover: z.boolean().optional(),
  revenueRecognition: z.enum(['delivery', 'invoice']).optional(),
  taxpayer: taxpayerSchema.optional(),
  costAllocation: z.enum(['output', 'material']).optional(),
  agingDays: z
    .array(z.number().int().min(1).max(AGING_MAX_DAYS))
    .length(AGING_BANDS)
    .refine((days) => days.every((day, i) => i === 0 || day > days[i - 1]))
    .optional(),
  taxRates: z
    .strictObject({
      smallVat: taxRate,
      urban: taxRate,
      education: taxRate,
      localEducation: taxRate,
      income: taxRate,
    })
    .optional(),
});
const auxiliarySchema = z.strictObject({
  kind: z.enum(auxiliaryKinds),
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
});
const openingRowSchema = z.strictObject({
  accountCode: accountCodeSchema,
  auxiliary: auxiliarySchema.nullable().default(null),
  debit: centsSchema,
  credit: centsSchema,
  yearDebit: centsSchema,
  yearCredit: centsSchema,
});
export const openingSchema = z.strictObject({
  period: periodSchema,
  taxpayer: taxpayerSchema,
  version: versionSchema,
  requestId: requestIdSchema,
  rows: z.array(openingRowSchema).max(OPENING_ROWS_MAX),
});
const entrySchema = z.strictObject({
  accountCode: accountCodeSchema,
  description: z.string().trim().max(DESCRIPTION_MAX).default(''),
  debit: centsSchema,
  credit: centsSchema,
  auxiliary: auxiliarySchema.nullable().default(null),
  cashFlow: z.string().trim().min(1).max(100).nullable().default(null),
});
const minimumVoucherEntries = { count: 2, message: '至少填写两条分录。' } as const;
const voucherEntriesSchema = Object.assign(
  z.array(entrySchema).min(minimumVoucherEntries.count, minimumVoucherEntries.message).max(1000),
  { minimum: minimumVoucherEntries },
);
export const voucherSchema = z.strictObject({
  date: dateSchema,
  description: z.string().trim().min(1).max(DESCRIPTION_MAX),
  attachmentCount: z.number().int().min(0).max(ATTACHMENT_COUNT_MAX).default(0),
  entries: voucherEntriesSchema,
  requestId: requestIdSchema,
});
/** 改一张没记账的凭证：整张重写，带上打开时的版本 */
export const voucherEditSchema = voucherSchema.extend({ version: versionSchema });
/** 凭证推进一步或作废：带上打开时的版本 */
export const voucherChangeSchema = z.strictObject({ version: versionSchema, requestId: requestIdSchema });
/** 红字冲销：冲销凭证的日期和摘要 */
export const voucherReversalSchema = voucherChangeSchema.extend({
  date: dateSchema,
  description: voucherSchema.shape.description,
});
/** 新建或改一个科目：改的要带版本，新建的不带 */
export const accountChangeSchema = z.strictObject({
  account: accountSchema,
  version: versionSchema.optional(),
  requestId: requestIdSchema,
});
/** 凭证往前推一步（提交、审核、记账）或作废：一个动作一个地址 */
export const voucherTransitions = ['submit', 'approve', 'post', 'void'] as const;
export type VoucherTransition = (typeof voucherTransitions)[number];
export type FinanceEntry = z.infer<typeof entrySchema>;
