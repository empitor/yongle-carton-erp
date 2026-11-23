// 财务派生凭证的撤回（没记账）和红冲（已记账）：保证金、利息、坏账、资产处置、费用、票据（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { one, rows } from '../server/core/index.js';
import { FinanceLedger } from '../server/finance/ledger/ledger.js';
import { FinanceParties } from '../server/finance/parties/parties.js';
import { FinanceEvents } from '../server/finance/events/events.js';
import { FinanceMonthly } from '../server/finance/reports/monthly.js';
import { FinanceAssets } from '../server/finance/expenses/assets.js';
import { FinanceExpenses } from '../server/finance/expenses/expenses.js';
import { FinanceNotes } from '../server/finance/cash/notes.js';
import { FinanceDepositsInterest } from '../server/finance/parties/deposits-interest.js';
import { FinanceDerivedVouchers } from '../server/finance/ledger/derived-vouchers.js';
import { FinanceEventVouchers } from '../server/finance/events/event-voucher.js';
import { physical, deliveryDoc, maker, approver, newSettings, postDrafts, event, obligation } from './finance-fixture.js';
import { must } from './read-result.js';

/** 一张 100 元、已记账的应收（客户 1 压 20 天，按逾期年 36.5% 计息） */
function receivable(s: Store) {
  new FinanceParties(s).saveTerms(maker, {
    requestId: 'term',
    kind: 'customer',
    partyId: 1,
    termDays: 20,
    options: { deposits: true, interest: { rate: '36.5', unit: 'annual', basis: 'overdue', freeDays: 0 } },
  });
  physical(s, 1, 'delivery', '2026-01-01', deliveryDoc('1', { price: '100.00', taxed: false, line: { taxMode: '未税', taxRate: '0' } }));
  new FinanceEvents(s).sync(maker);
  new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
  postDrafts(s);
  return obligation(s, 1);
}
const latest = (s: Store, module: string) =>
  must(
    one(s.db, rows.fin_vouchers, 'SELECT * FROM fin_vouchers WHERE module_source=? AND reversal_of IS NULL ORDER BY id DESC', module),
    module + ' 生成的凭证',
  );
const voucherById = (s: Store, id: number | null) =>
  must(one(s.db, rows.fin_vouchers, 'SELECT * FROM fin_vouchers WHERE id=?', id), '凭证 ' + String(id));
const balanceOf = (s: Store, id: unknown) =>
  Number(
    must(
      new FinanceParties(s).obligations(maker, { kind: 'receivable' }).rows.find((r) => r.id === Number(id)),
      '应收 ' + String(id),
    ).balance,
  );

function undo(s: Store, v: { id: number; version: number }, how: 'withdraw' | 'reverse', tag: string) {
  const derived = new FinanceDerivedVouchers(s);
  const raw = { version: Number(v.version), requestId: tag, reason: '虚构撤错了' };
  return how === 'withdraw' ? derived.withdraw(maker, v.id, raw) : derived.reverse(maker, v.id, { ...raw, date: '2026-01-31' });
}

test('保证金：收保证金撤回；转抵红冲后往来和余额回去；收保证金有转抵时先拦，转抵红冲后可以红冲；凭证页不能直接作废', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const o = receivable(s);
    const term = new FinanceDepositsInterest(s);
    const deposit = (requestId: string) =>
      term.deposit(maker, { requestId, kind: 'received', partyKind: 'customer', partyId: 1, accountId: 1, date: '2026-01-03', amount: 1000, description: '虚构保证金' });
    const first = deposit('d1');
    const voucher = latest(s, 'deposit');
    assert.throws(
      () => new FinanceLedger(s).transition(maker, voucher.id, 'void', { version: Number(voucher.version), requestId: 'direct' }),
      /请到来源页面撤回/,
    );
    undo(s, voucher, 'withdraw', 'w1');
    const listed = (id: unknown) => must(term.deposits(maker, {}).rows.find((r) => r.id === id), '保证金 ' + String(id));
    assert.deepEqual([listed(first.id).balance, listed(first.id).voucher_state], [0, 'withdrawn']);
    const second = deposit('d2');
    postDrafts(s);
    term.depositAction(maker, second.id, { requestId: 'apply', version: 1, kind: 'apply', date: '2026-01-05', obligationId: o.id, amount: 300, reason: '虚构转抵' });
    postDrafts(s);
    assert.equal(balanceOf(s, o.id), 9700);
    const applied = listed(second.id).actions[0];
    assert.deepEqual([applied.kind, applied.voucher_id, applied.voucher_status, applied.voucher_state], ['apply', latest(s, 'deposit').id, 'posted', null], '转抵记录带凭证编号和状态');
    const main = voucherById(s, second.voucher_id);
    assert.throws(() => undo(s, main, 'reverse', 'r-main-early'), /已经有退回或转抵/);
    undo(s, latest(s, 'deposit'), 'reverse', 'r-apply');
    postDrafts(s);
    assert.equal(balanceOf(s, o.id), 10000, '转抵红冲，往来回到没抵之前');
    assert.equal(listed(second.id).balance, 1000);
    assert.equal(listed(second.id).actions[0].voucher_state, 'reversed');
    undo(s, voucherById(s, second.voucher_id), 'reverse', 'r-main');
    postDrafts(s);
    assert.deepEqual([listed(second.id).balance, listed(second.id).voucher_status, listed(second.id).voucher_state], [0, 'posted', 'reversed']);
    assert.equal(new FinanceMonthly(s).get(maker, { period: '2026-01' }).depositIncome, 0, '月度台账不算红冲掉的保证金');
  } finally {
    s.close();
  }
});

