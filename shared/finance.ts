import { z } from 'zod';
import { dateSchema } from './domain.js';

export const financePermissions = [
  'finance:view',
  'finance:edit',
  'finance:approve',
  'finance:cash',
  'finance:close',
] as const;
export type FinancePermission = (typeof financePermissions)[number];

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
export const centsSchema = z.number().int().nonnegative();
export const versionSchema = z.number().int().positive();
export const requestIdSchema = z.string().trim().min(1).max(100);
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
    .array(z.number().int().min(1).max(3650))
    .length(5)
    .refine((days) => days.every((day, i) => i === 0 || day > days[i - 1]))
    .optional(),
  taxRates: z
    .strictObject({
      smallVat: z.number().int().min(0).max(10000).nullable(),
      urban: z.number().int().min(0).max(10000).nullable(),
      education: z.number().int().min(0).max(10000).nullable(),
      localEducation: z.number().int().min(0).max(10000).nullable(),
      income: z.number().int().min(0).max(10000).nullable(),
    })
    .optional(),
});
export const auxiliarySchema = z.strictObject({
  kind: z.enum(auxiliaryKinds),
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
});
export const openingRowSchema = z.strictObject({
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
  rows: z.array(openingRowSchema).max(10000),
});
export const entrySchema = z.strictObject({
  accountCode: accountCodeSchema,
  description: z.string().trim().max(200).default(''),
  debit: centsSchema,
  credit: centsSchema,
  auxiliary: auxiliarySchema.nullable().default(null),
  cashFlow: z.string().trim().min(1).max(100).nullable().default(null),
});
export const voucherSchema = z.strictObject({
  date: dateSchema,
  description: z.string().trim().min(1).max(200),
  attachmentCount: z.number().int().min(0).max(10000).default(0),
  entries: z.array(entrySchema).min(2).max(1000),
  requestId: requestIdSchema,
});
export type FinanceEntry = z.infer<typeof entrySchema>;
