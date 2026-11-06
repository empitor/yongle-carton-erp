import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { customerSchema, orderSchema, productSchema } from '../shared/domain.js';
import { createFullBackup, restoreFullBackup } from '../server/backup.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { DevelopmentResetService } from '../server/business/development-reset.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinanceParties } from '../server/finance/parties.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceSettlements } from '../server/finance/settlements.js';
import { FinanceReports, FinanceInfoPending } from '../server/finance/reports.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { FinanceMonthly } from '../server/finance/monthly.js';
import { FinanceBank } from '../server/finance/bank.js';
import { FinanceInvoices } from '../server/finance/invoices.js';
import { FinanceExpenses } from '../server/finance/expenses.js';
import { FinanceAssets } from '../server/finance/assets.js';
import { FinancePayroll } from '../server/finance/payroll.js';
import { FinanceCosting } from '../server/finance/costing.js';
import { FinanceDue } from '../server/finance/due.js';
import { FinanceTermOperations } from '../server/finance/terms-finance.js';
import { documentMoney } from '../server/finance/amounts.js';
import { dueDate, installments, termOptions } from '../server/finance/terms.js';
import { readFinanceTool } from '../server/finance/assistant.js';
import { financeReadTools } from '../shared/finance-tools.js';
import { financePermissions } from '../shared/finance.js';

const maker = {
  id: 'maker',
  name: '虚构制单员',
  role: 'super_admin' as const,
  permissions: [...financePermissions, 'business:edit'],
};
const approver = { ...maker, id: 'reviewer', name: '虚构审核员' };
const newSettings = (s: Store, period = '2026-01', cash = 0) => {
  const settings = new FinanceSettings(s);
  settings.enable(maker, {
    period,
    taxpayer: 'general',
    version: 1,
    requestId: 'enable',
    rows: cash
      ? [
          { accountCode: '1002', debit: cash, credit: 0, yearDebit: 0, yearCredit: 0 },
          { accountCode: '3001', debit: 0, credit: cash, yearDebit: 0, yearCredit: 0 },
        ]
      : [],
  });
  settings.update(maker, {
    version: 2,
    requestId: 'rates',
    taxRates: { smallVat: null, urban: 0, education: 0, localEducation: 0, income: 0 },
  });
  s.saveCustomer(customerSchema.parse({ name: '虚构客户' }));
  new OperationsService(s).saveSupplier({ name: '虚构供应商' }, maker);
  const funds = new FinanceSettlements(s);
  funds.saveAccount(maker, {
    kind: 'bank',
    name: '虚构资金账户',
    accountCode: '1002',
    lastFour: '0001',
    requestId: 'bank',
  });
  return funds;
};
function post(s: Store, key: unknown) {
  const ledger = new FinanceLedger(s),
    id = Number(key);
  const auditor = ledger.get(maker, id).header.maker_id === approver.id ? maker : approver;
  ledger.transition(maker, id, 'submit', { version: 1, requestId: 'submit-' + id });
  ledger.transition(auditor, id, 'approve', { version: 2, requestId: 'approve-' + id });
  ledger.transition(auditor, id, 'post', { version: 3, requestId: 'post-' + id });
}
function postDrafts(s: Store) {
  for (const r of s.db
    .prepare("SELECT id FROM fin_vouchers WHERE status='draft' ORDER BY id")
    .all())
    post(s, r.id);
}
function physical(s: Store, id: number, kind: string, date: string, doc: Record<string, unknown>) {
  const at = date + 'T09:00:00.000Z';
  s.db
    .prepare(
      `INSERT INTO flow_documents(id,kind,number,date,status,document,actor_id,actor_name,created_at,updated_at)
    VALUES(?,?,?,?,'confirmed',?,?,?,?,?)`,
    )
    .run(
      id,
      kind,
      'FICT-' + id,
      date,
      JSON.stringify({ ...doc, number: 'FICT-' + id, confirmedAt: at }),
      maker.id,
      maker.name,
      at,
      at,
    );
}
function shipment(
  s: Store,
  id: number,
  date: string,
  price: string,
  qty: string,
  extras: Record<string, unknown> = {},
) {
  physical(s, id, 'delivery', date, {
    customerId: 1,
    customerName: '虚构客户',
    lines: [
      {
        unit: '个',
        quantity: qty,
        unitPriceExact: price,
        stockId: 2,
        orderId: 1,
        productId: 1,
        ...extras,
      },
    ],
  });
}
function arrival(
  s: Store,
  id: number,
  date: string,
  price: string,
  qty: string,
  extra: Record<string, unknown> = {},
) {
  physical(s, id, 'arrival', date, {
    supplierId: 1,
    supplierName: '虚构供应商',
    lines: [
      {
        stockId: 1,
        item: { unit: '张' },
        quantity: qty,
        stockedQuantity: qty,
        unitPrice: price,
        priceBasis: 'quantity',
        ...extra,
      },
    ],
  });
}
function event(s: Store, source: number) {
  return s.db
    .prepare(
      'SELECT e.* FROM fin_events e JOIN fin_source_observations x ON e.id=x.event_id WHERE x.source_id=?',
    )
    .get(String(source))!;
}
function obligation(s: Store, source: number) {
  return s.db
    .prepare(
      'SELECT * FROM fin_obligations WHERE event_id=? AND amount_cents>0 ORDER BY id DESC LIMIT 1',
    )
    .get(event(s, source).id)!;
}
function funds(
  s: Store,
  service: FinanceSettlements,
  kind: 'receipt' | 'payment',
  date: string,
  amount: number,
  obligations: unknown[] = [],
) {
  const saved = service.saveCash(maker, {
    requestId: 'cash-' + kind + date + amount,
    kind,
    accountId: 1,
    partyId: 1,
    date,
    amount,
    method: '银行',
    description: '虚构收付款',
  });
  service.confirm(maker, saved.id, {
    version: 1,
    requestId: 'confirm-cash-' + saved.id,
    allocations: obligations,
  });
  postDrafts(s);
  return saved.id;
}
const purchaseBill = (number: string, extra: Record<string, unknown> = {}) => ({
  requestId: 'invoice-' + number,
  direction: 'purchase',
  type: '虚构数电票',
  number,
  date: '2026-02-15',
  partyId: 1,
  net: 10000,
  rate: '0',
  tax: 0,
  gross: 10000,
  ...extra,
});

