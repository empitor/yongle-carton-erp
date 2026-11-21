import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FinanceParties } from '../server/finance/parties.js';
import { FinanceReports } from '../server/finance/reports.js';
import { FinanceDue } from '../server/finance/due.js';
import { FinanceNotes } from '../server/finance/notes.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { maker, newSettings, postDrafts as postAll, physical, deliveryDoc } from './finance-fixture.js';
import { businessChanges } from './business-changes-fixture.js';
import { FinanceStatements } from '../server/finance/statements.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { FinanceAllocations } from '../server/finance/allocations.js';
import { one, rows } from '../server/core/index.js';

/** 承兑汇票：收票、开票、背书、退票都要在往来上留核销，往来明细、账龄、到期、收付计划和总账一致。全部虚构数据。 */

function fixture() {
  const s = new Store(':memory:');
  const funds = newSettings(s);
  const postDrafts = () => postAll(s);
  const parties = new FinanceParties(s);
  let serial = 0;
  const owe = (kind: 'receivable' | 'payable', date: string, amount: number) => {
    serial++;
    const created = parties.create(maker, {
      requestId: 'owe-' + serial,
      kind,
      partyId: 1,
      date,
      dueDate: date,
      amount,
      description: '虚构货款 ' + serial,
      counterAccount: kind === 'receivable' ? '5001' : '1403',
    });
    postDrafts();
    return Number(created.id);
  };
  const notes = new FinanceNotes(s);
  const note = (kind: 'receivable' | 'payable', number: string, date: string, amount: number) => {
    const created = notes.add(maker, {
      requestId: 'note-' + number,
      kind,
      partyId: 1,
      number,
      bank: '虚构银行',
      date,
      dueDate: '2026-07-31',
      amount,
    });
    postDrafts();
    return created;
  };
  const listed = (kind: 'receivable' | 'payable') => parties.obligations(maker, { kind, pageSize: 200 }).rows;
  const balance = (id: number) => {
    const row = [...listed('receivable'), ...listed('payable')].find((r) => Number(r.id) === id);
    assert.ok(row, '往来 ' + id + ' 在逐笔里');
    return Number(row.balance);
  };
  const subledger = (kind: 'receivable' | 'payable') => listed(kind).reduce((n, r) => n + Number(r.balance), 0);
  /** 总账余额：应收、预付按借方，应付、预收按贷方 */
  const gl = (code: string, period = '2026-01') => {
    const ending = new FinanceReports(s)
      .balances(maker, period)
      .filter((r) => r.account_code.startsWith(code))
      .reduce((n, r) => n + r.ending, 0);
    return (['2202', '2203', '2201'].includes(code) ? -ending : ending) || 0;
  };
  return { s, notes, note, owe, balance, subledger, gl, postDrafts, parties, funds };
}

test('收到承兑汇票：按到期先后冲应收，往来、账龄、到期提醒、收付计划、核销建议和总账一致；退票逐笔冲回', () => {
  const f = fixture();
  try {
    const first = f.owe('receivable', '2026-01-05', 60000);
    const second = f.owe('receivable', '2026-01-08', 40000);
    const held = f.note('receivable', 'N-001', '2026-01-10', 80000);
    assert.equal(f.balance(first), 0, '先到期的冲完');
    assert.equal(f.balance(second), 20000, '后到期的冲 200 元');
    assert.equal(f.subledger('receivable'), 20000);
    assert.equal(f.gl('1122'), 20000, '往来和总账一致');
    const aging = new FinanceParties(f.s).aging(maker, { kind: 'receivable', date: '2026-01-31' });
    assert.equal(aging.rows.reduce((n, r) => n + Number(r.balance), 0), 20000, '账龄按冲后余额');
    const due = new FinanceDue(f.s);
    assert.equal(Number(due.held(maker, { kind: 'receivable', date: '2026-01-31' }).rows[0].due), 20000);
    assert.equal(
      due.soon(maker, { date: '2026-01-31', days: 0 }).rows.reduce((n, r) => n + Number(r.balance), 0),
      20000,
      '到期提醒不再显示已收票的',
    );
    assert.equal(
      due.plan(maker, { date: '2026-01-31', months: 3 }).forecast.reduce((n, r) => n + Number(r.receivable), 0),
      20000,
    );
    const receipt = f.funds.saveCash(maker, {
      requestId: 'cash',
      kind: 'receipt',
      accountId: 1,
      partyId: 1,
      date: '2026-01-20',
      amount: 50000,
      method: '银行',
      description: '虚构收款',
    });
    const suggested = new FinanceAllocations(f.s).suggest(maker, receipt.id, {}).allocations;
    assert.deepEqual(
      suggested.map((a) => [a.obligationId, a.balance]),
      [[second, 20000]],
      '核销建议只剩没冲完的那笔',
    );
    // 退票：收票时冲掉的两笔逐笔冲回
    f.notes.change(maker, held.id, {
      requestId: 'return',
      version: Number(held.version),
      status: 'returned',
      date: '2026-01-25',
      reason: '虚构退票',
    });
    f.postDrafts();
    assert.equal(f.balance(first), 60000);
    assert.equal(f.balance(second), 40000);
    assert.equal(f.gl('1122'), 100000);
    assert.equal(f.subledger('receivable'), f.gl('1122'));
  } finally {
    f.s.close();
  }
});

