// 对账测试的固定种子：内存库、虚构客户供应商产品、启用财务、资金账户和账期（全部是虚构数据）
import { Store } from '../server/core/db.js';
import { FinanceBooks } from '../server/finance/ledger/books.js';
import { FinanceClosing } from '../server/finance/reports/closing.js';
import { FinanceCosting } from '../server/finance/costing/costing.js';
import { FinanceEvents } from '../server/finance/events/events.js';
import { FinanceExpenses } from '../server/finance/expenses/expenses.js';
import { FinanceLedger } from '../server/finance/ledger/ledger.js';
import { FinanceMonthly } from '../server/finance/reports/monthly.js';
import { FinanceParties } from '../server/finance/parties/parties.js';
import { FinanceReports } from '../server/finance/reports/reports.js';
import { FinanceSettings } from '../server/finance/base/settings.js';
import { FinanceSettlements } from '../server/finance/cash/settlements.js';
import { FinanceDepositsInterest } from '../server/finance/parties/deposits-interest.js';
import { approver, postDrafts, supervisor } from './finance-fixture.js';
import { shipOnDocDate } from './ship-date.js';
import { FinanceCashAccounts } from '../server/finance/cash/cash-accounts.js';
import { one, rows } from '../server/core/index.js';
import { businessBase } from './business-base-fixture.js';

/** 对账测试用进了超级管理员模式的财务账号（冲销单据要用），审核用基础 fixture 的审核员 */
export const maker = supervisor;
export const reviewer = approver;
export const sum = <T>(rows: T[], get: (row: T) => unknown) =>
  rows.reduce((n, r) => n + Number(get(r)), 0);


/** 搭好对账测试的底子：服务、可重复的随机数和请求号、记账等小工具，加上主数据和财务启用 */
export function invariantsWorld() {
  const store = new Store(':memory:');
  const db = store.db;
  let seed = 0x20261106,
    serial = 0;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const req = () => ({
    requestId: '20261106-0000-4000-8000-' + String(++serial).padStart(12, '0'),
  });
  const base = businessBase(maker, store),
    services = invariantServices(base);
  const post = () => postDrafts(store);
  // 请求号按序号起（可重复），不用随机的
  const confirm = (doc: { id: number }) => base.check(doc, { ...req(), ...shipOnDocDate(services.flow, doc.id) });
  return { store, db, random, req, post, confirm, ...eventReads(store), ...services, ...seedWorld(base, services, req) };
}

/** 对账测试要用的各个服务 */
function invariantServices({ store, ops, flow }: ReturnType<typeof businessBase>) {
  return {
    finance: new FinanceSettings(store),
    ledger: new FinanceLedger(store),
    books: new FinanceBooks(store),
    cash: new FinanceSettlements(store),
    reports: new FinanceReports(store),
    monthly: new FinanceMonthly(store),
    events: new FinanceEvents(store),
    parties: new FinanceParties(store),
    closing: new FinanceClosing(store),
    costing: new FinanceCosting(store),
    expenses: new FinanceExpenses(store),
    terms: new FinanceDepositsInterest(store),
    ops,
    flow,
  };
}

/** findEvent(单据) 读到货、送货单的财务事件；obligation(单据) 读它名下的正数往来；读不到让测试失败 */
function eventReads(store: Store) {
  const findEvent = (id: number) => {
    const e = one(
      store.db,
      rows.fin_events,
      `SELECT e.* FROM fin_source_observations x
    JOIN fin_events e ON e.id=x.event_id WHERE x.source_id=? AND x.source_kind IN ('arrival','delivery')`,
      String(id),
    );
    if (!e) throw new Error('测试数据：单据 ' + id + ' 没有财务事件');
    return e;
  };
  const obligation = (id: number) => {
    const o = one(store.db, rows.fin_obligations, 'SELECT * FROM fin_obligations WHERE event_id=? AND amount_cents>0', findEvent(id).id);
    if (!o) throw new Error('测试数据：单据 ' + id + ' 的财务事件没有正数往来');
    return o;
  };
  return { findEvent, obligation };
}

/** 主数据（客户、供应商、产品、纸板、成品）、启用财务（2026-01，期初银行存款 1000 元）、银行账户、双方账期 */
function seedWorld(base: ReturnType<typeof businessBase>, s: ReturnType<typeof invariantServices>, req: () => { requestId: string }) {
  const { store } = base;
  const customer = base.customer({ name: '虚构对账客户' });
  const supplier = base.supplier({ name: '虚构对账供应商' });
  const product = base.product({ name: '虚构对账纸箱' });
  const raw = base.raw({ length: 1000, width: 800, dimensionUnit: 'mm' });
  const finished = base.finished(product, { name: product.name, unit: '个' });
  s.finance.enable(maker, {
    ...req(),
    version: 1,
    taxpayer: 'general',
    period: '2026-01',
    rows: [
      { accountCode: '1002', debit: 100000, credit: 0, yearDebit: 0, yearCredit: 0 },
      { accountCode: '3001', debit: 0, credit: 100000, yearDebit: 0, yearCredit: 0 },
    ],
  });
  s.finance.update(maker, { ...req(), version: 2, taxRates: { smallVat: null, urban: 0, education: 0, localEducation: 0, income: 0 } });
  const bank = new FinanceCashAccounts(store).saveAccount(maker, { ...req(), name: '虚构银行', kind: 'bank', accountCode: '1002' });
  s.parties.saveTerms(maker, { ...req(), kind: 'supplier', partyId: supplier.id, termDays: 15, taxRate: '0', taxMode: '未税' });
  s.parties.saveTerms(maker, {
    ...req(),
    kind: 'customer',
    partyId: customer.id,
    termDays: 15,
    options: { discounts: [{ type: 'days', days: 10, rate: '2' }] },
  });
  return { customer, supplier, product, raw, finished, bank };
}
