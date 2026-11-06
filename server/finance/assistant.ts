import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { today } from '../../shared/domain.js';
import { financeReadQuery, financeReadTools } from '../../shared/finance-tools.js';
import { financeActor, financeError } from './core.js';
import { FinanceOverview } from './overview.js';
import { FinanceBooks } from './books.js';
import { FinanceReports } from './reports.js';
import { FinanceParties } from './parties.js';
import { FinanceInvoices } from './invoices.js';
import { FinanceSettlements } from './settlements.js';

export function readFinanceTool(
  store: Store,
  actor: Actor | null | undefined,
  name: string,
  raw: unknown,
) {
  const user = financeActor(actor);
  const q = financeReadQuery.parse(raw),
    { limit: pageSize } = q;
  const period = q.period ?? today().slice(0, 7);
  const paging = { page: q.page ?? 1, pageSize };
  switch (name as (typeof financeReadTools)[number]) {
    case 'finance.summary': {
      const data = new FinanceOverview(store).summary(user, { date: q.date });
      return { ...data, accounts: data.accounts.slice(0, pageSize) };
    }
    case 'finance.receivables':
    case 'finance.payables':
      return new FinanceParties(store).obligations(user, {
        ...paging,
        partyId: q.partyId,
        kind: name === 'finance.receivables' ? 'receivable' : 'payable',
      });
    case 'finance.ledger':
      return new FinanceBooks(store).read(user, 'detail', {
        ...paging,
        period,
        account: q.account,
      });
    case 'finance.reports': {
      const result = new FinanceReports(store).get(user, q.kind ?? 'trial', { period });
      return Object.fromEntries(
        Object.entries(result).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.slice(0, pageSize) : value,
        ]),
      );
    }
    case 'finance.invoices':
      return new FinanceInvoices(store).list(user, { ...paging, period });
    case 'finance.cash':
      return new FinanceSettlements(store).accounts(user, { ...paging, date: q.date });
    default:
      financeError('未知财务查询。', 404);
  }
}
