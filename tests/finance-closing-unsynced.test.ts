// 结账检查数“还没同步的业务单据”：截至月底财务还没扫到的来源都拦，已确认的、内容变了的、已撤销、被更正替代、已删除的都算
// （全部是虚构数据，只用内存库）
import '../server/flow/index.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FinanceEvents } from '../server/finance/events/events.js';
import { FinanceEventVouchers } from '../server/finance/events/event-voucher.js';
import { deliveryDoc, event, eventsStep, maker, newSettings, physical, postDrafts } from './finance-fixture.js';
import { flowFinance } from './finance-flow-fixture.js';
import { businessChanges } from './business-changes-fixture.js';

test('已记账的送货单撤销后、还没补扫：结账检查拦下；补扫后照“有差异”拦，红冲重做后放行', async () => {
  const t = await flowFinance();
  try {
    const shipped = t.deliver('10');
    t.sync();
    t.book(shipped.id, true);
    assert.equal(t.closingOk(), true, '记账后放行');
    t.reverse(shipped.id);
    assert.equal(t.closingOk(), false, '财务还没看到撤销，不能结账');
    t.sync();
    assert.equal(t.current(shipped.id).status, 'difference');
    assert.equal(t.closingOk(), false);
    t.correctAll(shipped.id);
    assert.equal(t.closingOk(), true);
  } finally {
    t.f.store.close();
  }
});

test('被更正替代的到货单还没补扫：结账检查拦下，补扫并红冲重做后放行', async () => {
  const t = await flowFinance();
  try {
    const arrival = t.receive('100', '虚构供应商单号-甲');
    t.sync();
    t.book(arrival.id, true);
    assert.equal(t.closingOk(), true);
    t.correctArrival(arrival.id, '80');
    // 看下一个月：原单（已被替代）、替代单都是 10 月的，都还没扫到
    assert.deepEqual(eventsStep(t.f.store, '2026-11'), { key: 'events', ok: false, count: 2, blocking: true });
    t.sync();
    t.correctAll(arrival.id, 'arrival');
    const replacement = Number(t.f.flow.get(arrival.id).replacedBy);
    t.correctAll(replacement, 'arrival');
    postDrafts(t.f.store);
    assert.equal(t.closingOk(), true);
  } finally {
    t.f.store.close();
  }
});

test('上个月已记账的送货单内容变了（数量被直接改了）、还没补扫：结下个月也拦下，补扫后按“有差异”拦', async () => {
  const t = await flowFinance();
  try {
    const shipped = t.deliver('10');
    t.sync();
    t.book(shipped.id, true);
    assert.equal(eventsStep(t.f.store, '2026-11').ok, true);
    t.tamperQuantity(shipped.id, '8');
    assert.deepEqual(eventsStep(t.f.store, '2026-11'), { key: 'events', ok: false, count: 1, blocking: true });
    t.sync();
    assert.equal(t.current(shipped.id).status, 'difference');
    assert.deepEqual(eventsStep(t.f.store, '2026-11'), { key: 'events', ok: false, count: 1, blocking: true });
  } finally {
    t.f.store.close();
  }
});

test('已记账的送货单被删除、还没补扫：结账检查拦下；补扫后记“来源已删除”照样拦', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    new FinanceEvents(s).sync(maker);
    const e = event(s, 1);
    new FinanceEventVouchers(s).generate(maker, e.id, { version: e.version, requestId: randomUUID() });
    postDrafts(s);
    assert.equal(eventsStep(s).ok, true);
    businessChanges(s).remove(1);
    assert.equal(eventsStep(s).ok, false, '财务还没看到删除，不能结账');
    assert.equal(eventsStep(s, '2025-12').ok, true, '单据日期以前的月份不受影响');
    new FinanceEvents(s).sync(maker);
    assert.equal(event(s, 1).status, 'source_deleted');
    assert.deepEqual(eventsStep(s), { key: 'events', ok: false, count: 1, blocking: true }, '补扫后只按“来源已删除”数一次');
  } finally {
    s.close();
  }
});
