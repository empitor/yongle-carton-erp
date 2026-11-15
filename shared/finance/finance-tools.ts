import { z } from 'zod';
import { periodSchema, accountCodeSchema, reportKinds } from './finance.js';
import { dateSchema } from '../core/index.js';

export const financeReadTools = [
  'finance.summary',
  'finance.monthly',
  'finance.receivables',
  'finance.payables',
  'finance.ledger',
  'finance.reports',
  'finance.invoices',
  'finance.cash',
] as const;
/** 每个工具查什么。模型靠这个选工具，不能都写成“财务查询”。 */
export const financeToolDescriptions: Record<(typeof financeReadTools)[number], string> = {
  'finance.summary': '查财务概览：待处理事项、资金账户余额、当前期间状态。财务没启用也能查。',
  'finance.monthly':
    '查某月理论盈亏（送货减到货）、实际盈亏（实收减实付）、接单额和缺价格/税率的条数，问这个月赚多少用它，理论和实际分开说。财务没启用也能查，period 默认本月。',
  'finance.receivables':
    '查应收：问客户欠我们多少、到期没有时用。应收为空不等于不欠，已送货还没进应收的看 finance.monthly。date 是截至哪天（默认今天）。“按单位汇总”里预收款是还没抵货款的，还欠已扣掉预收款（负数是客户多付）；问还欠多少按“还欠”答，不要把 rows 的 balance 相加。reversal_state 有值的是冲销成对的两笔，不算欠款。',
  'finance.payables':
    '查应付：问我们欠供应商多少、到期没有时用。date 是截至哪天（默认今天）。“按单位汇总”里预付款是还没抵货款的，还欠已扣掉预付款（负数是我们多付）；问还欠多少按“还欠”答，不要把 rows 的 balance 相加。reversal_state 有值的是冲销成对的两笔，不算欠款。',
  'finance.ledger': '查某月的凭证明细账（财务启用后才有数据）。必须传 period，可按 account 筛。',
  'finance.reports': '查正式报表（资产负债、利润、现金流量、试算平衡）。财务启用后才有数据。',
  'finance.invoices': '查发票。',
  'finance.cash': '查收付款记录。',
};
/** 按单位汇总给模型看的叫法：英文键（held、net……）模型会照搬进回答，换成中文。advance 应收是预收款、应付是预付款。 */
const partyFieldNames = (advance: string): Record<string, string> => ({
  date: '截至日期',
  rows: '各单位',
  totals: '合计',
  party_id: '单位编号',
  party_name: '单位',
  held: '未到期',
  due: '已到期',
  no_terms: '没有账期',
  earliest_due: '最早到期日',
  advance,
  uninvoiced: '未开票',
  net: '还欠',
  credit_limit: '信用额度',
  over_limit: '超出额度',
});
const renameKeys = (value: unknown, names: Record<string, string>): unknown =>
  Array.isArray(value)
    ? value.map((v) => renameKeys(v, names))
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [Object.hasOwn(names, k) ? names[k] : k, renameKeys(v, names)]))
      : value;
/** 应收应付的结果给模型之前，按单位汇总换成中文叫法；别的字段各处含义不一，不动。 */
export function financeForModel(name: string, result: unknown) {
  if (!result || typeof result !== 'object' || !('byParty' in result)) return result;
  const { byParty, ...rest } = result;
  return { ...rest, 按单位汇总: renameKeys(byParty, partyFieldNames(name === 'finance.payables' ? '预付款' : '预收款')) };
}
/** 助手一次读几条：默认、最多 */
const READ_LIMIT = 20;
const READ_LIMIT_MAX = 50;
export const financeReadQuery = z.strictObject({
  period: periodSchema.optional(),
  date: dateSchema.optional(),
  account: accountCodeSchema.optional(),
  partyId: z.string().trim().min(1).max(100).optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(READ_LIMIT_MAX).default(READ_LIMIT),
  kind: z.enum(reportKinds).optional(),
});