test('待补税款可以收付核销并出对账单，批量补税后余额变化，月度理论与实际各自独立', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      events = new FinanceEvents(s),
      reports = new FinanceReports(s),
      monthly = new FinanceMonthly(s);
    shipment(s, 1, '2026-01-10', '100.0000', '1', { taxRate: '未明确' });
    arrival(s, 2, '2026-01-12', '10.0000', '10', { acceptedQuantity: '9', stockedQuantity: '8' });
    const before = monthly.get(maker, { period: '2026-01' });
    assert.equal(before.theoreticalProfit, 2000);
    assert.equal(before.missingTax, 2);
    const pending = (error: unknown) =>
      error instanceof FinanceInfoPending &&
      error.code === 'FINANCE_INFO_PENDING' &&
      error.details.count === 2;
    assert.throws(() => reports.get(maker, 'balance', { period: '2026-01' }), pending);
    events.sync(maker, { requestId: 'scan' });
    const ar = obligation(s, 1),
      ap = obligation(s, 2);
    assert.equal(ar.due_date, null);
    assert.equal(ap.amount_cents, 8000);
    assert.equal(ar.voucher_id, null);
    assert.deepEqual(JSON.parse(String(event(s, 1).snapshot)).missing, ['tax']);
    assert.equal(JSON.parse(String(event(s, 2).snapshot)).warnings.length, 1);
    funds(s, cash, 'payment', '2026-01-20', 2000, [
      { obligationId: ap.id, version: ap.version, amount: 2000 },
    ]);
    funds(s, cash, 'receipt', '2026-04-05', 5000, [
      { obligationId: ar.id, version: ar.version, amount: 5000 },
    ]);
    assert.equal(
      cash.statement(maker, {
        kind: 'receivable',
        partyId: '1',
        from: '2026-04-01',
        to: '2026-04-30',
      }).closing,
      5000,
    );
    const april = monthly.get(maker, { period: '2026-04' });
    assert.equal(april.actualIncome, 5000);
    assert.ok(
      april.sources.some(
        (r) => r.metric === 'actualIncome' && r.source_month === '2026-01' && r.amount === 5000,
      ),
    );
    assert.throws(
      () =>
        new FinanceClosing(s).close(maker, {
          period: '2026-01',
          version: 1,
          requestId: 'early-close',
        }),
      pending,
    );
    const original = s.db.prepare('SELECT document FROM flow_documents WHERE id=1').get();
    events.resolveBatch(maker, {
      kind: 'customer',
      partyId: 1,
      period: '2026-01',
      rate: '13',
      mode: '未税',
      requestId: 'customer-batch',
    });
    events.resolveBatch(maker, {
      items: [{ id: event(s, 2).id, version: event(s, 2).version }],
      noTax: true,
      requestId: 'no-tax',
    });
    postDrafts(s);
    assert.deepEqual(
      s.db.prepare('SELECT document FROM flow_documents WHERE id=1').get(),
      original,
    );
    const after = obligation(s, 1);
    assert.equal(after.id, ar.id);
    assert.equal(after.amount_cents, 11300);
    assert.equal(after.due_date, null);
    assert.equal(
      cash.statement(maker, {
        kind: 'receivable',
        partyId: '1',
        from: '2026-04-01',
        to: '2026-04-30',
      }).closing,
      6300,
    );
    assert.equal(monthly.get(maker, { period: '2026-01' }).theoreticalProfit, 2000);
    assert.equal(monthly.get(maker, { period: '2026-04' }).actualProfit, 5000);
    assert.equal(reports.get(maker, 'balance', { period: '2026-01' }).balanced, true);
  } finally {
    s.close();
  }
});

