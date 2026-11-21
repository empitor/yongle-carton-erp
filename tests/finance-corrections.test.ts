import { pageActor } from './actor-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { maker, newSettings, postDrafts, physical } from './finance-fixture.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinanceParties } from '../server/finance/parties.js';
import { FinanceSettlements } from '../server/finance/settlements.js';
import { FinanceReports } from '../server/finance/reports.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { FinanceMonthly } from '../server/finance/monthly.js';
import { FinanceEventViews } from '../server/finance/event-views.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { FinanceCashAccounts } from '../server/finance/cash-accounts.js';
import { FinanceAllocations } from '../server/finance/allocations.js';

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
  postDrafts(s);
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

const cashier = pageActor({ id: 'cashier', name: '虚构出纳', permissions: ['finance:view', 'finance:cash'] });
/** 撤销资金单的审计内容里这次填的原因 */
const cancelAudit = z.object({ after: z.object({ reason: z.string() }) });
/** 月度台账里手工红冲那条明细：红冲凭证和它冲的原凭证 */
const reversalDetail = z.object({ voucherId: z.number(), reversalOf: z.number() });

for (const state of ['unposted', 'open', 'closed'] as const) {
  test('撤销资金单 ' + state + ' 保留凭证审计并冲减账户余额', () => {
    const s = new Store(':memory:');
    try {
      const cash = newSettings(s),
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
      if (state !== 'unposted') postDrafts(s);
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
        new FinanceCashAccounts(s).accounts(cashier, { date: payload.date }).rows[0].balance,
        state === 'unposted' ? 0 : 3000,
      );
      postDrafts(s);
      assert.equal(new FinanceCashAccounts(s).accounts(cashier, { date: payload.date }).rows[0].balance, 0);
      assert.equal(monthly.get(cashier, { period: '2026-02' }).actualExpense, 0);
      const ledger = new FinanceLedger(s);
      assert.equal(
        ledger.get(cashier, original.id).header.status,
        state === 'unposted' ? 'void' : 'posted',
      );
      if (state === 'closed')
        assert.equal(new FinanceCashAccounts(s).accounts(cashier, { date: '2026-01-31' }).rows[0].balance, 3000);
      const audit = s.db
        .prepare(
          "SELECT document FROM business_audit WHERE entity='fin_cash_documents' AND action='cancel'",
        )
        .get();
      assert.equal(cancelAudit.parse(JSON.parse(String(audit?.document))).after.reason, payload.reason);
    } finally {
      s.close();
    }
  });
}

