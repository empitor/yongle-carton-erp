import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { today } from '../../shared/domain.js';
import { financeReadQuery, financeReadTools } from '../../shared/finance-tools.js';
import { financeActor, financeError } from './core.js';
import { FinanceOverview } from './overview.js';
import { FinanceMonthly } from './monthly.js';
import { FinanceBooks } from './books.js';
import { FinanceReports } from './reports.js';
import { FinanceParties } from './parties.js';
import { FinanceInvoices } from './invoices.js';
import { FinanceSettlements } from './settlements.js';

const notMoney = /count|rate|days|page|version|month|year|quantity|records|missing|size|^limit$|offset|index/i;
// 编号字段区分大小写：paid 不是编号，party_id、voucherId 才是。
const idKey = /^id$|_id$|[a-z]Id$|Ids?$/;
const moneyKey = /amount|balance|income|expense|ordered|profit|total|paid|due|principal|debit|credit|received|remaining|outstanding|open|gross|net|tax|interest|deposit|discount|settled|allocated|limit|linked|invoiced|cents|estimate/i;
const yuanText = (cents: number) => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return sign + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
};
/** 财务内部金额的单位是分，模型会当成元。给模型之前统一换成“元”的文字。 */
export function financeAmountsInYuan(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(financeAmountsInYuan);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      typeof v === 'number' && Number.isInteger(v) && moneyKey.test(key) && !notMoney.test(key) && !idKey.test(key)
        ? yuanText(v)
        : financeAmountsInYuan(v),
    ]),
  );
}

export function readFinanceTool(
  store: Store,
  actor: Actor | null | undefined,
  name: string,
  raw: unknown,
) {
  return { 金额单位: '元', ...(financeAmountsInYuan(readFinanceRaw(store, actor, name, raw)) as object) };
}
function readFinanceRaw(
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
    case 'finance.monthly':
      // 模型有时传 date 不传 period。不能忽略它退回本月，否则问上月会拿到本月的数。
      return new FinanceMonthly(store).get(user, {
        period: q.period ?? q.date?.slice(0, 7) ?? today().slice(0, 7),
      });
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
