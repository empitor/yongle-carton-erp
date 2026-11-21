// 虚构制造业全链路：计价、费用、工资、折旧、三张报表、按顺序结账（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { one, rows } from '../server/core/index.js';
import { businessBase } from './business-base-fixture.js';
import { businessChanges } from './business-changes-fixture.js';
import { FinanceParties } from '../server/finance/parties.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceReports } from '../server/finance/reports.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { FinanceInvoices } from '../server/finance/invoices.js';
import { FinanceExpenses } from '../server/finance/expenses.js';
import { FinanceAssets } from '../server/finance/assets.js';
import { FinancePayroll } from '../server/finance/payroll.js';
import { FinanceCosting } from '../server/finance/costing.js';
import type { FinanceSettlements } from '../server/finance/settlements.js';
import { shipOnDocDate } from './ship-date.js';
import { FinanceMargin } from '../server/finance/margin.js';
import { funds, bill as invoiceInput, maker, approver, newSettings, postDrafts, event, obligation, monthEndJobs, closeMonth } from './finance-fixture.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceInvoiceConfirm } from '../server/finance/invoice-confirm.js';
import { saveDoc } from './receive-fixture.js';
import { grant } from './actor-fixture.js';

/** 1 月 5 日买一台 120 元的虚构设备（12 个月、无残值），银行付款 */
const addAsset = (assets: FinanceAssets) =>
  assets.add(maker, {
    requestId: 'asset',
    number: 'FICT-ASSET',
    name: '虚构设备',
    category: '设备',
    original: 12000,
    date: '2026-01-05',
    months: 12,
    residualBp: 0,
    department: '虚构部门',
    expenseAccount: '560205',
    counterAccount: '1002',
    cashFlow: '购建固定资产支付的现金',
  });

/** 业务底子：虚构纸箱产品、原材料纸板（1000×800mm）和成品纸箱；下单（每个 30 元、未税 0）、确认单据（按单据日送货）、送货 */
function business(s: Store) {
  const base = businessBase(maker, s),
    { ops, flow } = base;
  const product = base.product({ name: '虚构纸箱' });
  const raw = base.raw({ name: '虚构纸板', length: 1000, width: 800, dimensionUnit: 'mm' });
  const finished = base.finished(product, { name: '虚构纸箱', unit: '个' });
  const addOrder = (orderDate: string, deliveryDate: string, quantity: number) =>
    base.order(
      { id: 1 },
      [base.line(product, quantity, { productName: product.name, unit: '个', unitPriceCents: 3000, unitPriceExact: '30.0000' })],
      { orderDate, deliveryDate, taxRate: '0', taxMode: '未税' },
    );
  const confirm = (doc: { id: number }) => base.check(doc, shipOnDocDate(flow, doc.id));
  const deliver = (order: ReturnType<typeof addOrder>, date: string, quantity: string) =>
    confirm(
      saveDoc(
        flow,
        'delivery',
        { date, customerId: 1, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: finished.id, quantity }] },
        maker,
      ),
    );
  return { ops, flow, product, raw, finished, addOrder, confirm, deliver };
}
type Business = ReturnType<typeof business>;

/** 2 月的单据：下 2 个的订单、订 10 张纸板（每张 10 元，供应商未税 0），2-05 到货、2-10 领 5 张完工 5 个、2-15 送 2 个 */
function februaryDocuments(s: Store, b: Business) {
  const sale = b.addOrder('2026-02-01', '2026-02-15', 2);
  const purchase = b.ops.savePurchase(
    {
      supplierId: 1,
      orderDate: '2026-02-01',
      status: '已订货',
      lines: [{ ...b.raw, stockItemId: b.raw.id, quantity: '10', unitPrice: '10.0000', priceBasis: 'quantity' }],
    },
    maker,
  );
  new FinanceParties(s).saveTerms(maker, { kind: 'supplier', partyId: 1, termDays: 0, taxRate: '0', taxMode: '未税', requestId: 'supplier-tax' });
  const arrivalLine = { stockId: b.raw.id, purchaseLineId: purchase.lines[0].id, item: b.raw, quantity: '10', unitPrice: '10.0000', priceBasis: 'quantity' };
  const received = b.confirm(
    saveDoc(b.flow, 'arrival', { supplierId: 1, date: '2026-02-05', reference: '虚构到货', lines: [arrivalLine] }, maker),
  );
  b.confirm(
    saveDoc(
      b.flow,
      'production',
      {
        date: '2026-02-10',
        productId: b.product.id,
        finishedStockId: b.finished.id,
        goodQuantity: '5',
        operator: '虚构操作员',
        materials: [{ stockId: b.raw.id, issued: '5' }],
      },
      maker,
    ),
  );
  const delivered = b.deliver(sale, '2026-02-15', '2');
  return { received, delivered };
}

