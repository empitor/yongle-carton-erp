import { z } from 'zod';
import { periodSchema, accountCodeSchema } from './finance.js';
import { dateSchema } from './domain.js';

export const financeReadTools = [
  'finance.summary',
  'finance.receivables',
  'finance.payables',
  'finance.ledger',
  'finance.reports',
  'finance.invoices',
  'finance.cash',
] as const;
export const financeReadQuery = z.strictObject({
  period: periodSchema.optional(),
  date: dateSchema.optional(),
  account: accountCodeSchema.optional(),
  partyId: z.string().trim().min(1).max(100).optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  kind: z.enum(['balance', 'profit', 'cashflow', 'trial']).optional(),
});
