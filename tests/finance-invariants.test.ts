// 固定种子三个月业务逐月对账：凭证、往来、资金、经营报表和库存对得上，并实测结账（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FinanceAssets } from '../server/finance/assets.js';
import { FinancePayroll } from '../server/finance/payroll.js';
import { entry } from '../server/finance/query.js';
import { orderSchema } from '../shared/core/domain.js';
import { endOfMonth } from '../server/finance/periods.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceAllocations } from '../server/finance/allocations.js';
import { FinanceCashAccounts } from '../server/finance/cash-accounts.js';
import { one, rows } from '../server/core/index.js';
import { invariantsWorld, maker, reviewer, sum } from './finance-invariants-fixture.js';
import { saveDoc } from './receive-fixture.js';

type World = ReturnType<typeof invariantsWorld>;
type Obligation = ReturnType<World['obligation']>;
type MonthReport = ReturnType<World['monthly']['get']>;
/** 一个月随机出的业务量：到货张数、送货只数、售价、进价（元） */
type Figures = { inbound: number; sold: number; price: number; unitCost: number };
/** 跨月累计的期望：应收、应付、银行存款（分），上个月的送货单（这个月收它的尾款），各月结账后的月度台账 */
type Totals = { ar: number; ap: number; cash: number; priorDelivery?: number; closed: MonthReport[] };
/** 这个月实际收付了多少（分）：本月送货的收款、折扣、收上月尾款、付款 */
type Settled = { receive: Obligation; payable: Obligation; receiptAmount: number; discount: number; carryIn: number; payment: number };

const dayOf = (period: string, day: number) => period + '-' + String(day).padStart(2, '0');
/** 每月送货里留到下个月才收的尾款（分） */
const CARRY_FORWARD = 200;

/** 1 日按进价订纸板，2 日全部到货；返回到货单 */
function purchaseArrival(w: World, period: string, f: Figures) {
  const line = { quantity: String(f.inbound), unitPrice: String(f.unitCost), priceBasis: 'quantity' };
  const purchase = w.ops.savePurchase(
    { supplierId: w.supplier.id, orderDate: dayOf(period, 1), status: '已订货', lines: [{ ...w.raw, stockItemId: w.raw.id, ...line }] },
    maker,
  );
  return w.confirm(
    saveDoc(
      w.flow,
      'arrival',
      {
        supplierId: w.supplier.id,
        date: dayOf(period, 2),
        reference: '虚构到货-' + period,
        lines: [{ stockId: w.raw.id, purchaseLineId: purchase.lines[0].id, item: w.raw, ...line }],
      },
      maker,
    ),
  );
}

/** 3 日领料完工 sold+1 只；下 sold+1 只的订单，4 日送 sold 只，另送 1 只再冲销；返回两张送货单 */
function produceAndDeliver(w: World, period: string, f: Figures) {
  w.confirm(
    saveDoc(
      w.flow,
      'production',
      {
        productId: w.product.id,
        finishedStockId: w.finished.id,
        date: dayOf(period, 3),
        goodQuantity: String(f.sold + 1),
        operator: '虚构工人',
        materials: [{ stockId: w.raw.id, issued: String(f.sold + 1) }],
      },
      maker,
    ),
  );
  const order = w.store.saveOrder(
    orderSchema.parse({
      customerId: w.customer.id,
      orderDate: dayOf(period, 1),
      deliveryDate: dayOf(period, 4),
      status: '已确认',
      taxMode: '未税',
      lines: [{ productId: w.product.id, unit: '个', quantity: f.sold + 1, unitPriceCents: f.price * 100, unitPriceExact: String(f.price) }],
    }),
  );
  const deliver = (qty: number) =>
    w.confirm(
      saveDoc(
        w.flow,
        'delivery',
        {
          date: dayOf(period, 4),
          customerId: w.customer.id,
          lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: w.finished.id, quantity: String(qty) }],
        },
        maker,
      ),
    );
  const delivery = deliver(f.sold);
  const reversed = deliver(1);
  w.flow.reverse(reversed.id, { version: reversed.version, acknowledged: true, reason: '虚构物理冲销' }, maker);
  return { delivery, reversed };
}

/**
 * 同步前月度台账按理论金额算、实际为 0；同步后送货单资料待补，补零税率凭据后和到货单一起生成凭证记账；
 * 没同步就撤销了的送货单：财务第一次看到就已失效、没入过账，直接记成已处理，不用再核对红冲。
 */
