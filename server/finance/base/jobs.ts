/**
 * 期末执行记录（fin_period_jobs）：某个月的计提折旧、工资、成本、税费、损益结转各跑过没有、挂哪张凭证、明细是什么，
 * 撤回重做时冲销原凭证、把原记录改名留底；比较重算结果和原凭证用的按科目汇总。
 * 明细（details）各步骤的样子不一样，由各步骤自己定结构（写在调 periodJob 的文件旁边），写入和读出都按它校验。
 */
import { z } from 'zod';
import type { Store } from '../../core/index.js';
import type { Actor } from '../../core/index.js';
import { count, exists, many, one, rows } from '../../core/index.js';
import { financeAudit, financeError } from './core.js';
import { endOfMonth } from './periods.js';
import type { periodJobKinds } from './stored-values.js';

/** 撤回期末执行记录时要用的凭证能力（由调用方传 FinanceLedger，免得地基反引凭证层） */
type JobLedger = {
  openPeriod(user: Actor, date: string): void;
  get(actor: Actor | null, rawId: unknown): { header: { id: number; version: number; status: string } };
  reverse(
    actor: Actor | null,
    rawId: unknown,
    raw: unknown,
    call?: { linked?: boolean; permission?: 'finance:close' },
  ): { header: { id: number } };
  transition(
    actor: Actor | null,
    rawId: unknown,
    action: 'void',
    raw: unknown,
    call?: { linked?: boolean; permission?: 'finance:close' },
  ): unknown;
};

/** 重做时带上页面看到的原凭证号，防止从旧页面再点一次又冲一遍 */
export const expectedVoucher = z.number().int().positive().nullable().optional();
type PeriodJobKind = (typeof periodJobKinds)[number];

/** 一次期末执行：哪个月、哪一步、挂的凭证（没有凭证是 null），明细和它的结构 */
type PeriodJob<S extends z.ZodType> = {
  period: string;
  kind: PeriodJobKind;
  voucher: number | null;
  schema: S;
  details: z.input<S>;
};

/** 执行的结果（periodJob 返回的样子）：明细按这一步的结构 */
export function periodJobResult<S extends z.ZodType>(details: S) {
  return z.object({ period: z.string(), kind: z.string(), voucherId: z.number().nullable(), details });
}

/** 记下这个月执行了这一步（同一步一个月只能有一条，重做先 withdrawJob），明细按结构校验后存 */
export function periodJob<S extends z.ZodType>(store: Store, user: Actor, job: PeriodJob<S>) {
  const { period, kind, voucher } = job;
  if (exists(store.db, 'SELECT 1 FROM fin_period_jobs WHERE period=? AND kind=?', period, kind))
    financeError('该期间已执行此步骤。', 409);
  const details: z.output<S> = job.schema.parse(job.details);
  store.db
    .prepare('INSERT INTO fin_period_jobs(period,kind,voucher_id,details) VALUES(?,?,?,?)')
    .run(period, kind, voucher, JSON.stringify(details));
  const result = { period, kind, voucherId: voucher, details };
  financeAudit(store, user, { action: 'run', entity: 'fin_period_jobs', id: null, before: null, after: result });
  return result;
}

const jobNames: Partial<Record<PeriodJobKind, string>> = {
  depreciation: '计提折旧',
  payroll: '计提工资',
  costing: '计算成本',
  tax: '计提税费',
};
/** 撤回时写进原记录明细的 withdrawn：撤回时间、原因、红冲出来的凭证、作废的凭证 */
const withdrawnSchema = z.object({
  at: z.string(),
  reason: z.string(),
  reversal: z.number().nullable(),
  voided: z.number().nullable(),
});

/** 撤回哪个月的哪一步、为什么；expectedVoucherId 是页面看到的原凭证号（没有凭证是 null），和现在的对不上说明别处已经重做过 */
type Withdrawal = { period: string; kind: PeriodJobKind; reason: string; expectedVoucherId?: number | null };
/** 要冲掉的原凭证：凭证号、月份、留底后的名字（kind#序号，子请求号用）、红冲凭证的摘要 */
type JobVoucher = { voucherId: number; period: string; archived: string; description: string };