test('票据金额大于欠款：多出的记预收，以后有了新欠款再“核销到欠款”；退票时预收一起转回', () => {
  const f = fixture();
  try {
    const first = f.owe('receivable', '2026-01-05', 30000);
    const held = f.note('receivable', 'N-002', '2026-01-10', 50000);
    assert.equal(f.balance(first), 0);
    assert.equal(f.gl('1122'), 0);
    assert.equal(f.gl('2203'), 20000, '多出的 200 元记预收');
    const listed = f.notes.list(maker, {}).rows[0];
    assert.equal(Number(listed.unsettled_cents), 20000);
    assert.throws(
      () => f.notes.allocate(maker, held.id, { requestId: 'early', version: Number(listed.version), date: '2026-01-11' }),
      /没有未结清的欠款/,
    );
    const later = f.owe('receivable', '2026-01-15', 50000);
    f.notes.allocate(maker, held.id, { requestId: 'apply', version: Number(listed.version), date: '2026-01-16' });
    f.postDrafts();
    assert.equal(f.balance(later), 30000);
    assert.equal(f.gl('2203'), 0, '预收冲到新欠款上');
    assert.equal(f.gl('1122'), 30000);
    assert.equal(f.subledger('receivable'), f.gl('1122'));
    assert.equal(Number(f.notes.list(maker, {}).rows[0].unsettled_cents), 0);
    const current = f.notes.list(maker, {}).rows[0];
    f.notes.change(maker, held.id, {
      requestId: 'return',
      version: Number(current.version),
      status: 'returned',
      date: '2026-01-25',
      reason: '虚构退票',
    });
    f.postDrafts();
    assert.equal(f.balance(first), 30000);
    assert.equal(f.balance(later), 50000);
    assert.equal(f.gl('1122'), 80000);
    assert.equal(f.gl('2203'), 0);
    assert.equal(f.gl('1121'), 0, '应收票据冲平');
  } finally {
    f.s.close();
  }
});

test('应收票据背书给供应商、开出应付票据：冲供应商应付，往来和总账一致', () => {
  const f = fixture();
  try {
    const sale = f.owe('receivable', '2026-01-05', 80000);
    const bought = f.owe('payable', '2026-01-06', 50000);
    const other = f.owe('payable', '2026-01-07', 70000);
    const held = f.note('receivable', 'N-003', '2026-01-10', 80000);
    assert.equal(f.balance(sale), 0);
    f.notes.change(maker, held.id, {
      requestId: 'endorse',
      version: Number(held.version),
      status: 'endorsed',
      date: '2026-01-12',
      reason: '虚构背书',
      counterPartyId: 1,
    });
    f.postDrafts();
    assert.equal(f.balance(bought), 0, '背书冲掉先到期的应付');
    assert.equal(f.balance(other), 40000);
    assert.equal(f.subledger('payable'), 40000);
    assert.equal(f.gl('2202'), 40000);
    // 开出应付票据，冲剩下的应付
    f.note('payable', 'P-001', '2026-01-15', 40000);
    assert.equal(f.balance(other), 0);
    assert.equal(f.subledger('payable'), 0);
    assert.equal(f.gl('2202'), 0);
    assert.equal(f.gl('2201'), 40000, '应付票据挂账');
    const statement = new FinanceStatements(f.s).statement(maker, { kind: 'payable', partyId: '1', from: '2026-01-01', to: '2026-01-31' });
    assert.equal(statement.closing, 0, '对账单和往来一致');
  } finally {
    f.s.close();
  }
});