function bookEvents(w: World, period: string, docs: { receipt: { id: number }; delivery: { id: number }; reversed: { id: number } }, f: Figures) {
  const expectedTheory = f.sold * f.price * 100 - f.inbound * f.unitCost * 100;
  assert.equal(w.monthly.get(maker, { period }).theoreticalProfit, expectedTheory);
  assert.equal(w.monthly.get(maker, { period }).actualProfit, 0);
  assert.deepEqual(w.monthly.trend(maker, { period, months: 3 }).at(-1), w.monthly.get(maker, { period }));
  w.events.sync(maker, w.req());
  const original = w.findEvent(docs.delivery.id);
  assert.equal(original.status, 'info_pending');
  const resolved = new FinanceEventHandling(w.store).resolve(maker, original.id, {
    ...w.req(),
    version: original.version,
    evidence: '虚构零税率凭据',
    lines: [{ exact: String(f.sold * f.price), rate: '0', mode: '未税' }],
  });
  if (!resolved.voucher_id) new FinanceEventVouchers(w.store).generate(maker, original.id, { ...w.req(), version: resolved.version });
  const arrivalEvent = w.findEvent(docs.receipt.id);
  new FinanceEventVouchers(w.store).generate(maker, arrivalEvent.id, { ...w.req(), version: arrivalEvent.version });
  assert.equal(w.findEvent(docs.reversed.id).status, 'corrected');
  w.post();
  return expectedTheory;
}

/** 确认一张收付款（核销到给的往来，rebate 是现金折扣）并记账 */
function cashDoc(w: World, period: string, doc: { kind: 'receipt' | 'payment'; amount: number; day: number; obligation?: Obligation; rebate?: number }) {
  const { kind, amount, day, obligation, rebate = 0 } = doc;
  const saved = w.cash.saveCash(maker, {
    ...w.req(),
    kind,
    accountId: w.bank.id,
    partyId: kind === 'receipt' ? w.customer.id : w.supplier.id,
    date: dayOf(period, day),
    amount,
    method: '银行',
    description: '虚构收付款',
  });
  w.cash.confirm(maker, saved.id, {
    ...w.req(),
    version: saved.version,
    allocations: obligation ? [{ obligationId: obligation.id, version: obligation.version, amount: amount + rebate, discount: rebate }] : [],
  });
  w.post();
  return saved;
}

/**
 * 5 日收本月送货款（留 2 元尾款、给现金折扣）和上月尾款；付一笔 0.75 元后先撤核销才能撤资金单；7 日再付一笔。
 * 返回各项金额。
 */
function settleCash(w: World, period: string, f: Figures, docs: { receipt: { id: number }; delivery: { id: number } }, totals: Totals): Settled {
  const receive = w.obligation(docs.delivery.id),
    payable = w.obligation(docs.receipt.id);
  const discount = (f.sold * f.price - 2) * 2;
  const receiptAmount = Number(receive.amount_cents) - CARRY_FORWARD - discount;
  const payment = 100 + w.random(50);
  cashDoc(w, period, { kind: 'receipt', amount: receiptAmount, day: 5, obligation: receive, rebate: discount });
  const carryIn = totals.priorDelivery === undefined ? 0 : CARRY_FORWARD;
  if (totals.priorDelivery !== undefined) cashDoc(w, period, { kind: 'receipt', amount: carryIn, day: 5, obligation: w.obligation(totals.priorDelivery) });
  totals.priorDelivery = docs.delivery.id;
  const undone = cashDoc(w, period, { kind: 'payment', amount: 75, day: 5, obligation: payable });
  const allocation = one(w.db, rows.fin_allocations.pick({ id: true, version: true }), 'SELECT id,version FROM fin_allocations WHERE cash_id=?', undone.id);
  if (!allocation) throw new Error('测试数据：付款单 ' + undone.id + ' 没有核销');
  assert.throws(() => w.cash.cancel(maker, undone.id, { ...w.req(), version: 2, date: dayOf(period, 6), reason: '先撤核销' }), /先撤销核销/);
  new FinanceAllocations(w.store).revoke(maker, allocation.id, { ...w.req(), version: allocation.version, date: dayOf(period, 6), reason: '虚构撤销核销' });
  w.post();
  w.cash.cancel(maker, undone.id, { ...w.req(), version: 3, date: dayOf(period, 6), reason: '虚构撤销资金单' });
  w.post();
  cashDoc(w, period, { kind: 'payment', amount: payment, day: 7, obligation: w.obligation(docs.receipt.id) });
  return { receive, payable, receiptAmount, discount, carryIn, payment };
}