test('资金单有核销时拦截，核销红冲记账后只冲减剩余资金凭证', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      saved = apply(s, cash);
    postDrafts(s);
    const payload = {
      version: 2,
      requestId: 'cancel',
      date: '2026-01-08',
      reason: '虚构撤销资金单',
    };
    assert.throws(() => cash.cancel(cashier, saved.id, payload), /先撤销核销/);
    new FinanceAllocations(s).revoke(maker, 1, {
      version: 1,
      requestId: 'revoke',
      date: '2026-01-07',
      reason: '虚构撤销核销',
    });
    assert.throws(() => cash.cancel(cashier, saved.id, { ...payload, version: 3 }), /先撤销核销/);
    postDrafts(s);
    const result = cash.cancel(cashier, saved.id, { ...payload, version: 3 });
    assert.equal(result.reversalVoucherIds.length, 2);
    postDrafts(s);
    assert.equal(new FinanceCashAccounts(s).accounts(cashier, { date: '2026-01-31' }).rows[0].balance, 0);
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
        const cash = newSettings(s),
          events = new FinanceEvents(s),
          reports = new FinanceReports(s),
          closing = new FinanceClosing(s);
        const period = '2026-01',
          date = period + '-10';
        const doc = {
          customerId: 1,
          customerName: '虚构客户',
          lines: [{ orderId: 1, orderLineId: 1, stockId: 2, unit: '个', quantity: '1', unitPriceExact: '100.0000' }],
        };
        physical(s, 1, 'delivery', date, doc);
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
        postDrafts(s);
        s.db.exec("UPDATE flow_documents SET status='reversed',version=2 WHERE id=1");
        assert.match(String(reports.readiness(maker, { period }).rows[0].problem), /先撤销核销/);
        if (syncBeforeRevoke) {
          events.sync(maker, { requestId: 're-scan' });
          assert.equal(new FinanceEventViews(s).list(maker, { status: 'info_pending' }).filteredRecords, 0);
          assert.equal(
            new FinanceEventViews(s).list(maker, { status: 'awaiting_allocation_reversal' }).filteredRecords,
            1,
          );
        }
        assert.deepEqual(reports.readiness(maker, { period }).rows[0].missing, [
          'allocation_reversal',
        ]);
        assert.throws(() => reports.get(maker, 'balance', { period }), /先撤销核销/);
        assert.equal(closing.check(maker, { period }).steps[0].ok, false);
        new FinanceAllocations(s).revoke(maker, 1, {
          version: 1,
          requestId: 'revoke',
          date: '2026-01-12',
          reason: '虚构撤销',
        });
        assert.equal(reports.readiness(maker, { period }).ready, false);
        postDrafts(s);
        assert.equal(reports.readiness(maker, { period }).ready, syncBeforeRevoke, '撤销还没补扫进财务时报表也拦着');
        if (!syncBeforeRevoke) {
          assert.equal(closing.check(maker, { period }).steps[0].ok, false, '撤销还没补扫进财务，结账检查拦着');
          events.sync(maker, { requestId: 're-scan' });
          assert.equal(reports.readiness(maker, { period }).ready, true);
        }
        assert.equal(closing.check(maker, { period }).steps[0].ok, true);
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
    newSettings(s);
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
      postDrafts(s);
      const reversal = ledger.reverse(maker, voucher.header.id, {
        version: 4,
        requestId: 'red-' + metric,
        date: period + '-06',
        description: '虚构手工红冲',
      });
      postDrafts(s);
      const detail = monthly.detail(maker, { period, metric, sort: 'oldest' }).rows;
      assert.deepEqual(
        detail.map((item) => item.amount),
        [amount, -amount],
      );
      const red = reversalDetail.parse(detail[1].detail);
      assert.equal(red.voucherId, reversal.header.id);
      assert.equal(red.reversalOf, voucher.header.id);
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
      const cash = newSettings(s),
        c = apply(s, cash);
      if (state !== 'unposted') postDrafts(s);
      if (state === 'closed')
        s.db.exec("UPDATE fin_periods SET status='closed' WHERE period='2026-01'");
      new FinanceAllocations(s).revoke(maker, 1, {
        version: 1,
        requestId: 'revoke',
        date: state === 'closed' ? '2026-02-01' : '2026-01-03',
        reason: '虚构撤销',
      });
      postDrafts(s);
      const original = s.db.prepare('SELECT * FROM fin_allocations WHERE id=1').get();
      assert.equal(original?.status, state === 'closed' ? 'active' : 'revoked');
      const red = s.db.prepare('SELECT * FROM fin_allocations WHERE reversal_of=1').get();
      assert.equal(red?.amount_cents, state === 'unposted' ? undefined : -4000);
      const ledger = s.db
        .prepare(
          "SELECT sum((e.debit-e.credit)*CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END) AS amount FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.status='posted' AND e.account_code='1002'",
        )
        .get();
      assert.equal(ledger?.amount, 6000);
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

/** 一张 100 元的送货单（单据 1）入账记账，再收 50 元核销到它的应收；返回单据内容、日期和那张凭证 */
function allocatedDelivery(s: Store) {
  const cash = newSettings(s),
    events = new FinanceEvents(s);
  const date = '2026-01-10';
  const doc = {
    customerId: 1,
    customerName: '虚构客户',
    lines: [
      { orderId: 1, orderLineId: 1, stockId: 2, unit: '个', quantity: '1', unitPriceExact: '100.0000', taxMode: '未税', taxRate: '0' },
    ],
  };
  physical(s, 1, 'delivery', date, doc);
  events.sync(maker, { requestId: 'scan' });
  const first = new FinanceEventViews(s).list(maker, {}).rows[0];
  const voucher = new FinanceEventVouchers(s).generate(maker, first.id, {
    version: 1,
    requestId: 'generate',
  }).voucher_id;
  postDrafts(s);
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
  postDrafts(s);
  return { events, doc, date, voucher };
}

test('来源更正先撤销核销，全额红冲重做保留旧凭证，物理删除标记事件', () => {
  const s = new Store(':memory:');
  try {
    const { events, doc, date, voucher } = allocatedDelivery(s);
    doc.lines[0].quantity = '2';
    s.db
      .prepare('UPDATE flow_documents SET document=?,version=2 WHERE id=1')
      .run(JSON.stringify({ ...doc, date, plannedDate: date }));
    events.sync(maker, { requestId: 're-scan' });
    const diff = new FinanceEventViews(s).list(maker, { status: 'difference' }).rows[0];
    assert.throws(
      () =>
        new FinanceEventHandling(s).correct(maker, diff.id, {
          version: 1,
          date: '2026-01-12',
          requestId: 'correct',
          reason: '虚构改数量',
        }),
      /先撤销/,
    );
    new FinanceAllocations(s).revoke(maker, 1, {
      version: 1,
      date: '2026-01-12',
      reason: '虚构撤销',
      requestId: 'revoke',
    });
    postDrafts(s);
    const replacement = new FinanceEventHandling(s).correct(maker, diff.id, {
      version: 1,
      date: '2026-01-13',
      requestId: 'correct',
      reason: '虚构改数量',
    });
    assert.equal(replacement.amount_cents, 20000);
    postDrafts(s);
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
    // 删除只管业务：财务下次补扫时才发现来源没了
    assert.equal(new FinanceEventViews(s).list(maker, { status: 'source_deleted' }).filteredRecords, 0);
    events.sync(maker, { requestId: 'after-delete' });
    assert.equal(new FinanceEventViews(s).list(maker, { status: 'source_deleted' }).rows[0].id, diff.id);
    assert.equal(
      s.db.prepare('SELECT status FROM fin_vouchers WHERE id=?').get(voucher)?.status,
      'posted',
    );
  } finally {
    s.close();
  }
});