test('压款利息：确认后撤回，那几天可以重新确认；记账后红冲，利息往来成对冲掉', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const o = receivable(s);
    const term = new FinanceDepositsInterest(s);
    const confirm = (requestId: string) =>
      term.confirmInterest(maker, { period: '2026-01', obligationId: o.id, version: Number(obligation(s, 1).version), date: '2026-01-25', requestId });
    confirm('i1');
    undo(s, latest(s, 'interest'), 'withdraw', 'w');
    const row = () => term.interest(maker, { period: '2026-01', kind: 'receivable', date: '2026-01-25' }).rows[0];
    assert.deepEqual([row().confirmed_through, row().estimate?.days], [null, 4], '撤回后从头算');
    confirm('i2');
    postDrafts(s);
    const interestDebt = () =>
      new FinanceParties(s).obligations(maker, { kind: 'receivable' }).rows.filter((r) => r.description === '压款利息');
    assert.equal(interestDebt()[0].balance, 40);
    undo(s, latest(s, 'interest'), 'reverse', 'r');
    postDrafts(s);
    assert.equal(interestDebt()[0].balance, 0, '利息往来和冲销往来成对，余额 0');
    assert.equal(row().estimate?.days, 4, '红冲后那几天可以重新确认');
    assert.equal(new FinanceMonthly(s).get(maker, { period: '2026-01' }).interestIncome, 0);
  } finally {
    s.close();
  }
});

test('坏账：核销撤回、记账后红冲，往来余额都回去', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const o = receivable(s);
    const parties = new FinanceParties(s);
    const writeoff = (requestId: string) =>
      parties.badDebt(maker, o.id, { requestId, version: Number(obligation(s, 1).version), kind: 'writeoff', date: '2026-01-20', amount: 2000, reason: '虚构坏账' });
    writeoff('b1');
    assert.equal(balanceOf(s, o.id), 8000);
    const debtRow = () =>
      must(parties.obligations(maker, { kind: 'receivable' }).rows.find((r) => r.id === Number(o.id)), '应收 ' + o.id);
    assert.deepEqual([debtRow().bad_debt_voucher_id, debtRow().bad_debt_voucher_status, debtRow().bad_debt_voucher_state], [latest(s, 'bad_debt').id, 'draft', null]);
    undo(s, latest(s, 'bad_debt'), 'withdraw', 'w');
    assert.equal(balanceOf(s, o.id), 10000);
    assert.equal(debtRow().bad_debt_voucher_state, 'withdrawn');
    writeoff('b2');
    postDrafts(s);
    undo(s, latest(s, 'bad_debt'), 'reverse', 'r');
    assert.equal(balanceOf(s, o.id), 10000, '红字凭证没记账也算冲掉');
  } finally {
    s.close();
  }
});

test('资产处置：撤回、红冲后资产回到在用', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const assets = new FinanceAssets(s);
    const asset = assets.add(maker, {
      requestId: 'asset', number: 'FICT-ASSET', name: '虚构设备', category: '设备', original: 12000, date: '2026-01-05',
      months: 12, residualBp: 0, department: '虚构部门', expenseAccount: '560205', counterAccount: '1002', cashFlow: '购建固定资产支付的现金',
    });
    postDrafts(s);
    const status = () =>
      must(one(s.db, rows.fin_assets.pick({ status: true, version: true }), 'SELECT status,version FROM fin_assets WHERE id=?', asset.id), '资产 ' + asset.id);
    const dispose = (requestId: string) =>
      assets.dispose(maker, asset.id, { requestId, version: Number(status().version), date: '2026-01-20', reason: '虚构报废' });
    dispose('p1');
    const listed = () => must(assets.list(maker, {}).rows.find((r) => r.id === asset.id), '资产列表里的 ' + asset.id);
    assert.deepEqual([listed().disposal_voucher_id, listed().disposal_voucher_status], [latest(s, 'asset_disposal').id, 'draft'], '列表带处置凭证');
    undo(s, latest(s, 'asset_disposal'), 'withdraw', 'w');
    assert.equal(listed().disposal_voucher_state, 'withdrawn');
    assert.equal(status().status, 'active');
    dispose('p2');
    postDrafts(s);
    undo(s, latest(s, 'asset_disposal'), 'reverse', 'r');
    assert.equal(status().status, 'active');
  } finally {
    s.close();
  }
});

