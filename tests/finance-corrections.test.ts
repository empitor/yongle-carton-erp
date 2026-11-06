import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { financePermissions } from '../shared/finance.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinanceParties } from '../server/finance/parties.js';
import { FinanceSettlements } from '../server/finance/settlements.js';
import { FinanceReports } from '../server/finance/reports.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { FinanceMonthly } from '../server/finance/monthly.js';

const maker = {
  id: 'maker',
  name: '虚构财务',
  role: 'super_admin' as const,
  permissions: [...financePermissions],
};
const reviewer = { ...maker, id: 'reviewer' };
function setup(s: Store) {
  new FinanceSettings(s).enable(maker, {
    period: '2026-01',
    taxpayer: 'general',
    version: 1,
    requestId: 'enable',
    rows: [],
  });
  s.db.exec("INSERT INTO customers VALUES(1,'虚构客户','','','','',1,'2026-01-01')");
  const cash = new FinanceSettlements(s);
  cash.saveAccount(maker, {
    requestId: 'bank',
    name: '虚构银行',
    kind: 'bank',
    accountCode: '1002',
  });
  return cash;
}
function post(s: Store) {
  const ledger = new FinanceLedger(s);
  for (const { id } of s.db
    .prepare("SELECT id FROM fin_vouchers WHERE status='draft' ORDER BY id")
    .all()) {
    ledger.transition(maker, id, 'submit', { requestId: randomUUID(), version: 1 });
    ledger.transition(reviewer, id, 'approve', { requestId: randomUUID(), version: 2 });
    ledger.transition(reviewer, id, 'post', { requestId: randomUUID(), version: 3 });
  }
}
function apply(s: Store, cash: FinanceSettlements) {
  const ob = new FinanceParties(s).create(maker, {
    requestId: 'ar',
    kind: 'receivable',
    partyId: 1,
    date: '2026-01-01',
    dueDate: '2026-01-15',
    amount: 10000,
    description: '虚构往来',
    counterAccount: '5001',
  });
  post(s);
  const c = cash.saveCash(maker, {
    requestId: 'cash',
    kind: 'receipt',
    accountId: 1,
    partyId: 1,
    date: '2026-01-02',
    amount: 6000,
    method: '银行',
    description: '虚构收款',
  });
  cash.confirm(maker, c.id, {
    version: 1,
    requestId: 'confirm',
    allocations: [{ obligationId: ob.id, version: 1, amount: 4000 }],
  });
  return c;
}

const cashier = { id: 'cashier', name: '虚构出纳', permissions: ['finance:view', 'finance:cash'] };

for (const state of ['unposted', 'open', 'closed'] as const) {
  test('撤销资金单 ' + state + ' 保留凭证审计并冲减账户余额', () => {
    const s = new Store(':memory:');
    try {
      const cash = setup(s),
        monthly = new FinanceMonthly(s);
      const saved = cash.saveCash(cashier, {
        requestId: 'save',
        kind: 'income',
        accountId: 1,
        date: '2026-01-08',
        amount: 3000,
        method: '银行',
        description: '虚构其他收入',
        counterAccount: '5301',
        cashFlow: '收到其他经营活动现金',
      });
      cash.confirm(cashier, saved.id, { version: 1, requestId: 'confirm' });
      if (state !== 'unposted') post(s);
      const original = cash.cash(cashier, saved.id).vouchers[0];
      assert.equal(monthly.get(cashier, { period: '2026-01' }).actualIncome, 3000);
      if (state === 'closed')
        s.db.exec("UPDATE fin_periods SET status='closed' WHERE period='2026-01'");
      const payload = {
        version: 2,
        requestId: 'cancel',
        date: state === 'closed' ? '2026-02-01' : '2026-01-09',
        reason: '虚构撤销资金单',
      };
      if (state === 'closed')
        assert.throws(
          () => cash.cancel(cashier, saved.id, { ...payload, date: '2026-01-31' }),
          /已结账/,
        );
      const cancelled = cash.cancel(cashier, saved.id, payload);
      assert.equal(cancelled.status, 'cancelled');
      assert.deepEqual(
        cash.cancel(cashier, saved.id, payload).reversalVoucherIds,
        cancelled.reversalVoucherIds,
      );
      assert.equal(monthly.get(cashier, { period: '2026-01' }).actualIncome, 0);
      assert.equal(cancelled.voidedVoucherIds.length, state === 'unposted' ? 1 : 0);
      assert.equal(cancelled.reversalVoucherIds.length, state === 'unposted' ? 0 : 1);
      assert.equal(
        cash.accounts(cashier, { date: payload.date }).rows[0].balance,
        state === 'unposted' ? 0 : 3000,
      );
      post(s);
      assert.equal(cash.accounts(cashier, { date: payload.date }).rows[0].balance, 0);
      assert.equal(monthly.get(cashier, { period: '2026-02' }).actualExpense, 0);
      const ledger = new FinanceLedger(s);
      assert.equal(
        ledger.get(cashier, original.id).header.status,
        state === 'unposted' ? 'void' : 'posted',
      );
      if (state === 'closed')
        assert.equal(cash.accounts(cashier, { date: '2026-01-31' }).rows[0].balance, 3000);
      const audit = s.db
        .prepare(
          "SELECT document FROM business_audit WHERE entity='fin_cash_documents' AND action='cancel'",
        )
        .get();
      assert.equal(JSON.parse(String(audit?.document)).after.reason, payload.reason);
    } finally {
      s.close();
    }
  });
}