/** 到货、送货入账记账；采购票 100 元、销售票 60 元关联确认记账；2-16 收齐 60 元、2-17 付清 100 元 */
function februaryBooks(s: Store, cash: FinanceSettlements, docs: { received: { id: number }; delivered: { id: number } }) {
  const { received, delivered } = docs;
  new FinanceEvents(s).sync(maker);
  for (const id of [received.id, delivered.id])
    new FinanceEventVouchers(s).generate(maker, event(s, id).id, { version: 1, requestId: 'event-' + id });
  postDrafts(s);
  const invoices = new FinanceInvoices(s);
  const bill = invoices.create(maker, invoiceInput('purchase', 'PURCHASE', { date: '2026-02-15' }));
  invoices.link(maker, bill.id, { version: 1, requestId: 'link-purchase', links: [{ obligationId: obligation(s, received.id).id, amount: 10000 }] });
  new FinanceInvoiceConfirm(s).confirm(maker, bill.id, { version: 2, requestId: 'confirm-purchase' });
  const salesBill = invoices.create(maker, {
    ...invoiceInput('purchase', 'SALE', { date: '2026-02-15' }),
    direction: 'sale',
    net: 6000,
    gross: 6000,
  });
  invoices.link(maker, salesBill.id, { version: 1, requestId: 'link-sale', links: [{ obligationId: obligation(s, delivered.id).id, amount: 6000 }] });
  new FinanceInvoiceConfirm(s).confirm(maker, salesBill.id, { version: 2, requestId: 'confirm-sale' });
  postDrafts(s);
  const ar = obligation(s, delivered.id),
    ap = obligation(s, received.id);
  funds(s, cash, { kind: 'receipt', date: '2026-02-16', amount: 6000 }, [{ obligationId: ar.id, version: ar.version, amount: 6000 }]);
  funds(s, cash, { kind: 'payment', date: '2026-02-17', amount: 10000 }, [{ obligationId: ap.id, version: ap.version, amount: 10000 }]);
}

/** 2-20 报销 4 元办公费（审核记账、2-21 付款记账），2 月工资表一人应发 3 元 */
function februaryExpenseAndWages(s: Store, payroll: FinancePayroll) {
  const expenses = new FinanceExpenses(s);
  const ex = expenses.save(maker, {
    requestId: 'expense',
    employeeId: 'e-1',
    employeeName: '虚构员工',
    department: '虚构部门',
    date: '2026-02-20',
    accountCode: '560201',
    amount: 400,
    description: '虚构办公费',
  });
  expenses.transition(maker, ex.id, { action: 'submit', version: 1, requestId: 'expense-submit' });
  expenses.transition(approver, ex.id, { action: 'approve', version: 2, requestId: 'expense-approve' });
  postDrafts(s);
  expenses.transition(maker, ex.id, { action: 'pay', version: 3, date: '2026-02-21', accountId: 1, requestId: 'expense-pay' });
  postDrafts(s);
  const wages = { employeeId: 'e-1', employeeName: '虚构员工', department: '虚构部门', accountCode: '560204', gross: 300, social: 0, housing: 0 };
  payroll.save(maker, {
    period: '2026-02',
    requestId: 'wages',
    rows: [{ ...wages, tax: 0, net: 300, employerSocial: 0, employerHousing: 0 }],
  });
}

/**
 * 库存品的单位只跟着类别走（原材料张、成品只，数据库约束）：直接改单位被拦；算过成本以后类别被改了、单位跟着变，成本要报单位对不上。
 * 成品一定关联产品、不存原材料查重键（数据库约束）：改成成品时一起挂到一个没有成品库存的产品上，改回来再还原。
 */