test('税率来源、账期快照、分期最大余数、压货款预测和现结优惠', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      parties = new FinanceParties(s),
      events = new FinanceEvents(s),
      due = new FinanceDue(s);
    const options = {
      discounts: [{ type: 'days', days: 10, rate: '2' }],
      installments: [
        { rate: '30', rule: { type: 'days', days: 15 } },
        { rate: '70', rule: { type: 'monthly', months: 3, paymentDay: 25 } },
      ],
    };
    parties.saveTerms(maker, {
      kind: 'customer',
      partyId: 1,
      termType: 'monthly',
      termMonths: 3,
      paymentDay: 25,
      cutoffDay: 25,
      taxRate: '13',
      taxMode: '含税',
      options,
      requestId: 'term',
    });
    shipment(s, 1, '2026-01-26', '100.0000', '1', { taxRate: '0', taxMode: '未明确' });
    events.sync(maker, { requestId: 'scan' });
    assert.deepEqual(JSON.parse(String(event(s, 1).snapshot)).taxSource, [
      { mode: 'party', rate: 'line' },
    ]);
    events.generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
    postDrafts(s);
    const o = obligation(s, 1);
    assert.equal(o.due_date, '2026-05-25');
    assert.equal(
      dueDate('2027-12-25', {
        term_type: 'monthly',
        term_months: 2,
        payment_day: 31,
        cutoff_day: 25,
      }),
      '2028-02-29',
    );
    assert.equal(
      dueDate('2027-12-26', {
        term_type: 'monthly',
        term_months: 2,
        payment_day: 31,
        cutoff_day: 25,
      }),
      '2028-03-31',
    );
    assert.equal(dueDate('2026-01-31', { term_type: 'days', term_days: 30 }), '2026-03-02');
    assert.throws(
      () => termOptions.parse({ installments: [{ rate: '99', rule: { type: 'days', days: 0 } }] }),
      /100%/,
    );
    const split = installments(3, '2026-01-26', { options: JSON.stringify(options) });
    assert.equal(
      split.reduce((n, r) => n + r.amount, 0),
      3,
    );
    const many = documentMoney(
      Array.from({ length: 200 }, () => ({ exact: '0.0050', mode: '未税', rate: '0' })),
    );
    assert.equal(many.gross, 100);
    assert.ok(many.lines.every((r) => r.gross >= 0));
    const plan = due.plan(maker, { date: '2026-01-31', months: 5 });
    assert.equal(plan.forecast.find((r) => r.period === '2026-02')?.receivable, 3000);
    assert.equal(due.discounts(maker, { date: '2026-02-01' }).rows[0].offer.amount, 200);
    assert.equal(due.discounts(maker, { date: '2026-02-10' }).filteredRecords, 0);
    funds(s, cash, 'receipt', '2026-02-01', 9800, [
      { obligationId: o.id, version: o.version, amount: 10000, discount: 200 },
    ]);
    const data = new FinanceMonthly(s).get(maker, { period: '2026-02' });
    assert.equal(data.discountExpense, 200);
    assert.equal(data.actualIncome, 9800);
    assert.equal(
      due
        .plan(maker, { date: '2026-02-01', months: 5 })
        .forecast.reduce((n, r) => n + r.receivable, 0),
      0,
    );
    parties.saveTerms(maker, {
      kind: 'customer',
      partyId: 1,
      termDays: 45,
      version: 1,
      requestId: 'change-term',
    });
    assert.equal(obligation(s, 1).due_date, '2026-05-25');
    const preview = due.preview(maker, { kind: 'receivable', partyId: '1' });
    assert.equal(preview.rows.length, 0);
    const result = due.change(maker, o.id, {
      version: 2,
      requestId: 'manual-date',
      dueDate: '2026-06-25',
      reason: '虚构约定',
    });
    assert.equal(result.due_date, '2026-06-25');
    assert.ok(
      s.db
        .prepare("SELECT id FROM business_audit WHERE action='due_change' AND record_id=?")
        .get(o.id),
    );
  } finally {
    s.close();
  }
});

