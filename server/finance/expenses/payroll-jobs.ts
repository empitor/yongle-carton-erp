/**
 * 工资计提、工资发放两步在期末执行记录（fin_period_jobs）里的明细：计提的成本、实发、代扣合计和挂账科目，
 * 发放的每一笔。payroll.ts 写进去、读出来都按这里的结构。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { one, parseStoredJson, rows } from '../../core/index.js';

/** 工资计提（kind='payroll'）的明细：成本、实发、工资科目、代扣合计、当时选的挂账科目（没另选的不写） */
export const accrualDetails = z.object({
  cost: z.number(),
  net: z.number(),
  wagesAccount: z.string(),
  totals: z.object({ social: z.number(), housing: z.number(), tax: z.number() }),
  accounts: z.object({
    socialAccount: z.string().optional(),
    housingAccount: z.string().optional(),
    taxAccount: z.string().optional(),
  }),
});
/** 工资发放（kind='payroll_pay'）的明细：每一笔发放（资金单、金额）、累计已发、计提的实发 */
export const paymentDetails = z.object({
  payments: z.array(z.object({ cashId: z.number(), amount: z.number() })),
  paid: z.number(),
  net: z.number(),
});

/** 这个月某一步的执行记录（没有是 undefined） */
export function payrollJob(db: DatabaseSync, period: string, kind: 'payroll' | 'payroll_pay') {
  return one(db, rows.fin_period_jobs, 'SELECT * FROM fin_period_jobs WHERE period=? AND kind=?', period, kind);
}

/** 读执行记录里的工资计提明细 */
export function readAccrual(job: { period: string; details: string }) {
  return parseStoredJson(accrualDetails, job.details, `fin_period_jobs.details（${job.period} 工资计提）`);
}

/** 读执行记录里的工资发放明细 */
export function readPayments(job: { period: string; details: string }) {
  return parseStoredJson(paymentDetails, job.details, `fin_period_jobs.details（${job.period} 工资发放）`);
}
