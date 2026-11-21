// 补扫里的采购退货暂估（server/finance/catch-up.ts、return-estimates.ts）：退货单内容坏了逐张跳过，
// 这次记不了的退货不算“有要补的”（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProblemLog, count } from '../server/core/index.js';
import { catchUp } from '../server/finance/catch-up.js';
import { FinanceInvoiceConfirm } from '../server/finance/invoice-confirm.js';
import { returnFixture } from './finance-costing-fixture.js';
import { catchUpProblems, totalChanges, watchBegins } from './finance-catch-up-fixture.js';
import { bill, maker, postDrafts } from './finance-fixture.js';

type Returns = ReturnType<typeof returnFixture>;
/** 退 3 张这批到货 */
const giveBack = (f: Returns, requestId: string) =>
  f.returns.create(maker, { arrivalId: f.received.id, date: '2026-02-08', reason: '虚构质量问题', requestId, lines: [{ lineIndex: 0, quantity: '3' }] });
const returnVouchers = (f: Returns) => count(f.s.db, "SELECT count(*) FROM fin_vouchers WHERE module_source='purchase_return'");

test('有一张采购退货单内容坏了：逐张跳过、记进出错记录，补扫照常、别的退货照样冲暂估', () => {
  const f = returnFixture(),
    log = new ProblemLog();
  try {
    const bad = giveBack(f, 'return-bad');
    giveBack(f, 'return-good');
    f.s.db.prepare("UPDATE purchase_returns SET document=json_set(document,'$.lines','虚构的坏明细') WHERE id=?").run(bad.id);
    assert.equal(catchUp(f.s, maker, log).failed, false, '补扫照常，读请求照常回答');
    assert.equal(returnVouchers(f), 2, '好的那张红冲原暂估、另出一张');
    assert.deepEqual(catchUpProblems(log).map((m) => m.includes(bad.number)), [true], '坏的那张记一次，写明单号');
  } finally {
    f.s.close();
    log.close();
  }
});

test('这次记不了的退货（到货已经确认过发票）：不算有要补的，补扫只读，不开写事务', () => {
  const f = returnFixture();
  try {
    const invoices = f.invoices.create(maker, bill('purchase', 'FULL', { date: '2026-02-06' }));
    f.invoices.link(maker, invoices.id, { version: 1, requestId: 'link', links: [{ obligationId: f.payable, amount: 10000 }] });
    new FinanceInvoiceConfirm(f.s).confirm(maker, invoices.id, { version: 2, requestId: 'confirm' });
    postDrafts(f.s);
    giveBack(f, 'return-after-invoice');
    catchUp(f.s, maker, undefined);
    const begun = watchBegins(f.s),
      before = totalChanges(f.s);
    assert.deepEqual(catchUp(f.s, maker, undefined), { processed: 0, remaining: false, failed: false });
    assert.deepEqual([begun.length, totalChanges(f.s)], [0, before]);
    assert.equal(returnVouchers(f), 0, '已到票的退货等红票，不冲暂估');
  } finally {
    f.s.close();
  }
});