test('银行导入去重、匹配建议不写入、余额调节与进项转出', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      bank = new FinanceBank(s),
      invoices = new FinanceInvoices(s);
    funds(s, cash, 'receipt', '2026-02-15', 9000);
    const payload = {
      accountId: 1,
      rows: [{ date: '2026-02-15', amount: 9000, reference: '虚构流水一', party: '虚构客户' }],
    };
    assert.deepEqual(bank.import(maker, { ...payload, requestId: 'bank-1' }), {
      imported: 1,
      duplicates: 0,
    });
    assert.deepEqual(bank.import(maker, { ...payload, requestId: 'bank-2' }), {
      imported: 0,
      duplicates: 1,
    });
    const [suggestion] = bank.suggestions(maker, 1);
    assert.equal(bank.list(maker, {}).rows[0].voucher_id, null);
    bank.match(maker, 1, {
      version: 1,
      requestId: 'match',
      voucherId: suggestion.voucher_id,
      position: suggestion.position,
    });
    assert.equal(
      bank.reconcile(maker, {
        accountId: 1,
        from: '2026-02-01',
        to: '2026-02-28',
        bankBalance: 9000,
      }).difference,
      0,
    );
    const bill = invoices.create(
      maker,
      purchaseBill('A-1', { rate: '13', tax: 1300, gross: 11300 }),
    );
    assert.throws(
      () => invoices.create(maker, purchaseBill('A-1', { requestId: 'duplicate' })),
      /已存在/,
    );
    assert.throws(
      () => invoices.create(maker, purchaseBill('R-1', { net: -10000, tax: -1300, gross: -11300 })),
      /原蓝票/,
    );
    invoices.confirm(maker, bill.id, { version: 1, requestId: 'invoice-confirm' });
    postDrafts(s);
    invoices.status(maker, bill.id, {
      version: 2,
      requestId: 'no-deduct',
      status: 'nondeductible',
      date: '2026-02-25',
      reason: '虚构不可抵扣',
      counterAccount: '560201',
    });
    postDrafts(s);
    assert.equal(invoices.tax(maker, { period: '2026-02' }).transfer, 1300);
    const red = invoices.create(
      maker,
      purchaseBill('R-2', {
        date: '2026-03-01',
        net: -10000,
        tax: -1300,
        gross: -11300,
        originalId: bill.id,
      }),
    );
    assert.ok(red.id);
  } finally {
    s.close();
  }
});

