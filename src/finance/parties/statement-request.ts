import type { FinRequest } from '../fin-api';
import type { Kind } from './shared';

/** 对账单的条件：哪种往来、哪个单位、从哪天到哪天（日期框清空时是空串） */
export type StatementFilter = { kind: Kind; partyId: string; from: string; to: string };

/**
 * 读对账单的请求：没选单位不读。日期框清空时不带这一项（call() 只丢 undefined，空串会发成 from=），
 * 服务端照常报“请填写明确日期”；和导出对账单（exportHref 丢空值）发的条件一样。
 */
export function statementRequest(f: StatementFilter): FinRequest<'GET /finance/statements'> | null {
  if (!f.partyId) return null;
  return [
    'GET /finance/statements',
    { query: { kind: f.kind, partyId: f.partyId, from: f.from || undefined, to: f.to || undefined } },
  ];
}