test('资金单有核销时拦截，核销红冲记账后只冲减剩余资金凭证', () => {
  const s = new Store(':memory:');
  try {
    const cash = setup(s),
      saved = apply(s, cash);
    post(s);
    const payload = {
      version: 2,
      requestId: 'cancel',
      date: '2026-01-08',
      reason: '虚构撤销资金单',
    };
    assert.throws(() => cash.cancel(cashier, saved.id, payload), /先撤销核销/);
    cash.revoke(maker, 1, {
      version: 1,
      requestId: 'revoke',
      date: '2026-01-07',
      reason: '虚构撤销核销',
    });
    assert.throws(() => cash.cancel(cashier, saved.id, { ...payload, version: 3 }), /先撤销核销/);
    post(s);
    const result = cash.cancel(cashier, saved.id, { ...payload, version: 3 });
    assert.equal(result.reversalVoucherIds.length, 2);
    post(s);
    assert.equal(cash.accounts(cashier, { date: '2026-01-31' }).rows[0].balance, 0);
  } finally {
    s.close();
  }
});

for (const syncBeforeRevoke of [true, false])
  test(
    '缺税送货冲销后等待撤销核销，红冲记账后解除报表和结账拦截，先同步=' + syncBeforeRevoke,
    () => {
      const s = new Store(':memory:');
      try {
        const cash = setup(s),
          events = new FinanceEvents(s),
          reports = new FinanceReports(s),
          closing = new FinanceClosing(s);
        const period = '2026-01',
          date = period + '-10';
        const doc = {
          customerId: 1,
          customerName: '虚构客户',
          lines: [{ unit: '个', quantity: '1', unitPriceExact: '100.0000' }],
        };
        s.db
          .prepare(
            `INSERT INTO flow_documents(kind,number,date,status,document,actor_id,actor_name,created_at,updated_at)
      VALUES('delivery','FICT-TAX',?,'confirmed',?,?,?,?,?)`,
          )
          .run(date, JSON.stringify(doc), maker.id, maker.name, date, date);
        events.sync(maker, { requestId: 'scan' });
        const ob = new FinanceParties(s).obligations(maker, { kind: 'receivable' }).rows[0];
        assert.deepEqual(reports.readiness(maker, { period }).rows[0].missing, ['tax']);
        const c = cash.saveCash(maker, {
          requestId: 'cash',
          kind: 'receipt',
          accountId: 1,
          partyId: 1,
          date: '2026-01-11',
          amount: 5000,
          method: '银行',
          description: '虚构收款',
        });
        cash.confirm(maker, c.id, {
          version: 1,
          requestId: 'confirm',
          allocations: [{ obligationId: ob.id, version: ob.version, amount: 5000 }],
        });
        post(s);
        s.db.exec("UPDATE flow_documents SET status='reversed',version=2 WHERE id=1");
        assert.match(String(reports.readiness(maker, { period }).rows[0].problem), /先撤销核销/);
        if (syncBeforeRevoke) {
          events.sync(maker, { requestId: 're-scan' });
          assert.equal(events.list(maker, { status: 'info_pending' }).filteredRecords, 0);
          assert.equal(
            events.list(maker, { status: 'awaiting_allocation_reversal' }).filteredRecords,
            1,
          );
        }
        assert.deepEqual(reports.readiness(maker, { period }).rows[0].missing, [
          'allocation_reversal',
        ]);
        assert.throws(() => reports.get(maker, 'balance', { period }), /先撤销核销/);
        assert.equal(closing.check(maker, { period }).steps[0].ok, false);
        cash.revoke(maker, 1, {
          version: 1,
          requestId: 'revoke',
          date: '2026-01-12',
          reason: '虚构撤销',
        });
        assert.equal(reports.readiness(maker, { period }).ready, false);
        post(s);
        assert.equal(reports.readiness(maker, { period }).ready, true);
        assert.equal(closing.check(maker, { period }).steps[0].ok, true);
        if (!syncBeforeRevoke) events.sync(maker, { requestId: 're-scan' });
        assert.equal(
          new FinanceParties(s).obligations(maker, { kind: 'receivable' }).filteredRecords,
          0,
        );
        assert.equal(reports.get(maker, 'balance', { period }).balanced, true);
      } finally {
        s.close();
      }
    },
  );

