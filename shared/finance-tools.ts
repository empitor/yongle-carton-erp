import { z } from 'zod';
import { periodSchema, accountCodeSchema } from './finance.js';
import { dateSchema } from './domain.js';

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
    '查某月的理论盈亏（送货单减到货单）和实际盈亏（实收减实付）以及接单额，缺价格、缺税率的条数也在里面。问盈亏、这个月赚多少时用它。财务没启用也能查。period 可省略，默认本月。',
  'finance.receivables': '查应收：客户欠多少、账期和到期情况。可用 partyId 查某个客户。',
  'finance.payables': '查应付：欠供应商多少、账期和到期情况。可用 partyId 查某个供应商。',
  'finance.ledger': '查凭证明细账，要传 period，可传 account。财务启用后才有数据。',
  'finance.reports': '查正式报表，kind 可选 balance、profit、cashflow、trial。财务启用后才有数据。',
  'finance.invoices': '查发票。',
  'finance.cash': '查收付款记录。',
};
export const financeReadQuery = z.strictObject({
  period: periodSchema.optional(),
  date: dateSchema.optional(),
  account: accountCodeSchema.optional(),
  partyId: z.string().trim().min(1).max(100).optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  kind: z.enum(['balance', 'profit', 'cashflow', 'trial']).optional(),
});