test('虚构制造业全链路的计价、费用、工资、折旧和三张报表可手算，按顺序结账', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s, '2026-01', 100000),
      events = new FinanceEvents(s),
      assets = new FinanceAssets(s),
      expenses = new FinanceExpenses(s),
      payroll = new FinancePayroll(s),
      cost = new FinanceCosting(s),
      closing = new FinanceClosing(s),
      reports = new FinanceReports(s),
      invoices = new FinanceInvoices(s);
    const asset = assets.add(maker, {
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
    assert.ok(asset.id);
    postDrafts(s);
    const ready = (period: string) => {
      assets.depreciate(maker, { period, requestId: 'depr-' + period });
      payroll.confirm(maker, { period, requestId: 'payroll-' + period });
      postDrafts(s);
      cost.run(maker, { period, requestId: 'cost-' + period });
      postDrafts(s);
      closing.accrueTax(maker, { period, requestId: 'tax-' + period });
      postDrafts(s);
    };
    const close = (period: string) => {
      closing.settleProfit(maker, { period, requestId: 'profit-' + period });
      postDrafts(s);
      const check = closing.check(maker, { period });
      assert.ok(check.canClose, JSON.stringify(check.steps));
      closing.close(maker, {
        period,
        version: check.record!.version,
        requestId: 'close-' + period,
      });
    };
    ready('2026-01');
    assert.equal(assets.depreciation(maker, { period: '2026-01' }).filteredRecords, 0);
    close('2026-01');
    const ops = new OperationsService(s),
      flow = new FlowService(s);
    const product = s.saveProduct(productSchema.parse({ name: '虚构纸箱' }));
    const raw = ops.saveItem(
      { name: '虚构纸板', kind: 'raw', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' },
      maker,
    );
    const finished = ops.saveItem(
      { name: '虚构纸箱', kind: 'finished', unit: '个', productId: product.id },
      maker,
    );
    const addOrder = (orderDate: string, deliveryDate: string, quantity: number) =>
      s.saveOrder(
        orderSchema.parse({
          customerId: 1,
          orderDate,
          deliveryDate,
          status: '已确认',
          taxRate: '0',
          taxMode: '未税',
          lines: [
            {
              productId: product.id,
              productName: product.name,
              unit: '个',
              quantity,
              unitPriceCents: 3000,
              unitPriceExact: '30.0000',
            },
          ],
        }),
      );
    const sale = addOrder('2026-02-01', '2026-02-15', 2);
    const purchase = ops.savePurchase(
      {
        supplierId: 1,
        orderDate: '2026-02-01',
        status: '已订货',
        lines: [
          {
            ...raw,
            stockItemId: raw.id,
            quantity: '10',
            unitPrice: '10.0000',
            priceBasis: 'quantity',
          },
        ],
      },
      maker,
    );
    new FinanceParties(s).saveTerms(maker, {
      kind: 'supplier',
      partyId: 1,
      termDays: 0,
      taxRate: '0',
      taxMode: '未税',
      requestId: 'supplier-tax',
    });
    const confirm = (doc: { id: number }) =>
      flow.confirm(
        doc.id,
        {
          previewId: flow.preview(doc.id, maker, 'finance-fixture').previewId,
          requestId: randomUUID(),
          acknowledged: true,
        },
        maker,
        'finance-fixture',
      );
    const received = confirm(
      flow.save(
        'arrival',
        {
          supplierId: 1,
          date: '2026-02-05',
          reference: '虚构到货',
          lines: [
            {
              stockId: raw.id,
              purchaseLineId: purchase.lines[0].id,
              item: raw,
              quantity: '10',
              unitPrice: '10.0000',
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
          date: '2026-02-10',
          productId: product.id,
          finishedStockId: finished.id,
          goodQuantity: '5',
          operator: '虚构操作员',
          materials: [{ stockId: raw.id, issued: '5' }],
        },
        maker,
      ),
    );
    const deliver = (order: ReturnType<typeof addOrder>, date: string, quantity: string) =>
      confirm(
        flow.save(
          'delivery',
          {
            date,
            customerId: 1,
            lines: [
              { orderId: order.id, orderLineId: order.lines[0].id, stockId: finished.id, quantity },
            ],
          },
          maker,
        ),
      );
    const delivered = deliver(sale, '2026-02-15', '2');
    events.sync(maker, { requestId: 'physical' });
    for (const id of [received.id, delivered.id])
      events.generate(maker, event(s, id).id, { version: 1, requestId: 'event-' + id });
    postDrafts(s);
    const bill = invoices.create(maker, purchaseBill('PURCHASE'));
    invoices.link(maker, bill.id, {
      version: 1,
      requestId: 'link-purchase',
      links: [{ obligationId: obligation(s, received.id).id, amount: 10000 }],
    });
    invoices.confirm(maker, bill.id, { version: 2, requestId: 'confirm-purchase' });
    const salesBill = invoices.create(maker, {
      ...purchaseBill('SALE'),
      direction: 'sale',
      net: 6000,
      gross: 6000,
    });
    invoices.link(maker, salesBill.id, {
      version: 1,
      requestId: 'link-sale',
      links: [{ obligationId: obligation(s, delivered.id).id, amount: 6000 }],
    });
    invoices.confirm(maker, salesBill.id, { version: 2, requestId: 'confirm-sale' });
    postDrafts(s);
    const ar = obligation(s, delivered.id),
      ap = obligation(s, received.id);
    funds(s, cash, 'receipt', '2026-02-16', 6000, [
      { obligationId: ar.id, version: ar.version, amount: 6000 },
    ]);
    funds(s, cash, 'payment', '2026-02-17', 10000, [
      { obligationId: ap.id, version: ap.version, amount: 10000 },
    ]);
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
    expenses.transition(maker, ex.id, {
      action: 'submit',
      version: 1,
      requestId: 'expense-submit',
    });
    expenses.transition(approver, ex.id, {
      action: 'approve',
      version: 2,
      requestId: 'expense-approve',
    });
    postDrafts(s);
    expenses.transition(maker, ex.id, {
      action: 'pay',
      version: 3,
      date: '2026-02-21',
      accountId: 1,
      requestId: 'expense-pay',
    });
    postDrafts(s);
    payroll.save(maker, {
      period: '2026-02',
      requestId: 'wages',
      rows: [
        {
          employeeId: 'e-1',
          employeeName: '虚构员工',
          department: '虚构部门',
          accountCode: '560204',
          gross: 300,
          social: 0,
          housing: 0,
          tax: 0,
          net: 300,
          employerSocial: 0,
          employerHousing: 0,
        },
      ],
    });
    const finance = { ...maker, role: undefined, permissions: ['finance:view', 'finance:edit'] };
    assert.throws(() => payroll.list(finance, { period: '2026-02', detail: '1' }), /权限/);
    assert.equal(payroll.list(finance, { period: '2026-02' }).rows[0].gross, 300);
    s.db.prepare("UPDATE stock_items SET unit='卷' WHERE id=?").run(raw.id);
    assert.throws(() => cost.run(maker, { period: '2026-02', requestId: 'wrong-unit' }), /单位/);
    s.db.prepare("UPDATE stock_items SET unit='张' WHERE id=?").run(raw.id);
    ready('2026-02');
    payroll.pay(maker, {
      period: '2026-02',
      date: '2026-02-28',
      accountId: 1,
      requestId: 'wages-pay',
    });
    postDrafts(s);
    assert.equal(assets.depreciation(maker, { period: '2026-02' }).rows[0].amount_cents, 1000);
    assert.equal(
      cost.list(maker, { period: '2026-02' }).rows.reduce((n, r) => n + Number(r.end_cents), 0),
      8000,
    );
    assert.equal(reports.get(maker, 'profit', { period: '2026-02' }).netProfit, 2300);
    assert.equal(reports.get(maker, 'cashflow', { period: '2026-02' }).total, -4700);
    assert.equal(reports.get(maker, 'cashflow', { period: '2026-02' }).ending, 83300);
    reports.budget(maker, {
      period: '2026-02',
      accountCode: '560201',
      amount: 500,
      requestId: 'budget',
    });
    assert.equal(reports.budgets(maker, { period: '2026-02' }).rows[0].difference, -100);
    close('2026-02');
    assert.equal(reports.get(maker, 'balance', { period: '2026-02' }).balanced, true);
    assert.equal(reports.get(maker, 'profit', { period: '2026-02' }).netProfit, 2300);
    deliver(addOrder('2026-03-01', '2026-03-01', 1), '2026-03-01', '1');
    events.sync(maker, { requestId: 'next-physical' });
    const estimate = cost.margin(maker, { period: '2026-03', group: 'order' }).rows[0];
    assert.equal(estimate.cost, 1000);
    assert.equal(estimate.margin, 2000);
    assert.throws(
      () =>
        closing.reopen(maker, {
          period: '2026-01',
          version: 2,
          reason: '核验',
          requestId: 'wrong-reopen',
        }),
      /最近/,
    );
    assert.equal(
      closing.reopen(maker, {
        period: '2026-02',
        version: 2,
        reason: '虚构核验',
        requestId: 'reopen',
      }).status,
      'open',
    );
    assert.ok(
      s.db
        .prepare("SELECT id FROM business_audit WHERE source='finance' AND action='reopen'")
        .get(),
    );
  } finally {
    s.close();
  }
});

test('财务 AI 工具拒绝无权限，备份保留附件字节，初始化须重新预览已结期间', async () => {
  const root = mkdtempSync(join(tmpdir(), 'erp-finance-verify-'));
  const data = join(root, 'test-store'),
    backups = join(root, 'test-backup'),
    restore = join(root, 'test-restore');
  mkdirSync(data);
  const s = new Store(join(data, 'erp.sqlite'));
  try {
    newSettings(s);
    const bytes = Buffer.from('%PDF-虚构验收');
    const attachment = new FinanceInvoices(s).saveAttachment(
      maker,
      { filename: 'fixture.pdf', requestId: 'file' },
      bytes,
    );
    for (const tool of financeReadTools)
      assert.throws(
        () => readFinanceTool(s, { id: 'no', name: '虚构只读账号', permissions: [] }, tool, {}),
        /权限/,
      );
    const backup = await createFullBackup({ dataDir: data, backupRoot: backups });
    assert.equal(existsSync(restore), false);
    restoreFullBackup(backup.dir, restore);
    const copy = new Store(join(restore, 'erp.sqlite'));
    try {
      assert.deepEqual(
        Buffer.from(new FinanceInvoices(copy).attachment(maker, attachment.id).bytes as Uint8Array),
        bytes,
      );
      assert.equal(copy.db.prepare('SELECT max(version) AS n FROM schema_migrations').get()?.n, 17);
    } finally {
      copy.close();
    }
    const local = localAdministratorActor(maker);
    const reset = new DevelopmentResetService(s);
    s.db.exec("UPDATE fin_periods SET status='closed' WHERE period='2026-01'");
    assert.throws(() => reset.execute('business', local), /初始化预览/);
    const preview = reset.preview('business', local, true);
    assert.equal((preview.tables as Record<string, number>).fin_attachments, 1);
    assert.ok(preview.finance?.digest);
    reset.execute('business', local, undefined, {
      clearClosedFinance: true,
      financeDigest: preview.finance.digest,
    });
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM fin_attachments').get()?.n, 0);
    assert.ok(s.db.prepare('SELECT 1 FROM fin_accounts LIMIT 1').get());
    assert.ok(s.db.prepare('SELECT 1 FROM fin_templates LIMIT 1').get());
    assert.doesNotThrow(() => reset.execute('business', local));
  } finally {
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('保证金部分退回和转抵，利息确认及免除可追溯', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const term = new FinanceTermOperations(s),
      parties = new FinanceParties(s),
      events = new FinanceEvents(s);
    parties.saveTerms(maker, {
      requestId: 'term',
      kind: 'customer',
      partyId: 1,
      termDays: 30,
      options: {
        deposits: true,
        interest: { rate: '36.5', unit: 'annual', basis: 'document', freeDays: 5 },
      },
    });
    shipment(s, 1, '2026-01-01', '100.00', '1', { taxMode: '未税', taxRate: '0' });
    events.sync(maker, { requestId: 'scan' });
    events.generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
    postDrafts(s);
    const deposit = term.deposit(maker, {
      requestId: 'deposit',
      kind: 'received',
      partyKind: 'customer',
      partyId: 1,
      accountId: 1,
      date: '2026-01-03',
      amount: 1000,
      description: '虚构保证金',
    });
    postDrafts(s);
    term.depositAction(maker, deposit.id, {
      requestId: 'refund',
      version: 1,
      kind: 'refund',
      date: '2026-01-04',
      accountId: 1,
      amount: 200,
      reason: '部分退回',
    });
    term.depositAction(maker, deposit.id, {
      requestId: 'apply',
      version: 2,
      kind: 'apply',
      date: '2026-01-05',
      obligationId: obligation(s, 1).id,
      amount: 300,
      reason: '部分转抵',
    });
    postDrafts(s);
    assert.equal(term.deposits(maker, {}).rows[0].balance, 500);
    assert.equal(parties.obligations(maker, { kind: 'receivable' }).rows[0].balance, 9700);
    const estimate = term.interest(maker, { period: '2026-01', kind: 'receivable' }).rows[0]
      .estimate;
    assert.equal(estimate?.days, 25);
    assert.equal(estimate?.amount, 243);
    const interest = term.confirmInterest(maker, {
      period: '2026-01',
      obligationId: obligation(s, 1).id,
      version: 2,
      amount: 0,
      reason: '虚构免息',
      requestId: 'waive',
    });
    assert.equal(interest.voucher_id, null);
    const monthly = new FinanceMonthly(s).get(maker, { period: '2026-01' });
    assert.equal(monthly.actualIncome, 0);
    assert.equal(monthly.depositIncome, 1000);
    assert.equal(monthly.depositExpense, 200);
    assert.equal(monthly.theoreticalProfit, 10000);
  } finally {
    s.close();
  }
});

test('一笔收款跨多张来源单，多个收款单冲同一往来单，下钻合计等于实际收入', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      events = new FinanceEvents(s),
      monthly = new FinanceMonthly(s);
    shipment(s, 1, '2026-01-10', '100.00', '1', { taxRate: '0', taxMode: '未税' });
    shipment(s, 2, '2026-02-10', '200.00', '1', { taxRate: '0', taxMode: '未税' });
    events.sync(maker, { requestId: 'scan' });
    for (const id of [1, 2])
      events.generate(maker, event(s, id).id, { version: 1, requestId: 'source-' + id });
    postDrafts(s);
    const a = obligation(s, 1),
      b = obligation(s, 2);
    funds(s, cash, 'receipt', '2026-04-01', 22000, [
      { obligationId: a.id, version: a.version, amount: 10000 },
      { obligationId: b.id, version: b.version, amount: 10000 },
    ]);
    funds(s, cash, 'receipt', '2026-04-02', 5000, [
      { obligationId: b.id, version: 2, amount: 5000 },
    ]);
    const data = monthly.get(maker, { period: '2026-04' });
    assert.equal(data.actualIncome, 27000);
    const split = Object.fromEntries(data.sources.map((r) => [r.source_month, r.amount]));
    assert.deepEqual(split, { '2026-01': 10000, '2026-02': 15000, unallocated: 2000 });
    const details = monthly.detail(maker, {
      period: '2026-04',
      metric: 'actualIncome',
      sourceMonth: '2026-02',
    });
    assert.equal(details.rows.length, 2);
    assert.equal(
      details.rows.reduce((n, r) => n + Number(r.amount), 0),
      15000,
    );
    assert.equal(data.theoreticalProfit, 0);
    const bank = new FinanceBank(s);
    bank.import(maker, {
      accountId: 1,
      requestId: 'bank-import',
      rows: [{ date: '2026-04-01', amount: 22000, reference: '虚构合并流水' }],
    });
    const grouped = bank.suggestions(maker, 1).find((x) => x.entries);
    assert.equal(grouped?.entries?.length, 3);
    bank.match(maker, 1, { version: 1, requestId: 'bank-group', entries: grouped!.entries });
    assert.equal(
      bank.reconcile(maker, {
        accountId: 1,
        from: '2026-04-01',
        to: '2026-04-30',
        bankBalance: 22000,
      }).difference,
      0,
    );
  } finally {
    s.close();
  }
});

test('部分到票当期全额红冲原暂估并保留余量暂估，往来 ID 保持一致', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s),
      invoices = new FinanceInvoices(s),
      reports = new FinanceReports(s);
    arrival(s, 1, '2026-01-15', '10.00', '10', { taxMode: '未税', taxRate: '0' });
    events.sync(maker, { requestId: 'scan' });
    events.generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
    postDrafts(s);
    const before = obligation(s, 1);
    const first = invoices.create(
      maker,
      purchaseBill('PART', { net: 4000, tax: 520, gross: 4520, rate: '13' }),
    );
    invoices.link(maker, first.id, {
      version: 1,
      requestId: 'link',
      links: [{ obligationId: before.id, amount: 4520, estimateAmount: 4000 }],
    });
    invoices.confirm(maker, first.id, { version: 2, requestId: 'confirm' });
    postDrafts(s);
    const adjusted = obligation(s, 1);
    assert.equal(adjusted.id, before.id);
    assert.equal(adjusted.amount_cents, 10520);
    assert.equal(adjusted.estimate_remaining, 6000);
    assert.equal(
      s.db
        .prepare('SELECT count(*) AS n FROM fin_vouchers WHERE reversal_of=?')
        .get(before.voucher_id)?.n,
      1,
    );
    assert.equal(reports.get(maker, 'balance', { period: '2026-02' }).balanced, true);
  } finally {
    s.close();
  }
});

test('平均年限折旧从下月开始，尾差提足后停止', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const assets = new FinanceAssets(s);
    assets.add(maker, {
      requestId: 'asset',
      number: 'FICT-ASSET-02',
      name: '虚构设备',
      category: '设备',
      original: 10001,
      date: '2026-01-20',
      months: 2,
      residualBp: 1000,
      department: '虚构部门',
      expenseAccount: '560205',
      counterAccount: '1002',
      cashFlow: '购建固定资产支付的现金',
    });
    postDrafts(s);
    const amounts = [];
    for (const period of ['2026-01', '2026-02', '2026-03', '2026-04']) {
      assets.depreciate(maker, { period, requestId: 'depreciation-' + period });
      postDrafts(s);
      amounts.push(Number(assets.depreciation(maker, { period }).rows[0]?.amount_cents ?? 0));
    }
    assert.deepEqual(amounts, [0, 4501, 4500, 0]);
  } finally {
    s.close();
  }
});