test('手工现金收入与支出红冲按原方向冲减，经营下钻保留两条明细', () => {
  const s = new Store(':memory:');
  try {
    setup(s);
    const ledger = new FinanceLedger(s),
      monthly = new FinanceMonthly(s),
      period = '2026-01';
    for (const [metric, amount] of [
      ['actualIncome', 3000],
      ['actualExpense', 1000],
    ] as const) {
      const incoming = metric === 'actualIncome';
      const voucher = ledger.create(maker, {
        requestId: 'create-' + metric,
        date: period + '-05',
        description: '虚构手工现金',
        entries: [
          {
            accountCode: '1002',
            debit: incoming ? amount : 0,
            credit: incoming ? 0 : amount,
            cashFlow: '经营活动现金',
          },
          {
            accountCode: incoming ? '5301' : '5711',
            debit: incoming ? 0 : amount,
            credit: incoming ? amount : 0,
          },
        ],
      });
      post(s);
      const reversal = ledger.reverse(maker, voucher.header.id, {
        version: 4,
        requestId: 'red-' + metric,
        date: period + '-06',
        description: '虚构手工红冲',
      });
      post(s);
      const detail = monthly.detail(maker, { period, metric, sort: 'oldest' }).rows;
      assert.deepEqual(
        detail.map((item) => item.amount),
        [amount, -amount],
      );
      assert.equal(
        (detail[1].detail as { voucherId: number; reversalOf: number }).voucherId,
        reversal.header.id,
      );
      assert.equal(
        (detail[1].detail as { voucherId: number; reversalOf: number }).reversalOf,
        voucher.header.id,
      );
    }
    const result = monthly.get(maker, { period });
    assert.deepEqual([result.actualIncome, result.actualExpense, result.actualProfit], [0, 0, 0]);
  } finally {
    s.close();
  }
});
for (const state of ['unposted', 'open', 'closed'] as const)
  test('撤销核销路径 ' + state, () => {
    const s = new Store(':memory:');
    try {
      const cash = setup(s),
        c = apply(s, cash);
      if (state !== 'unposted') post(s);
      if (state === 'closed')
        s.db.exec("UPDATE fin_periods SET status='closed' WHERE period='2026-01'");
      cash.revoke(maker, 1, {
        version: 1,
        requestId: 'revoke',
        date: state === 'closed' ? '2026-02-01' : '2026-01-03',
        reason: '虚构撤销',
      });
      post(s);
      const original = s.db.prepare('SELECT * FROM fin_allocations WHERE id=1').get()!;
      assert.equal(original.status, state === 'closed' ? 'active' : 'revoked');
      const red = s.db.prepare('SELECT * FROM fin_allocations WHERE reversal_of=1').get();
      assert.equal(red?.amount_cents, state === 'unposted' ? undefined : -4000);
      const ledger = s.db
        .prepare(
          "SELECT sum((e.debit-e.credit)*CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END) AS amount FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.status='posted' AND e.account_code='1002'",
        )
        .get()!;
      assert.equal(ledger.amount, 6000);
      assert.equal(
        new FinanceParties(s).obligations(maker, { kind: 'receivable' }).rows[0].balance,
        10000,
      );
      assert.equal(cash.cashList(maker, { kind: 'receipt' }).rows[0].unallocated, 6000);
      assert.equal(cash.cash(maker, c.id).allocations.length, state === 'unposted' ? 1 : 2);
    } finally {
      s.close();
    }
  });

