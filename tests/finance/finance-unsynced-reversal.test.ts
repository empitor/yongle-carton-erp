// 单据撤销了、还没补扫进财务时（补扫一次最多几批没扫到、内容读不出来被跳过），财务看来源状态的地方照样按撤销算
// （server/finance/source-scan.ts 的 sourceIs）：只读页面和补扫完一样，写入照样拦下。全部是虚构数据，只用内存库。
import '../../server/flow/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../../server/core/index.js';
import { FinanceClosing } from '../../server/finance/reports/closing.js';
import { FinanceEventViews } from '../../server/finance/events/event-views.js';
import { FinanceEvents } from '../../server/finance/events/events.js';
import { FinanceInvoices } from '../../server/finance/cash/invoices.js';
import { FinanceMonthly } from '../../server/finance/reports/monthly.js';
import { planSettlement } from '../../server/finance/cash/note-settlements.js';
import { allocationReversalMessage } from '../../server/finance/parties/obligation-sql.js';
import type { FinanceSettlements } from '../../server/finance/cash/settlements.js';
import { businessChanges } from '../support/business-changes-fixture.js';
import { arrivalDoc, bill, booked, deliveryDoc, event, maker, newSettings, obligation, physical } from './finance-fixture.js';

/** 月度台账里算理论收支的单据 */
const theoretical = (s: Store) =>
  new FinanceMonthly(s)
    .detail(maker, { period: '2026-01', pageSize: 200 })
    .rows.filter((r) => r.metric.startsWith('theoretical'))
    .map((r) => r.source_id)
    .sort();
/** 事件列表里送货 1、到货 2 的“红字冲销后会不会重做” */
const rebuilt = (s: Store) => {
  const listed = new FinanceEventViews(s).list(maker, { pageSize: 200 }).rows;
  return ['1', '2'].map((source) => listed.find((r) => r.source_id === source)?.rebuild);
};

type World = { s: Store; cash: FinanceSettlements; delivered: number; arrived: number };
/**
 * 记过账的送货 1（delivered 是它的应收往来）、到货 2（arrived 是应付往来），缺税率的送货 3（资料待补），都同步过；
 * 然后三张都撤销了，还没补扫，在这个库上跑 check。cash 是收付款服务。
 */
function inWorld(check: (w: World) => void) {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s);
    physical(s, 1, 'delivery', '2026-01-10', deliveryDoc('1'));
    booked(s, 1, 'delivery');
    physical(s, 2, 'arrival', '2026-01-11', arrivalDoc('10'));
    booked(s, 2, 'arrival');
    physical(s, 3, 'delivery', '2026-01-12', deliveryDoc('1', { taxed: false }));
    new FinanceEvents(s).sync(maker);
    assert.equal(event(s, 3, 'delivery').status, 'info_pending', '测试数据：送货 3 缺税率');
    assert.deepEqual(theoretical(s), ['1', '2', '3'], '测试数据：撤销前三张都算理论收支');
    assert.deepEqual(rebuilt(s), [1, 1], '测试数据：撤销前送货 1、到货 2 红冲后会重做');
    const delivered = Number(obligation(s, 1, 'delivery').id),
      arrived = Number(obligation(s, 2, 'arrival').id);
    for (const id of [1, 2, 3]) businessChanges(s).reverse(id);
    check({ s, cash, delivered, arrived });
  } finally {
    s.close();
  }
}

test('还没补扫时月度台账不列撤销了的送货、到货', () => {
  inWorld(({ s }) => assert.deepEqual(theoretical(s), []));
});

test('还没补扫时事件列表里撤销了的送货、到货红冲后不会重做', () => {
  inWorld(({ s }) => assert.deepEqual(rebuilt(s), [0, 0]));
});

test('还没补扫时票据冲往来不能冲撤销了的送货', () => {
  inWorld(({ s, delivered }) =>
    assert.throws(
      () => planSettlement(s.db, { side: 'receivable', partyId: '1', date: '2026-01-31', amount: 1e9, explicit: [{ obligationId: delivered, amount: 1 }] }),
      /不属于这个单位，或已经结清、尚未记账/,
    ),
  );
});

test('还没补扫时发票不能关联撤销了的到货', () => {
  inWorld(({ s, arrived }) => {
    const invoices = new FinanceInvoices(s);
    const draft = invoices.create(maker, bill('purchase', 'FP-虚构-1', { date: '2026-01-20', gross: 10000 }));
    assert.throws(
      () => invoices.link(maker, draft.id, { version: 1, requestId: 'link', links: [{ obligationId: arrived, amount: 10000 }] }),
      /已撤销或被更正替代，不能再关联发票/,
    );
  });
});

test('还没补扫时收款不能核销撤销了的送货', () => {
  inWorld(({ s, cash, delivered }) => {
    const receipt = cash.saveCash(maker, {
      requestId: 'cash',
      kind: 'receipt',
      accountId: 1,
      partyId: 1,
      date: '2026-01-20',
      amount: 100,
      method: '银行',
      description: '虚构收款',
    });
    const version = Number(obligation(s, 1, 'delivery').version);
    assert.throws(
      () => cash.confirm(maker, receipt.id, { version: 1, requestId: 'confirm', allocations: [{ obligationId: delivered, version, amount: 100 }] }),
      (e: unknown) => e instanceof Error && e.message === allocationReversalMessage,
    );
  });
});

test('还没补扫时结账检查：撤销了的缺税率送货只按“还没同步”算一次，不再当没处理完的事件重复算', () => {
  inWorld(({ s }) => {
    const step = new FinanceClosing(s).check(maker, { period: '2026-01' }).steps.find((x) => x.key === 'events');
    assert.deepEqual(step && 'count' in step ? [step.ok, step.count] : null, [false, 3], '三张撤销了还没补扫');
  });
});