test('票据冲过的送货被冲销：更正不被票据核销挡住，票据的钱转回预收，以后再核销到新欠款', () => {
  const f = fixture();
  try {
    const events = new FinanceEvents(f.s);
    physical(f.s, 1, 'delivery', '2026-01-05', deliveryDoc('1', { price: '500.00', line: { unit: '只' } }));
    events.sync(maker);
    const source = () => {
      const row = one(
        f.s.db,
        rows.fin_events,
        `SELECT e.* FROM fin_events e JOIN fin_source_observations x ON x.event_id=e.id
          WHERE x.source_kind='delivery' AND x.source_id='1'`,
      );
      assert.ok(row, '送货单 1 有财务事件');
      return row;
    };
    new FinanceEventVouchers(f.s).generate(maker, source().id, { version: Number(source().version), requestId: 'generate' });
    f.postDrafts();
    const sale = Number(f.s.db.prepare("SELECT id FROM fin_obligations WHERE kind='receivable'").get()?.id);
    const held = f.note('receivable', 'N-004', '2026-01-10', 50000);
    assert.equal(f.balance(sale), 0);
    f.notes.change(maker, held.id, {
      requestId: 'mature',
      version: Number(held.version),
      status: 'matured',
      date: '2026-01-20',
      reason: '虚构到期承兑',
      accountId: 1,
    });
    f.postDrafts();
    // 送货冲销后做来源更正：以前会报“请先撤销并记账该往来单的核销”，票据核销又没有撤销入口
    businessChanges(f.s).reverse(1);
    events.sync(maker);
    const changed = source();
    assert.equal(changed.status, 'difference');
    new FinanceEventHandling(f.s).correct(maker, changed.id, {
      version: Number(changed.version),
      requestId: 'correct',
      date: '2026-01-25',
      reason: '虚构送货冲销',
    });
    f.postDrafts();
    assert.equal(f.gl('1122'), 0, '应收冲平');
    assert.equal(f.gl('2203'), 50000, '票据的钱转回预收');
    assert.equal(f.subledger('receivable'), f.gl('1122'));
    assert.equal(Number(f.notes.list(maker, {}).rows[0].unsettled_cents), 50000);
    assert.equal(
      new FinanceClosing(f.s).check(maker, { period: '2026-01' }).steps.find((x) => x.key === 'events')?.ok,
      true,
      '结账的事件步骤放行',
    );
    const again = f.owe('receivable', '2026-01-26', 30000);
    const listed = f.notes.list(maker, {}).rows[0];
    f.notes.allocate(maker, held.id, { requestId: 'apply', version: Number(listed.version), date: '2026-01-27' });
    f.postDrafts();
    assert.equal(f.balance(again), 0);
    assert.equal(f.gl('2203'), 20000);
  } finally {
    f.s.close();
  }
});

test('核销到欠款指定了哪几笔：只冲指定的那边，不按先后把两边都冲了；不属于这张票的直接报错', () => {
  const f = fixture();
  try {
    const held = f.note('receivable', 'N-005', '2026-01-10', 50000);
    f.notes.change(maker, held.id, {
      requestId: 'endorse',
      version: Number(held.version),
      status: 'endorsed',
      date: '2026-01-12',
      reason: '虚构背书',
      counterPartyId: 1,
    });
    f.postDrafts();
    assert.equal(f.gl('2203'), 50000, '客户那边记预收');
    assert.equal(f.gl('1123'), 50000, '供应商那边记预付');
    const sale = f.owe('receivable', '2026-01-15', 30000);
    const bought = f.owe('payable', '2026-01-15', 30000);
    const version = () => Number(f.notes.list(maker, {}).rows[0].version);
    assert.throws(
      () =>
        f.notes.allocate(maker, held.id, {
          requestId: 'wrong',
          version: version(),
          date: '2026-01-16',
          allocations: [{ obligationId: 999, amount: 100 }],
        }),
      /不属于这张票据/,
    );
    f.notes.allocate(maker, held.id, {
      requestId: 'pick',
      version: version(),
      date: '2026-01-16',
      allocations: [{ obligationId: sale, amount: 100 }],
    });
    f.postDrafts();
    assert.equal(f.balance(sale), 29900, '只冲指定的 1 元');
    assert.equal(f.balance(bought), 30000, '供应商那边没动');
    assert.equal(f.gl('1123'), 50000);
  } finally {
    f.s.close();
  }
});

test('对账单：没核销到欠款、记在预收的承兑票据，和没核销的收款一样带“（预收款）”', () => {
  const f = fixture();
  try {
    f.note('receivable', 'N-ADV', '2026-01-10', 50000);
    assert.equal(f.gl('2203'), 50000, '没有欠款可冲，整张记预收');
    const statement = new FinanceStatements(f.s).statement(maker, { kind: 'receivable', partyId: '1', from: '2026-01-01', to: '2026-01-31' });
    const row = statement.items.find((r) => r.date === '2026-01-10');
    assert.ok(row, '对账单里有 1 月 10 日收票那行');
    assert.equal(row.description, '承兑票据 N-ADV（预收款）');
    assert.equal(Number(row.delta), -50000);
    assert.equal(statement.advance, 50000);
  } finally {
    f.s.close();
  }
});