test('来源更正先撤销核销，全额红冲重做保留旧凭证，物理删除标记事件', () => {
  const s = new Store(':memory:');
  try {
    const cash = setup(s),
      events = new FinanceEvents(s);
    const date = '2026-01-10';
    const doc = {
      customerId: 1,
      customerName: '虚构客户',
      number: 'FICT-D1',
      lines: [
        { unit: '个', quantity: '1', unitPriceExact: '100.0000', taxMode: '未税', taxRate: '0' },
      ],
    };
    s.db
      .prepare(
        `INSERT INTO flow_documents(kind,number,date,status,document,actor_id,actor_name,created_at,updated_at)
      VALUES('delivery','FICT-D1',?,'confirmed',?,?,?,?,?)`,
      )
      .run(date, JSON.stringify(doc), maker.id, maker.name, date, date);
    events.sync(maker, { requestId: 'scan' });
    const first = events.list(maker, {}).rows[0];
    const voucher = events.generate(maker, first.id, {
      version: 1,
      requestId: 'generate',
    }).voucher_id;
    post(s);
    const ob = new FinanceParties(s).obligations(maker, { kind: 'receivable' }).rows[0];
    const draft = cash.saveCash(maker, {
      requestId: 'cash',
      kind: 'receipt',
      accountId: 1,
      partyId: 1,
      date: '2026-01-11',
      amount: 5000,
      method: '银行',
      description: '虚构收款',
    });
    cash.confirm(maker, draft.id, {
      version: 1,
      requestId: 'confirm',
      allocations: [{ obligationId: ob.id, version: ob.version, amount: 5000 }],
    });
    post(s);
    doc.lines[0].quantity = '2';
    s.db
      .prepare('UPDATE flow_documents SET document=?,version=2 WHERE id=1')
      .run(JSON.stringify(doc));
    events.sync(maker, { requestId: 're-scan' });
    const diff = events.list(maker, { status: 'difference' }).rows[0];
    assert.throws(
      () =>
        events.correct(maker, diff.id, {
          version: 1,
          date: '2026-01-12',
          requestId: 'correct',
          reason: '虚构改数量',
        }),
      /先撤销/,
    );
    cash.revoke(maker, 1, {
      version: 1,
      date: '2026-01-12',
      reason: '虚构撤销',
      requestId: 'revoke',
    });
    post(s);
    const replacement = events.correct(maker, diff.id, {
      version: 1,
      date: '2026-01-13',
      requestId: 'correct',
      reason: '虚构改数量',
    });
    assert.equal(replacement.amount_cents, 20000);
    post(s);
    const values = s.db
      .prepare('SELECT amount_cents FROM fin_obligations ORDER BY id')
      .all()
      .map((r) => r.amount_cents);
    assert.deepEqual(values, [10000, -10000, 20000]);
    assert.equal(
      s.db.prepare('SELECT status FROM fin_vouchers WHERE id=?').get(voucher)?.status,
      'posted',
    );
    const admin = localAdministratorActor(maker),
      maintenance = new DatabaseMaintenanceService(s);
    const selection = { module: 'delivery', items: [{ id: 1, version: 2 }] };
    const preview = maintenance.preview(selection, admin);
    maintenance.delete(
      { ...selection, requestId: randomUUID(), deletionDigest: preview.digest },
      admin,
      'fixture',
    );
    assert.equal(events.list(maker, { status: 'source_deleted' }).rows[0].id, diff.id);
    assert.equal(
      s.db.prepare('SELECT status FROM fin_vouchers WHERE id=?').get(voucher)?.status,
      'posted',
    );
  } finally {
    s.close();
  }
});

test('账龄边界与到期提醒分开，期初无账期单按单据日归档', () => {
  const s = new Store(':memory:');
  try {
    setup(s);
    const parties = new FinanceParties(s);
    for (const [i, date] of ['2026-01-01', '2026-01-02', '2026-01-31'].entries())
      parties.create(maker, {
        requestId: 'ar-' + i,
        kind: 'receivable',
        partyId: 1,
        date,
        amount: 100,
        description: '虚构账龄',
        counterAccount: '5001',
      });
    post(s);
    const aging = parties.aging(maker, { kind: 'receivable', date: '2026-02-01' });
    assert.deepEqual(
      aging.totals.map((r) => [r.bucket, r.count]),
      [
        [1, 2],
        [2, 1],
      ],
    );
    assert.equal(
      parties.aging(maker, { kind: 'receivable', date: '2026-02-01', overdue: '1' })
        .filteredRecords,
      0,
    );
  } finally {
    s.close();
  }
});
