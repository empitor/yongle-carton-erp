import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { financeAudit, financeError } from './core.js';

export function periodJob(
  store: Store,
  user: Actor,
  period: string,
  kind: string,
  voucher: number | null,
  details: unknown,
) {
  if (store.db.prepare('SELECT 1 FROM fin_period_jobs WHERE period=? AND kind=?').get(period, kind))
    financeError('该期间已执行此步骤。', 409);
  store.db
    .prepare('INSERT INTO fin_period_jobs(period,kind,voucher_id,details) VALUES(?,?,?,?)')
    .run(period, kind, voucher, JSON.stringify(details));
  const result = { period, kind, voucherId: voucher, details };
  financeAudit(store, user, 'run', 'fin_period_jobs', null, null, result);
  return result;
}