/** 7 日付 0.8 元保证金、报销一笔费用（8 日付款），8 日记一张手工收入凭证、9 日红冲；返回费用金额 */
function depositExpenseAndReversal(w: World, period: string) {
  w.terms.deposit(maker, {
    ...w.req(),
    kind: 'paid',
    partyKind: 'supplier',
    partyId: w.supplier.id,
    accountId: w.bank.id,
    date: dayOf(period, 7),
    amount: 80,
    description: '虚构保证金',
  });
  const fee = 15 + w.random(25);
  const expense = w.expenses.save(maker, {
    ...w.req(),
    employeeId: 'seed-employee',
    employeeName: '虚构员工',
    department: '虚构部门',
    date: dayOf(period, 7),
    accountCode: '560201',
    amount: fee,
    description: '虚构费用',
  });
  w.expenses.transition(maker, expense.id, { ...w.req(), version: 1, action: 'submit' });
  w.expenses.transition(reviewer, expense.id, { ...w.req(), version: 2, action: 'approve' });
  w.post();
  w.expenses.transition(maker, expense.id, { ...w.req(), version: 3, action: 'pay', date: dayOf(period, 8), accountId: w.bank.id });
  const manual = w.ledger.create(maker, {
    ...w.req(),
    date: dayOf(period, 8),
    description: '虚构先收后冲',
    entries: [entry('1002', 50, 0, null, '收到其他经营活动现金'), entry('5301', 0, 50)],
  });
  w.post();
  const posted = w.ledger.get(maker, manual.header.id);
  w.ledger.reverse(maker, manual.header.id, { ...w.req(), version: posted.header.version, date: dayOf(period, 9), description: '虚构红冲' });
  w.post();
  return fee;
}

/** 月度台账的理论、实际、折扣、保证金和来源月份，各明细合计等于汇总数；报表平衡、现金流量等于银行存款变动、资金账户余额对得上 */
function assertMonthly(w: World, period: string, expected: { theory: number; cashChange: number; cash: number }, money: Settled & { fee: number }) {
  const report = w.monthly.get(maker, { period });
  assert.equal(report.theoreticalProfit, expected.theory);
  assert.equal(report.actualIncome, money.receiptAmount + money.carryIn);
  assert.equal(report.actualExpense, money.payment + money.fee);
  assert.equal(report.discountExpense, money.discount);
  assert.equal(report.depositExpense, 80);
  const receiptSources = report.sources.filter((r) => r.metric === 'actualIncome');
  assert.equal(sum(receiptSources, (r) => r.amount), money.receiptAmount + money.carryIn);
  assert.equal(
    sum(receiptSources.filter((r) => r.source_month !== period), (r) => r.amount),
    money.carryIn,
  );
  for (const metric of ['theoreticalIncome', 'theoreticalExpense', 'actualIncome', 'actualExpense'] as const)
    assert.equal(sum(w.monthly.detail(maker, { period, metric, pageSize: 200 }).rows, (r) => r.amount), report[metric], metric);
  assert.equal(w.reports.get(maker, 'balance', { period }).balanced, true);
  assert.equal(w.reports.get(maker, 'cashflow', { period }).total, expected.cashChange);
  assert.equal(new FinanceCashAccounts(w.store).accounts(maker, { date: endOfMonth(period) }).rows[0].balance, expected.cash);
}

/** 科目余额表等于总账、明细账合计等于发生额、期初加发生等于期末；应收、应付、银行存款和逐笔往来对得上 */
function assertBooks(w: World, period: string, totals: Totals) {
  const balances = w.books.read(maker, 'balance', { period, pageSize: 200 }).rows;
  assert.deepEqual(w.books.read(maker, 'general', { period, pageSize: 200 }).rows, balances);
  const details = w.books.read(maker, 'detail', { period, pageSize: 200 }).rows;
  for (const row of balances) {
    const entries = details.filter((r) => r.account_code === row.account_code);
    assert.equal(sum(entries, (r) => r.debit), row.debit);
    assert.equal(sum(entries, (r) => r.credit), row.credit);
    assert.equal(Number(row.opening) + Number(row.debit) - Number(row.credit), row.ending);
  }
  assert.equal(balances.find((r) => r.account_code === '1122')?.ending, totals.ar);
  assert.equal(balances.find((r) => r.account_code === '2202')?.ending, -totals.ap);
  assert.equal(balances.find((r) => r.account_code === '1002')?.ending, totals.cash);
  for (const [kind, expected] of [
    ['receivable', totals.ar],
    ['payable', totals.ap],
  ] as const)
    assert.equal(sum(w.parties.obligations(maker, { kind, pageSize: 200 }).rows, (r) => r.balance), expected);
}

