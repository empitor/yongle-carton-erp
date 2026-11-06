import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/db.js';
import { FlowService } from '../server/flow/service.js';
import { OperationsService } from '../server/operations/service.js';
import { FinanceAssets } from '../server/finance/assets.js';
import { FinanceBooks } from '../server/finance/books.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { FinanceCosting } from '../server/finance/costing.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceExpenses } from '../server/finance/expenses.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinanceMonthly } from '../server/finance/monthly.js';
import { FinanceParties } from '../server/finance/parties.js';
import { FinancePayroll } from '../server/finance/payroll.js';
import { endOfMonth, entry } from '../server/finance/query.js';
import { FinanceReports } from '../server/finance/reports.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceSettlements } from '../server/finance/settlements.js';
import { FinanceTermOperations } from '../server/finance/terms-finance.js';
import { customerSchema, orderSchema, productSchema } from '../shared/domain.js';
import { financePermissions } from '../shared/finance.js';

const maker = {
  id: 'seed-maker',
  name: '虚构财务',
  role: 'super_admin' as const,
  superAdminMode: true,
  superAdminUntil: Date.now() + 600_000,
  permissions: [...financePermissions, 'business:edit'],
};
const reviewer = { ...maker, id: 'seed-reviewer' };
const sum = <T>(rows: T[], get: (row: T) => unknown) =>
  rows.reduce((n, r) => n + Number(get(r)), 0);

