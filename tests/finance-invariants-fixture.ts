// 对账测试的固定种子：内存库、虚构客户供应商产品、启用财务、资金账户和账期（全部是虚构数据）
import { Store } from '../server/core/db.js';
import { FlowService } from '../server/flow/service.js';
import { OperationsService } from '../server/operations/service.js';
import { FinanceBooks } from '../server/finance/books.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { FinanceCosting } from '../server/finance/costing.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceExpenses } from '../server/finance/expenses.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinanceMonthly } from '../server/finance/monthly.js';
import { FinanceParties } from '../server/finance/parties.js';
import { FinanceReports } from '../server/finance/reports.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceSettlements } from '../server/finance/settlements.js';
import { FinanceDepositsInterest } from '../server/finance/deposits-interest.js';
import { customerSchema, productSchema } from '../shared/core/domain.js';
import { approver, postDrafts, supervisor } from './finance-fixture.js';
import { shipOnDocDate } from './ship-date.js';
import { FinanceCashAccounts } from '../server/finance/cash-accounts.js';
import { one, rows } from '../server/core/index.js';

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
  const services = invariantServices(store);
  const post = () => postDrafts(store);
  const confirm = (doc: { id: number }) =>
    services.flow.confirm(
      doc.id,
      {
        ...req(),
        previewDigest: services.flow.preview(doc.id, maker).previewDigest,
        acknowledged: true,
        ...shipOnDocDate(services.flow, doc.id),
      },
      maker,
    );
  return { store, db, random, req, post, confirm, ...eventReads(store), ...services, ...seedWorld(store, services, req) };
}

/** 对账测试要用的各个服务 */
function invariantServices(store: Store) {
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
    ops: new OperationsService(store),
    flow: new FlowService(store),
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
function seedWorld(store: Store, s: ReturnType<typeof invariantServices>, req: () => { requestId: string }) {
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构对账客户' }));
  const supplier = s.ops.saveSupplier({ name: '虚构对账供应商' }, maker);
  const product = store.saveProduct(productSchema.parse({ name: '虚构对账纸箱' }));
  const raw = s.ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' }, maker);
  const finished = s.ops.saveItem({ name: product.name, kind: 'finished', unit: '个', productId: product.id }, maker);
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