/**
 * 月末折旧、工资、成本（期末数量等于流水合计、金额不为负）、税费、损益结转都记账，没有借贷不平的凭证，结账检查通过后结账；
 * 结了账的月份不能再记凭证、改预算；最后一个月反结账后又能写。
 */
function closeChecked(w: World, period: string, last: boolean) {
  new FinanceAssets(w.store).depreciate(maker, { ...w.req(), period });
  new FinancePayroll(w.store).confirm(maker, { ...w.req(), period });
  w.costing.run(maker, { ...w.req(), period });
  w.post();
  for (const item of w.costing.list(maker, { period, pageSize: 200 }).rows) {
    const movements = w.db.prepare('SELECT sum(delta_units) AS total FROM stock_movements WHERE item_id=? AND date<=?');
    assert.equal(item.end_qty, movements.get(item.stock_id, endOfMonth(period))?.total);
    assert.ok(Number(item.end_cents) >= 0);
  }
  w.closing.accrueTax(maker, { ...w.req(), period });
  w.post();
  w.closing.settleProfit(maker, { ...w.req(), period });
  w.post();
  const unbalanced = `SELECT v.id FROM fin_vouchers v JOIN fin_entries e ON e.voucher_id=v.id
        WHERE v.status='posted' AND v.period=? GROUP BY v.id HAVING sum(e.debit)<>sum(e.credit)`;
  assert.deepEqual(w.db.prepare(unbalanced).all(period), []);
  const check = w.closing.check(maker, { period });
  assert.ok(check.canClose, JSON.stringify(check.steps));
  w.closing.close(maker, { ...w.req(), period, version: check.record?.version });
  const denied = {
    ...w.req(),
    date: dayOf(period, 20),
    description: '虚构期间写入',
    entries: [entry('1002', 1, 0, null, '收到其他经营活动现金'), entry('5301', 0, 1)],
  };
  const budget = { ...w.req(), period, accountCode: '5301', amount: 100 };
  assert.throws(() => w.ledger.create(maker, denied), /已结账/);
  assert.throws(() => w.reports.budget(maker, budget), /已结账/);
  if (!last) return;
  const reopened = w.closing.reopen(maker, { ...w.req(), period, version: 2, reason: '虚构反结账核验' });
  assert.equal(reopened.status, 'open');
  assert.equal(w.ledger.create(maker, denied).header.status, 'draft');
  assert.equal(w.reports.budget(maker, budget)?.amount_cents, 100);
}

test('固定种子三个月业务的凭证、往来、资金、经营报表和库存逐月对账并实测结账', () => {
  const w = invariantsWorld();
  try {
    const periods = ['2026-01', '2026-02', '2026-03'];
    const totals: Totals = { ar: 0, ap: 0, cash: 100000, closed: [] };
    for (const period of periods) {
      const f: Figures = { inbound: 10 + w.random(7), sold: 2 + w.random(3), price: 20 + w.random(11), unitCost: 3 + w.random(4) };
      const receipt = purchaseArrival(w, period, f);
      const docs = { receipt, ...produceAndDeliver(w, period, f) };
      const theory = bookEvents(w, period, docs, f);
      const money = settleCash(w, period, f, docs, totals);
      const fee = depositExpenseAndReversal(w, period);
      totals.ar += Number(money.receive.amount_cents) - money.receiptAmount - money.discount - money.carryIn;
      totals.ap += Number(money.payable.amount_cents) - money.payment;
      const cashChange = money.receiptAmount + money.carryIn - money.payment - fee - 80;
      totals.cash += cashChange;
      assertMonthly(w, period, { theory, cashChange, cash: totals.cash }, { ...money, fee });
      assertBooks(w, period, totals);
      closeChecked(w, period, period === periods.at(-1));
      totals.closed.push(w.monthly.get(maker, { period }));
    }
    assert.deepEqual(w.monthly.trend(maker, { period: periods[2], months: 3 }), totals.closed);
  } finally {
    w.store.close();
  }
});
