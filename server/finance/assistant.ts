import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { today } from '../../shared/core/index.js';
import { financeReadQuery, financeReadTools } from '../../shared/finance/index.js';
import { catchUp, type SkipLog } from './events/catch-up.js';
import { financeActor, financeError } from './base/core.js';
import { FinanceOverview } from './reports/overview.js';
import { FinanceMonthly } from './reports/monthly.js';
import { FinanceBooks } from './ledger/books.js';
import { FinanceReports } from './reports/reports.js';
import { FinanceParties } from './parties/parties.js';
import { FinanceInvoices } from './cash/invoices.js';
import { FinanceCashAccounts } from './cash/cash-accounts.js';
import { centsText } from '../../shared/core/index.js';
import { FinanceDue } from './parties/due.js';
import { periodOf } from './base/days.js';

/**
 * 读工具返回里单位是“分”的字段，按字段名逐个列出，不再按名字里的片段猜：
 * 以前按片段猜，year_debit、yearProfit 被“year”排除，discountIncome 被“count”排除，
 * ending、ytd、difference 又没列进去，模型拿到的还是分。
 * 列名以 _cents 结尾的本身就是分。工具新返回了金额字段，要加到这里（tests/finance-money.test.ts 会查）。
 */
export const financeMoneyFields = new Set([
  // 往来、资金、发票
  'amount',
  'balance',
  'allocated',
  'invoiced',
  'paid',
  'linked',
  'settled',
  'outstanding',
  'due',
  'held',
  'no_terms',
  // 按单位合计里开票确认收入、还没开票的部分（往来有、总账应收没有）
  'uninvoiced',
  'over_limit',
  'credit_limit',
  'creditLimit',
  'estimate_remaining',
  'remaining',
  'remainingAmount',
  'net',
  // 按单位汇总里还没抵货款的预收（预付）
  'advance',
  'tax',
  'gross',
  // 月度台账
  'theoreticalIncome',
  'theoreticalExpense',
  'theoreticalProfit',
  'actualIncome',
  'actualExpense',
  'actualProfit',
  'discountIncome',
  'discountExpense',
  'interestIncome',
  'interestExpense',
  'depositIncome',
  'depositExpense',
  'ordered',
  // 账簿和报表
  'opening',
  'debit',
  'credit',
  'ending',
  'year_debit',
  'year_credit',
  'ytd',
  'total',
  'netProfit',
  'yearProfit',
  'totalAssets',
  'totalLiabilities',
  'totalEquity',
  'difference',
]);
const isMoneyField = (key: string) => financeMoneyFields.has(key) || /_cents$/.test(key);
/** 给模型看的元：两位小数、不带千分位 */
const yuanText = (cents: number) => centsText(cents).replaceAll(',', '');
/** 财务内部金额的单位是分，模型会当成元。给模型之前统一换成“元”的文字。 */
export function financeAmountsInYuan(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(financeAmountsInYuan);
  if (!value || typeof value !== 'object') return value;
  return fieldsInYuan(value);
}
/** 一个对象的各字段：金额字段换成元的文字，别的往里逐层换 */
function fieldsInYuan(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      typeof v === 'number' && Number.isInteger(v) && isMoneyField(key)
        ? yuanText(v)
        : financeAmountsInYuan(v),
    ]),
  );
}

/**
 * 助手查财务：和财务页面的请求一样，读之前先把还没记进财务的业务单据补扫进来（catch-up.ts，系统按固定规则做，
 * 写什么助手决定不了），读不出来的单据记进出错记录 problems。
 */
export function readFinanceTool(
  store: Store,
  actor: Actor | null | undefined,
  name: string,
  raw: unknown,
  problems: SkipLog,
) {
  return { 金额单位: '元', ...fieldsInYuan(readFinanceRaw(store, actor, { name, raw, problems })) };
}
function readFinanceRaw(
  store: Store,
  actor: Actor | null | undefined,
  { name, raw, problems }: { name: string; raw: unknown; problems: SkipLog },
) {
  const user = financeActor(actor);
  const q = financeReadQuery.parse(raw),
    { limit: pageSize } = q;
  const period = q.period ?? periodOf(today());
  const paging = { page: q.page ?? 1, pageSize };
  const tool = financeReadTools.find((known) => known === name);
  if (!tool) financeError('未知财务查询。', 404);
  catchUp(store, user, problems);
  switch (tool) {
    case 'finance.summary': {
      const data = new FinanceOverview(store).summary(user, { date: q.date });
      return { ...data, accounts: data.accounts.slice(0, pageSize) };
    }
    case 'finance.monthly':
      // 模型有时传 date 不传 period。不能忽略它退回本月，否则问上月会拿到本月的数。
      return new FinanceMonthly(store).get(user, {
        period: q.period ?? periodOf(q.date ?? today()),
      });
    case 'finance.receivables':
    case 'finance.payables': {
      const kind = name === 'finance.receivables' ? 'receivable' : 'payable';
      // 逐笔之外带上按单位汇总，和页面“按单位”、对账单期末同一个算法（partyBalances）：
      // 还欠（net）已扣掉还没抵货款的预收（预付，advance），问“还欠多少”按它答，不把逐笔 balance 加起来
      const held = new FinanceDue(store).held(user, {
        kind,
        date: q.date,
        partyId: q.partyId,
        page: 1,
        pageSize,
      });
      return {
        ...new FinanceParties(store).obligations(user, { ...paging, partyId: q.partyId, kind }),
        byParty: {
          date: q.date ?? today(),
          rows: held.rows.map((r) => ({
            party_id: r.party_id,
            party_name: r.party_name,
            held: r.held,
            due: r.due,
            no_terms: r.no_terms,
            earliest_due: r.earliest_due,
            advance: r.advance,
            uninvoiced: r.uninvoiced,
            net: r.net,
            credit_limit: r.credit_limit,
            over_limit: r.over_limit,
          })),
          totals: held.totals,
          filteredRecords: held.filteredRecords,
        },
      };
    }
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
      return new FinanceCashAccounts(store).accounts(user, { ...paging, date: q.date });
  }
}
