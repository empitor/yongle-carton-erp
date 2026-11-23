// 凭证的规矩（server/finance/ledger.ts）：审核、记账要审核权限并记下经办人，版本对不上拒绝，作废的不能再动，
// 已结账期间的凭证不能往前走，红冲日期可以和原凭证同一天，资金科目要标现金流量。内存库、虚构数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FinanceLedger } from '../server/finance/ledger/ledger.js';
import { pageActor } from './actor-fixture.js';
import { approver, maker, newSettings, post } from './finance-fixture.js';

const clerk = pageActor({ id: 'fictional-clerk', name: '虚构会计', role: 'admin' as const, permissions: ['finance:view', 'finance:edit'] });
const voucher = {
  requestId: 'voucher',
  date: '2026-01-20',
  description: '虚构投入',
  entries: [
    { accountCode: '1002', debit: 110, credit: 0, cashFlow: '投入资本' },
    { accountCode: '3001', debit: 0, credit: 110 },
  ],
};

function setup() {
  const store = new Store(':memory:');
  newSettings(store);
  return { store, ledger: new FinanceLedger(store) };
}

test('只有制单权限的账号能制单、提交，不能审核、记账；审核、记账记下各自的经办人', () => {
  const { store, ledger } = setup();
  try {
    const id = Number(ledger.create(clerk, voucher).header.id);
    ledger.transition(clerk, id, 'submit', { version: 1, requestId: 'submit' });
    assert.throws(() => ledger.transition(clerk, id, 'approve', { version: 2, requestId: 'approve-clerk' }), /没有执行此操作的权限/);
    const approved = ledger.transition(approver, id, 'approve', { version: 2, requestId: 'approve' }).header;
    assert.deepEqual([approved.status, approved.approver_id, approved.poster_id], ['approved', approver.id, null]);
    assert.throws(() => ledger.transition(clerk, id, 'post', { version: 3, requestId: 'post-clerk' }), /没有执行此操作的权限/);
    const posted = ledger.transition(maker, id, 'post', { version: 3, requestId: 'post' }).header;
    assert.deepEqual([posted.status, posted.approver_id, posted.poster_id], ['posted', approver.id, maker.id]);
  } finally {
    store.close();
  }
});

test('版本号对不上的提交、红冲都拒绝，提示刷新', () => {
  const { store, ledger } = setup();
  try {
    const draft = Number(ledger.create(maker, voucher).header.id);
    assert.throws(() => ledger.transition(maker, draft, 'submit', { version: 9, requestId: 'stale-submit' }), /记录已更新，请刷新后重试/);
    const id = Number(ledger.create(maker, { ...voucher, requestId: 'posted' }).header.id);
    post(store, id);
    assert.throws(
      () => ledger.reverse(maker, id, { version: 3, requestId: 'stale-red', date: '2026-01-25', description: '虚构冲销' }),
      /记录已更新，请刷新后重试/,
    );
  } finally {
    store.close();
  }
});

test('作废的凭证不能再改、也不能再提交', () => {
  const { store, ledger } = setup();
  try {
    const id = Number(ledger.create(maker, voucher).header.id);
    ledger.transition(maker, id, 'void', { version: 1, requestId: 'void' });
    assert.throws(() => ledger.update(maker, id, { ...voucher, requestId: 'edit-void', version: 2 }), /凭证已作废/);
    assert.throws(() => ledger.transition(maker, id, 'submit', { version: 2, requestId: 'submit-void' }), /凭证已作废/);
  } finally {
    store.close();
  }
});

test('期间结账以后，那个月的凭证不能再提交', () => {
  const { store, ledger } = setup();
  try {
    const id = Number(ledger.create(maker, voucher).header.id);
    // 结账流程另有测试，这里直接把期间标成已结账
    store.db.prepare("UPDATE fin_periods SET status='closed' WHERE period='2026-01'").run();
    assert.throws(() => ledger.transition(maker, id, 'submit', { version: 1, requestId: 'submit-closed' }), /该会计期间已结账/);
  } finally {
    store.close();
  }
});

test('红冲日期可以和原凭证同一天', () => {
  const { store, ledger } = setup();
  try {
    const id = Number(ledger.create(maker, voucher).header.id);
    post(store, id);
    const red = ledger.reverse(maker, id, { version: 4, requestId: 'red', date: '2026-01-20', description: '虚构冲销' }).header;
    assert.deepEqual([red.reversal_of, red.date], [id, '2026-01-20']);
  } finally {
    store.close();
  }
});

test('资金科目没标现金流量项目的凭证拒收', () => {
  const { store, ledger } = setup();
  try {
    const [cash, capital] = voucher.entries;
    assert.throws(
      () => ledger.create(maker, { ...voucher, requestId: 'no-flow', entries: [{ ...cash, cashFlow: undefined }, capital] }),
      /现金与银行科目分录必须标记现金流量项目/,
    );
  } finally {
    store.close();
  }
});