test('费用报销：审核出的凭证撤回、红冲后回到待审核，可以重新审核；已付款的先拦', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const expenses = new FinanceExpenses(s);
    const ex = expenses.save(maker, {
      requestId: 'expense', employeeId: 'e-1', employeeName: '虚构员工', department: '虚构部门',
      date: '2026-01-20', accountCode: '560201', amount: 400, description: '虚构办公费',
    });
    const state = () =>
      must(
        one(s.db, rows.fin_expenses.pick({ status: true, version: true, voucher_id: true }), 'SELECT status,version,voucher_id FROM fin_expenses WHERE id=?', ex.id),
        '报销单 ' + ex.id,
      );
    expenses.transition(maker, ex.id, { action: 'submit', version: 1, requestId: 'submit' });
    const approve = (requestId: string) => expenses.transition(approver, ex.id, { action: 'approve', version: Number(state().version), requestId });
    approve('a1');
    undo(s, latest(s, 'expense'), 'withdraw', 'w');
    assert.deepEqual([state().status, state().voucher_id], ['pending', null]);
    approve('a2');
    postDrafts(s);
    undo(s, latest(s, 'expense'), 'reverse', 'r');
    assert.equal(state().status, 'pending');
    approve('a3');
    postDrafts(s);
    expenses.transition(maker, ex.id, { action: 'pay', version: Number(state().version), date: '2026-01-21', accountId: 1, requestId: 'pay' });
    assert.throws(() => undo(s, latest(s, 'expense'), 'reverse', 'r2'), /已经付款/);
  } finally {
    s.close();
  }
});

test('承兑票据：到期收款的凭证撤回、红冲后票据回到持有；收票那张撤回、红冲后票据作废，先冲的往来回去', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    receivable(s);
    const notes = new FinanceNotes(s);
    const note = notes.add(maker, {
      requestId: 'note', kind: 'receivable', partyId: 1, number: 'FICT-NOTE', bank: '虚构银行', date: '2026-01-10', dueDate: '2026-01-25', amount: 10000,
    });
    postDrafts(s);
    const state = () =>
      must(
        one(s.db, rows.fin_notes.pick({ status: true, version: true, voucher_id: true }), 'SELECT status,version,voucher_id FROM fin_notes WHERE id=?', note.id),
        '票据 ' + note.id,
      );
    const collect = (requestId: string) =>
      notes.change(maker, note.id, { requestId, version: Number(state().version), status: 'matured', date: '2026-01-25', reason: '虚构到期收款', accountId: 1 });
    const added = state().voucher_id;
    collect('c1');
    const listedNote = () => must(notes.list(maker, {}).rows.find((r) => r.id === note.id), '票据列表里的 ' + note.id);
    assert.deepEqual([listedNote().change_voucher_id, listedNote().change_voucher_status], [latest(s, 'note').id, 'draft'], '列表带最近一次变更的凭证');
    undo(s, latest(s, 'note'), 'withdraw', 'w');
    assert.deepEqual([state().status, state().voucher_id], ['held', added]);
    assert.equal(listedNote().change_voucher_id, null, '撤回后回到持有，没有变更凭证');
    collect('c2');
    postDrafts(s);
    undo(s, latest(s, 'note'), 'reverse', 'r');
    assert.deepEqual([state().status, state().voucher_id], ['held', added]);
    // 收票那张：冲了应收 100，撤掉后应收回到 100，票据作废
    const debt = obligation(s, 1);
    assert.equal(balanceOf(s, debt.id), 0);
    undo(s, voucherById(s, added), 'reverse', 'r-add');
    postDrafts(s);
    assert.equal(state().status, 'cancelled');
    assert.equal(balanceOf(s, debt.id), 10000);
    // 没记账的收票直接撤回
    const second = notes.add(maker, {
      requestId: 'note-2', kind: 'receivable', partyId: 1, number: 'FICT-NOTE-2', bank: '虚构银行', date: '2026-01-11', dueDate: '2026-01-25', amount: 500,
    });
    undo(s, latest(s, 'note'), 'withdraw', 'w-add');
    assert.equal(s.db.prepare('SELECT status FROM fin_notes WHERE id=?').get(second.id)?.status, 'cancelled');
  } finally {
    s.close();
  }
});