test('固定种子三个月业务的凭证、往来、资金、经营报表和库存逐月对账并实测结账', () => {
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
  const finance = new FinanceSettings(store),
    ledger = new FinanceLedger(store),
    books = new FinanceBooks(store),
    cash = new FinanceSettlements(store),
    reports = new FinanceReports(store),
    monthly = new FinanceMonthly(store),
    events = new FinanceEvents(store),
    parties = new FinanceParties(store),
    closing = new FinanceClosing(store),
    costing = new FinanceCosting(store),
    expenses = new FinanceExpenses(store),
    terms = new FinanceTermOperations(store),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  const post = () => {
    for (const { id } of db
      .prepare("SELECT id FROM fin_vouchers WHERE status='draft' ORDER BY id")
      .all()) {
      const approver = ledger.get(maker, id).header.maker_id === reviewer.id ? maker : reviewer;
      ledger.transition(maker, id, 'submit', { ...req(), version: 1 });
      ledger.transition(approver, id, 'approve', { ...req(), version: 2 });
      ledger.transition(approver, id, 'post', { ...req(), version: 3 });
    }
  };
  const confirm = (doc: { id: number }) =>
    flow.confirm(
      doc.id,
      {
        ...req(),
        previewId: flow.preview(doc.id, maker, 'seed').previewId,
        acknowledged: true,
      },
      maker,
      'seed',
    );
  const findEvent = (id: number) =>
    db
      .prepare(
        `SELECT e.* FROM fin_source_observations x
    JOIN fin_events e ON e.id=x.event_id WHERE x.source_id=? AND x.source_kind IN ('arrival','delivery')`,
      )
      .get(String(id))!;
  const obligation = (id: number) =>
    db
      .prepare('SELECT * FROM fin_obligations WHERE event_id=? AND amount_cents>0')
      .get(findEvent(id).id)!;

  try {
    const customer = store.saveCustomer(customerSchema.parse({ name: '虚构对账客户' }));
    const supplier = ops.saveSupplier({ name: '虚构对账供应商' }, maker);
    const product = store.saveProduct(productSchema.parse({ name: '虚构对账纸箱' }));
    const raw = ops.saveItem(
      { name: '虚构纸板', kind: 'raw', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' },
      maker,
    );
    const finished = ops.saveItem(
      { name: product.name, kind: 'finished', unit: '个', productId: product.id },
      maker,
    );
    finance.enable(maker, {
      ...req(),
      version: 1,
      taxpayer: 'general',
      period: '2026-01',
      rows: [
        { accountCode: '1002', debit: 100000, credit: 0, yearDebit: 0, yearCredit: 0 },
        { accountCode: '3001', debit: 0, credit: 100000, yearDebit: 0, yearCredit: 0 },
      ],
    });
    finance.update(maker, {
      ...req(),
      version: 2,
      taxRates: { smallVat: null, urban: 0, education: 0, localEducation: 0, income: 0 },
    });
    const bank = cash.saveAccount(maker, {
      ...req(),
      name: '虚构银行',
      kind: 'bank',
      accountCode: '1002',
    });
    parties.saveTerms(maker, {
      ...req(),
      kind: 'supplier',
      partyId: supplier.id,
      termDays: 15,
      taxRate: '0',
      taxMode: '未税',
    });
    parties.saveTerms(maker, {
      ...req(),
      kind: 'customer',
      partyId: customer.id,
      termDays: 15,
      options: { discounts: [{ type: 'days', days: 10, rate: '2' }] },
    });
    const periods = ['2026-01', '2026-02', '2026-03'];
    let expectedAr = 0,
      expectedAp = 0,
      expectedCash = 100000;
    let priorDelivery: number | undefined;
    const closedReports = [];
    for (const period of periods) {
      const date = (day: number) => period + '-' + String(day).padStart(2, '0');
      const inbound = 10 + random(7),
        sold = 2 + random(3),
        price = 20 + random(11),
        unitCost = 3 + random(4);
      const purchase = ops.savePurchase(
        {
          supplierId: supplier.id,
          orderDate: date(1),
          status: '已订货',
          lines: [
            {
              ...raw,
              stockItemId: raw.id,
              quantity: String(inbound),
              unitPrice: String(unitCost),
              priceBasis: 'quantity',
            },
          ],
        },
        maker,
      );
      const receipt = confirm(
        flow.save(
          'arrival',
          {
            supplierId: supplier.id,
            date: date(2),
            reference: '虚构到货-' + period,
            lines: [
              {
                stockId: raw.id,
                purchaseLineId: purchase.lines[0].id,
                item: raw,
                quantity: String(inbound),
                unitPrice: String(unitCost),
                priceBasis: 'quantity',
              },
            ],
          },
          maker,
        ),
      );
      confirm(
        flow.save(
          'production',
          {
            productId: product.id,
            finishedStockId: finished.id,
            date: date(3),
            goodQuantity: String(sold + 1),
            operator: '虚构工人',
            materials: [{ stockId: raw.id, issued: String(sold + 1) }],
          },
          maker,
        ),
      );
      const order = store.saveOrder(
        orderSchema.parse({
          customerId: customer.id,
          orderDate: date(1),
          deliveryDate: date(4),
          status: '已确认',
          taxMode: '未税',
          lines: [
            {
              productId: product.id,
              unit: '个',
              quantity: sold + 1,
              unitPriceCents: price * 100,
              unitPriceExact: String(price),
            },
          ],
        }),
      );
      const deliver = (qty: number) =>
        confirm(
          flow.save(
            'delivery',
            {
              date: date(4),
              customerId: customer.id,
              lines: [
                {
                  orderId: order.id,
                  orderLineId: order.lines[0].id,
                  stockId: finished.id,
                  quantity: String(qty),
                },
              ],
            },
            maker,
          ),
        );
      const delivery = deliver(sold);
      const reversed = deliver(1);
      flow.reverse(
        reversed.id,
        { version: reversed.version, acknowledged: true, reason: '虚构物理冲销' },
        maker,
      );
      const expectedTheory = sold * price * 100 - inbound * unitCost * 100;
      const trendQuery = { period, months: 3 };
      assert.equal(monthly.get(maker, { period }).theoreticalProfit, expectedTheory);
      assert.equal(monthly.get(maker, { period }).actualProfit, 0);
      assert.deepEqual(monthly.trend(maker, trendQuery).at(-1), monthly.get(maker, { period }));
      events.sync(maker, req());
      const original = findEvent(delivery.id);
      assert.equal(original.status, 'info_pending');
      const resolved = events.resolve(maker, original.id, {
        ...req(),
        version: original.version,
        evidence: '虚构零税率凭据',
        lines: [{ exact: String(sold * price), rate: '0', mode: '未税' }],
      });
      if (!resolved.voucher_id)
        events.generate(maker, original.id, { ...req(), version: resolved.version });
      const arrivalEvent = findEvent(receipt.id);
      events.generate(maker, arrivalEvent.id, { ...req(), version: arrivalEvent.version });
      const reversal = findEvent(reversed.id);
      events.correct(maker, reversal.id, {
        ...req(),
        version: reversal.version,
        date: date(4),
        reason: '核对虚构冲销',
      });
      post();
      const receive = obligation(delivery.id),
        payable = obligation(receipt.id);
      const carryForward = 200;
      const discount = (sold * price - 2) * 2;
      const receiptAmount = Number(receive.amount_cents) - carryForward - discount;
      const payment = 100 + random(50);
      const cashDoc = (
        kind: 'receipt' | 'payment',
        amount: number,
        day: number,
        obligation?: typeof receive,
        rebate = 0,
      ) => {
        const saved = cash.saveCash(maker, {
          ...req(),
          kind,
          accountId: bank.id,
          partyId: kind === 'receipt' ? customer.id : supplier.id,
          date: date(day),
          amount,
          method: '银行',
          description: '虚构收付款',
        });
        cash.confirm(maker, saved.id, {
          ...req(),
          version: saved.version,
          allocations: obligation
            ? [
                {
                  obligationId: obligation.id,
                  version: obligation.version,
                  amount: amount + rebate,
                  discount: rebate,
                },
              ]
            : [],
        });
        post();
        return saved;
      };
      cashDoc('receipt', receiptAmount, 5, receive, discount);
      const carryIn = priorDelivery === undefined ? 0 : carryForward;
      if (priorDelivery !== undefined) cashDoc('receipt', carryIn, 5, obligation(priorDelivery));
      priorDelivery = delivery.id;
      const undone = cashDoc('payment', 75, 5, payable);
      const allocation = db
        .prepare('SELECT id,version FROM fin_allocations WHERE cash_id=?')
        .get(undone.id)!;
      assert.throws(
        () =>
          cash.cancel(maker, undone.id, {
            ...req(),
            version: 2,
            date: date(6),
            reason: '先撤核销',
          }),
        /先撤销核销/,
      );
      cash.revoke(maker, allocation.id, {
        ...req(),
        version: allocation.version,
        date: date(6),
        reason: '虚构撤销核销',
      });
      post();
      cash.cancel(maker, undone.id, {
        ...req(),
        version: 3,
        date: date(6),
        reason: '虚构撤销资金单',
      });
      post();
      const freshPayable = obligation(receipt.id);
      cashDoc('payment', payment, 7, freshPayable);
      terms.deposit(maker, {
        ...req(),
        kind: 'paid',
        partyKind: 'supplier',
        partyId: supplier.id,
        accountId: bank.id,
        date: date(7),
        amount: 80,
        description: '虚构保证金',
      });
      const fee = 15 + random(25);
      const expense = expenses.save(maker, {
        ...req(),
        employeeId: 'seed-employee',
        employeeName: '虚构员工',
        department: '虚构部门',
        date: date(7),
        accountCode: '560201',
        amount: fee,
        description: '虚构费用',
      });
      expenses.transition(maker, expense.id, { ...req(), version: 1, action: 'submit' });
      expenses.transition(reviewer, expense.id, { ...req(), version: 2, action: 'approve' });
      post();
      expenses.transition(maker, expense.id, {
        ...req(),
        version: 3,
        action: 'pay',
        date: date(8),
        accountId: bank.id,
      });
      const manual = ledger.create(maker, {
        ...req(),
        date: date(8),
        description: '虚构先收后冲',
        entries: [entry('1002', 50, 0, null, '收到其他经营活动现金'), entry('5301', 0, 50)],
      });
      post();
      const posted = ledger.get(maker, manual.header.id);
      ledger.reverse(maker, manual.header.id, {
        ...req(),
        version: posted.header.version,
        date: date(9),
        description: '虚构红冲',
      });
      post();
      expectedAr += Number(receive.amount_cents) - receiptAmount - discount - carryIn;
      expectedAp += Number(payable.amount_cents) - payment;
      const cashChange = receiptAmount + carryIn - payment - fee - 80;
      expectedCash += cashChange;
      const report = monthly.get(maker, { period });
      assert.equal(report.theoreticalProfit, expectedTheory);
      assert.equal(report.actualIncome, receiptAmount + carryIn);
      assert.equal(report.actualExpense, payment + fee);
      assert.equal(report.discountExpense, discount);
      assert.equal(report.depositExpense, 80);
      const receiptSources = report.sources.filter((r) => r.metric === 'actualIncome');
      assert.equal(
        sum(receiptSources, (r) => r.amount),
        receiptAmount + carryIn,
      );
      assert.equal(
        sum(
          receiptSources.filter((r) => r.source_month !== period),
          (r) => r.amount,
        ),
        carryIn,
      );
      for (const metric of [
        'theoreticalIncome',
        'theoreticalExpense',
        'actualIncome',
        'actualExpense',
      ] as const)
        assert.equal(
          sum(monthly.detail(maker, { period, metric, pageSize: 200 }).rows, (r) => r.amount),
          report[metric],
          metric,
        );
      assert.equal(reports.get(maker, 'balance', { period }).balanced, true);
      assert.equal(reports.get(maker, 'cashflow', { period }).total, cashChange);
      assert.equal(
        cash.accounts(maker, { date: endOfMonth(period) }).rows[0].balance,
        expectedCash,
      );
      const balances = books.read(maker, 'balance', { period, pageSize: 200 }).rows;
      assert.deepEqual(books.read(maker, 'general', { period, pageSize: 200 }).rows, balances);
      const details = books.read(maker, 'detail', { period, pageSize: 200 }).rows;
      for (const row of balances) {
        const entries = details.filter((r) => r.account_code === row.account_code);
        assert.equal(
          sum(entries, (r) => r.debit),
          row.debit,
        );
        assert.equal(
          sum(entries, (r) => r.credit),
          row.credit,
        );
        assert.equal(Number(row.opening) + Number(row.debit) - Number(row.credit), row.ending);
      }
      assert.equal(balances.find((r) => r.account_code === '1122')?.ending, expectedAr);
      assert.equal(balances.find((r) => r.account_code === '2202')?.ending, -expectedAp);
      assert.equal(balances.find((r) => r.account_code === '1002')?.ending, expectedCash);
      for (const [kind, expected] of [
        ['receivable', expectedAr],
        ['payable', expectedAp],
      ] as const) {
        const open = parties.obligations(maker, { kind, pageSize: 200 }).rows;
        assert.equal(
          sum(open, (r) => r.balance),
          expected,
        );
      }
      new FinanceAssets(store).depreciate(maker, { ...req(), period });
      new FinancePayroll(store).confirm(maker, { ...req(), period });
      costing.run(maker, { ...req(), period });
      post();
      for (const item of costing.list(maker, { period, pageSize: 200 }).rows) {
        assert.equal(
          item.end_qty,
          db
            .prepare(
              'SELECT sum(delta_units) AS total FROM stock_movements WHERE item_id=? AND date<=?',
            )
            .get(item.stock_id, endOfMonth(period))?.total,
        );
        assert.ok(Number(item.end_cents) >= 0);
      }
      closing.accrueTax(maker, { ...req(), period });
      post();
      closing.settleProfit(maker, { ...req(), period });
      post();
      assert.deepEqual(
        db
          .prepare(
            `SELECT v.id FROM fin_vouchers v JOIN fin_entries e ON e.voucher_id=v.id
        WHERE v.status='posted' AND v.period=? GROUP BY v.id HAVING sum(e.debit)<>sum(e.credit)`,
          )
          .all(period),
        [],
      );
      const check = closing.check(maker, { period });
      assert.ok(check.canClose, JSON.stringify(check.steps));
      closing.close(maker, { ...req(), period, version: check.record!.version });
      const denied = {
        ...req(),
        date: date(20),
        description: '虚构期间写入',
        entries: [entry('1002', 1, 0, null, '收到其他经营活动现金'), entry('5301', 0, 1)],
      };
      const budget = { ...req(), period, accountCode: '5301', amount: 100 };
      assert.throws(() => ledger.create(maker, denied), /已结账/);
      assert.throws(() => reports.budget(maker, budget), /已结账/);
      if (period === periods.at(-1)) {
        const reopened = closing.reopen(maker, {
          ...req(),
          period,
          version: 2,
          reason: '虚构反结账核验',
        });
        assert.equal(reopened.status, 'open');
        assert.equal(ledger.create(maker, denied).header.status, 'draft');
        assert.equal(reports.budget(maker, budget)?.amount_cents, 100);
      }
      closedReports.push(monthly.get(maker, { period }));
    }
    assert.deepEqual(monthly.trend(maker, { period: periods[2], months: 3 }), closedReports);
  } finally {
    store.close();
  }
});