/** 原凭证已记账的在同一个月月末红冲（已经红冲过的不再冲），没记账的作废；返回红冲出来的、作废的凭证编号 */
function undoJobVoucher(store: Store, user: Actor, ledger: JobLedger, job: JobVoucher) {
  const date = endOfMonth(job.period);
  const header = ledger.get(user, job.voucherId).header;
  const ref = { version: Number(header.version), requestId: 'withdraw:' + job.period + ':' + job.archived };
  if (header.status === 'posted') {
    const existing = one(
      store.db,
      z.object({ id: z.number() }),
      "SELECT id FROM fin_vouchers WHERE reversal_of=? AND status<>'void'",
      header.id,
    );
    const reversal = existing
      ? existing.id
      : Number(
          ledger.reverse(
            user,
            header.id,
            { ...ref, date, description: job.description },
            { linked: true, permission: 'finance:close' },
          ).header.id,
        );
    return { reversal, voided: null };
  }
  if (header.status !== 'void') {
    ledger.transition(user, header.id, 'void', ref, { linked: true, permission: 'finance:close' });
    return { reversal: null, voided: Number(header.id) };
  }
  return { reversal: null, voided: null };
}

/**
 * 撤回某个月已执行的计提、成本计算，好按现在的数重做。
 * 已记账凭证不能改不能删：已记账的在同一个月月末红字冲销，还没记账的作废。
 * 原执行记录不删，改名成“kind#序号”留底（明细里记下撤回时间、原因和冲销凭证），
 * 各处按 kind='costing' 这类原名查的都不再认它。月份已结账的要先反结账（openPeriod 会拦）。
 */
export function withdrawJob(store: Store, user: Actor, ledger: JobLedger, withdrawal: Withdrawal) {
  const { period, kind, reason, expectedVoucherId } = withdrawal;
  const db = store.db;
  const job = one(db, rows.fin_period_jobs, 'SELECT * FROM fin_period_jobs WHERE period=? AND kind=?', period, kind);
  if (!job) financeError('这个月还没有' + (jobNames[kind] ?? '执行这一步') + '，不用重做。', 409);
  if (expectedVoucherId !== undefined && job.voucher_id !== expectedVoucherId)
    financeError('这一步已经重做过了，请刷新后再看。', 409);
  ledger.openPeriod(user, endOfMonth(period));
  const previous = count(db, "SELECT count(*) FROM fin_period_jobs WHERE period=? AND kind LIKE ? || '#%'", period, kind);
  const archived = kind + '#' + (previous + 1);
  const { reversal, voided } =
    job.voucher_id == null
      ? { reversal: null, voided: null }
      : undoJobVoucher(store, user, ledger, {
          voucherId: job.voucher_id,
          period,
          archived,
          description: '重做' + (jobNames[kind] ?? kind) + '，冲销原凭证',
        });
  const withdrawn = withdrawnSchema.parse({ at: new Date().toISOString(), reason, reversal, voided });
  db.prepare(
    "UPDATE fin_period_jobs SET kind=?,details=json_set(details,'$.withdrawn',json(?)) WHERE period=? AND kind=?",
  ).run(archived, JSON.stringify(withdrawn), period, kind);
  financeAudit(store, user, {
    action: 'withdraw',
    entity: 'fin_period_jobs',
    id: null,
    before: job,
    after: { period, kind: archived, withdrawn },
  });
  return { job, archived, reversal, voided };
}

/** 凭证分录按科目和辅助项汇总成借减贷的净额，比较重算结果和原凭证用。 */
export function entryNet(entries: { accountCode: string; debit: number; credit: number; auxiliary?: { id: string } | null }[]) {
  const out = new Map<string, number>();
  for (const e of entries) {
    const key = e.accountCode + '|' + (e.auxiliary?.id ?? '');
    out.set(key, (out.get(key) ?? 0) + e.debit - e.credit);
  }
  for (const [key, value] of out) if (!value) out.delete(key);
  return out;
}

/** 执行记录挂的凭证（没有凭证就是空）按科目汇总的净额。 */
export function jobVoucherNet(store: Store, voucherId: number | null) {
  if (voucherId == null) return new Map<string, number>();
  const lines = many(
    store.db,
    rows.fin_entries.pick({ account_code: true, debit: true, credit: true, auxiliary_id: true }),
    'SELECT account_code,debit,credit,auxiliary_id FROM fin_entries WHERE voucher_id=?',
    voucherId,
  );
  return entryNet(
    lines.map((r) => ({
      accountCode: r.account_code,
      debit: r.debit,
      credit: r.credit,
      auxiliary: r.auxiliary_id == null ? null : { id: r.auxiliary_id },
    })),
  );
}

export function sameNet(a: Map<string, number>, b: Map<string, number>) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}
