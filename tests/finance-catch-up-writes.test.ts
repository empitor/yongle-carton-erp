// 补扫没成功时拦哪些财务写入（server/finance/sync-health.ts）：要按来源单据状态核对的（核销、关联和确认发票、票据冲往来、
// 业务单据财务事件的补资料、批量补税率、生成凭证、红字冲销并重做、核对无误）拦下，和来源单据无关的（登记收付款、
// 不核销的确认收付款、登记发票、改往来条款）照常；补扫好了就放开（全部是虚构数据，只用内存库）
import '../server/flow/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { AppError } from '../server/core/index.js';
import { catchUp } from '../server/finance/catch-up.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceInvoiceConfirm } from '../server/finance/invoice-confirm.js';
import { FinanceInvoices } from '../server/finance/invoices.js';
import { FinanceNotes } from '../server/finance/notes.js';
import { FinanceParties } from '../server/finance/parties.js';
import type { FinanceSettlements } from '../server/finance/settlements.js';
import { quietLog } from './finance-catch-up-fixture.js';
import { bill, deliveryDoc, event, maker, newSettings, obligation, physical } from './finance-fixture.js';

/** 拦下的样子：503，说要核对业务单据的操作先不能做 */
const blocked = (e: unknown) => e instanceof AppError && e.status === 503 && /核对业务单据/.test(e.message);

/**
 * 财务启用、送货 1（没写税率：资料待补，挂一笔暂估应收）和送货 2（可记账）同步过，送货 1 的暂估应收先挂上一张待确认发票；
 * 然后把送货 2 那条事件的快照写坏、撤销送货 2：补扫没成功。返回各服务和要用的编号。
 */
function failedCatchUp() {
  const s = new Store(':memory:');
  const cash = newSettings(s);
  physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1', { taxed: false }));
  physical(s, 2, 'delivery', '2026-01-21', deliveryDoc('1'));
  catchUp(s, maker, quietLog);
  const invoices = new FinanceInvoices(s);
  const draft = invoices.create(maker, bill('sale', 'SALE-DRAFT'));
  const receivable = obligation(s, 1);
  invoices.link(maker, draft.id, { version: 1, requestId: 'link', links: [{ obligationId: receivable.id, amount: 10000 }] });
  const pending = event(s, 1),
    ready = event(s, 2);
  s.db.prepare(`UPDATE fin_events SET snapshot='{"doc":5}' WHERE id=?`).run(ready.id);
  s.db.prepare("UPDATE flow_documents SET status='reversed',version=version+1 WHERE id=2").run();
  assert.equal(catchUp(s, maker, quietLog).failed, true, '补扫没成功');
  return { s, cash, invoices, draft, receivable, pending, ready };
}

/** 登记一张收款（不核销），回它的编号 */
const receipt = (cash: FinanceSettlements, requestId: string) =>
  Number(
    cash.saveCash(maker, { requestId, kind: 'receipt', accountId: 1, partyId: 1, date: '2026-01-25', amount: 10000, method: '银行', description: '虚构收款' }).id,
  );

test('补扫没成功：要按来源单据状态核对的写入拦下（核销、关联和确认发票、票据冲往来、财务事件的处理）', () => {
  const f = failedCatchUp();
  try {
    const events = new FinanceEventHandling(f.s),
      vouchers = new FinanceEventVouchers(f.s),
      edit = { version: 1, requestId: 'write' };
    const allocation = { obligationId: f.receivable.id, version: f.receivable.version, amount: 10000 };
    const writes: [string, () => unknown][] = [
      ['核销', () => f.cash.confirm(maker, receipt(f.cash, 'cash-allocate'), { ...edit, allocations: [allocation] })],
      ['关联发票', () => f.invoices.link(maker, f.draft.id, { ...edit, version: 2, links: [{ obligationId: f.receivable.id, amount: 10000 }] })],
      ['确认发票', () => new FinanceInvoiceConfirm(f.s).confirm(maker, f.draft.id, { ...edit, version: 2 })],
      ['票据冲往来', () => new FinanceNotes(f.s).add(maker, { requestId: 'note', kind: 'receivable', partyId: 1, number: '虚构票', bank: '虚构银行', date: '2026-01-25', dueDate: '2026-07-31', amount: 10000 })],
      ['补资料', () => events.resolve(maker, f.pending.id, {})],
      ['批量补税率', () => events.resolveBatch(maker, {})],
      ['生成凭证', () => vouchers.generate(maker, f.ready.id, edit)],
      ['红字冲销并重做', () => events.correct(maker, f.ready.id, edit)],
      ['核对无误', () => events.acknowledgeStatisticalCorrection(maker, f.ready.id, edit)],
    ];
    for (const [what, write] of writes) assert.throws(write, blocked, what);
  } finally {
    f.s.close();
  }
});

test('补扫没成功：和来源单据无关的写入照常（登记收付款、不核销的确认收付款、登记发票、改往来条款）；补扫好了核销也放开', () => {
  const f = failedCatchUp();
  try {
    const id = receipt(f.cash, 'cash-plain');
    assert.equal(f.cash.confirm(maker, id, { version: 1, requestId: 'confirm-plain', allocations: [] }).status, 'confirmed', '不核销的确认照常');
    assert.ok(f.invoices.create(maker, bill('sale', 'SALE-NEW')), '登记发票照常');
    const terms = { kind: 'customer', partyId: 1, termDays: 30, requestId: 'terms' };
    assert.ok(new FinanceParties(f.s).saveTerms(maker, terms), '改往来条款照常');
    f.s.db.prepare('UPDATE fin_events SET snapshot=? WHERE id=?').run(f.ready.snapshot, f.ready.id);
    assert.equal(catchUp(f.s, maker, quietLog).failed, false, '补扫好了');
    const allocation = { obligationId: f.receivable.id, version: f.receivable.version, amount: 10000 };
    f.cash.confirm(maker, receipt(f.cash, 'cash-after'), { version: 1, requestId: 'confirm-after', allocations: [allocation] });
  } finally {
    f.s.close();
  }
});