function assertUnitFollowsKind(s: Store, raw: { id: number }, cost: FinanceCosting) {
  const changes = businessChanges(s, maker);
  assert.throws(() => changes.stockItem(raw.id, { unit: '卷' }), /CHECK constraint failed/);
  const before = one(s.db, rows.stock_items.pick({ raw_key: true }), 'SELECT raw_key FROM stock_items WHERE id=?', raw.id);
  if (!before) throw new Error('测试数据：没有库存品 ' + raw.id);
  const spare = businessBase(maker, s).product({ name: '虚构改类别用的产品' });
  changes.stockItem(raw.id, { kind: 'finished', unit: '只', product_id: spare.id, raw_key: null });
  assert.throws(() => cost.run(maker, { period: '2026-02', requestId: 'wrong-unit' }), /单位/);
  changes.stockItem(raw.id, { kind: 'raw', unit: '张', product_id: null, raw_key: before.raw_key });
}

test('虚构制造业全链路的计价、费用、工资、折旧和三张报表可手算，按顺序结账', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s, '2026-01', 100000),
      assets = new FinanceAssets(s),
      payroll = new FinancePayroll(s),
      cost = new FinanceCosting(s),
      closing = new FinanceClosing(s),
      reports = new FinanceReports(s);
    const asset = addAsset(assets);
    assert.ok(asset.id);
    postDrafts(s);
    monthEndJobs(s, '2026-01');
    assert.equal(assets.depreciation(maker, { period: '2026-01' }).filteredRecords, 0);
    closeMonth(s, '2026-01');
    const b = business(s);
    februaryBooks(s, cash, februaryDocuments(s, b));
    februaryExpenseAndWages(s, payroll);
    const finance = { ...maker, role: undefined, permissions: grant('finance:view', 'finance:edit') };
    assert.throws(() => payroll.list(finance, { period: '2026-02', detail: '1' }), /权限/);
    assert.equal(payroll.list(finance, { period: '2026-02' }).rows[0].gross, 300);
    assertUnitFollowsKind(s, b.raw, cost);
    monthEndJobs(s, '2026-02');
    payroll.pay(maker, { period: '2026-02', date: '2026-02-28', accountId: 1, requestId: 'wages-pay' });
    postDrafts(s);
    assert.equal(assets.depreciation(maker, { period: '2026-02' }).rows[0].amount_cents, 1000);
    assert.equal(
      cost.list(maker, { period: '2026-02' }).rows.reduce((n, r) => n + Number(r.end_cents), 0),
      8000,
    );
    assert.equal(reports.get(maker, 'profit', { period: '2026-02' }).netProfit, 2300);
    assert.equal(reports.get(maker, 'cashflow', { period: '2026-02' }).total, -4700);
    assert.equal(reports.get(maker, 'cashflow', { period: '2026-02' }).ending, 83300);
    reports.budget(maker, { period: '2026-02', accountCode: '560201', amount: 500, requestId: 'budget' });
    assert.equal(reports.budgets(maker, { period: '2026-02' }).rows[0].difference, -100);
    closeMonth(s, '2026-02');
    assert.equal(reports.get(maker, 'balance', { period: '2026-02' }).balanced, true);
    assert.equal(reports.get(maker, 'profit', { period: '2026-02' }).netProfit, 2300);
    b.deliver(b.addOrder('2026-03-01', '2026-03-01', 1), '2026-03-01', '1');
    new FinanceEvents(s).sync(maker);
    const estimate = new FinanceMargin(s).get(maker, { period: '2026-03', group: 'order' }).rows[0];
    assert.equal(estimate.cost, 1000);
    assert.equal(estimate.margin, 2000);
    assert.throws(
      () => closing.reopen(maker, { period: '2026-01', version: 2, reason: '核验', requestId: 'wrong-reopen' }),
      /最近/,
    );
    assert.equal(
      closing.reopen(maker, { period: '2026-02', version: 2, reason: '虚构核验', requestId: 'reopen' }).status,
      'open',
    );
    assert.ok(s.db.prepare("SELECT id FROM business_audit WHERE entity='fin_periods' AND action='reopen'").get());
  } finally {
    s.close();
  }
});
