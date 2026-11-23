// 服务端补扫（server/finance/catch-up.ts）：坏单据逐条跳过、原处改好就补上，别的错不跳过；没有要补的不开写事务；
// 一次最多扫几批；已撤销送货的自动收尾；只读账号补扫记谁；助手查财务前补扫（全部是虚构数据，只用内存库）
import '../../server/flow/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Store, ProblemLog, count, many } from '../../server/core/index.js';
import { CATCH_UP_BATCHES, catchUp } from '../../server/finance/events/catch-up.js';
import { readFinanceTool } from '../../server/finance/index.js';
import { unseenSources } from '../../server/finance/events/events.js';
import { FinanceInvoices } from '../../server/finance/cash/invoices.js';
import { FinanceMonthly } from '../../server/finance/reports/monthly.js';
import { FinanceReports } from '../../server/finance/reports/reports.js';
import { pageActor } from '../support/actor-fixture.js';
import { catchUpProblems, quietLog, totalChanges, watchBegins } from './finance-catch-up-fixture.js';
import { bill, deliveryDoc, event, eventsStep, maker, newSettings, obligation, physical, setDoc } from './finance-fixture.js';
import { businessChanges } from '../support/business-changes-fixture.js';
import { flowFinance } from './finance-flow-fixture.js';

/** 只能看财务的账号（只有财务查看权限） */
const viewer = pageActor({ id: 'finance-viewer', name: '虚构只看财务', permissions: ['finance:view'] });
const auditActors = z.object({ actor_id: z.string(), action: z.string() });
const reversed = (s: Store, id: number) => businessChanges(s).reverse(id);

test('有一张单据内容读不出来：别的照样同步，读取照常回答，结账拦下并写明是哪张；出错记录只记一次，修好后再补上', () => {
  const s = new Store(':memory:'),
    log = new ProblemLog();
  try {
    newSettings(s);
    physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    physical(s, 2, 'delivery', '2026-01-21', deliveryDoc('2'));
    businessChanges(s).tamper('flow_documents', 2, '$.lines', '虚构的坏明细');
    assert.equal(catchUp(s, maker, log).failed, false);
    assert.equal(event(s, 1).source_id, '1', '好的那张照样同步');
    assert.equal(unseenSources(s.db, '2026-01-31'), 1, '坏的那张一直算还没同步');
    assert.ok(new FinanceMonthly(s).get(maker, { period: '2026-01' }), '月度台账照常回答');
    assert.equal(eventsStep(s).ok, false, '结账检查拦下');
    const reports = new FinanceReports(s);
    assert.deepEqual(reports.readiness(maker, { period: '2026-01' }).unsyncedSources, [
      { source_kind: 'delivery', source_id: '2', number: 'FICT-2' },
    ]);
    assert.throws(() => reports.assertReady(maker, '2026-01'), /FICT-2/, '拦下时写明是哪张');
    assert.deepEqual(catchUpProblems(log).map((m) => m.includes('FICT-2')), [true]);
    catchUp(s, maker, log);
    assert.equal(catchUpProblems(log).length, 1, '内容没变不重复记');
    setDoc(s, 2, '$.lines', deliveryDoc('2').lines);
    catchUp(s, maker, log);
    assert.equal(event(s, 2).source_id, '2', '改好（版本变了）以后下次补扫补上');
    assert.equal(unseenSources(s.db, '2026-01-31'), 0);
  } finally {
    s.close();
    log.close();
  }
});

test('坏单据在库里原处改好、版本号没变：下次补扫照样补上，不用重启', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    businessChanges(s).tamper('flow_documents', 1, '$.lines', '虚构的坏明细');
    catchUp(s, maker, quietLog);
    assert.equal(unseenSources(s.db, '2026-01-31'), 1);
    businessChanges(s).tamper('flow_documents', 1, '$.lines', deliveryDoc('1').lines);
    catchUp(s, maker, quietLog);
    assert.equal(unseenSources(s.db, '2026-01-31'), 0, '内容变了就再读');
    assert.equal(event(s, 1).source_id, '1');
  } finally {
    s.close();
  }
});

test('单据读得出来、后面财务自己的数据坏了：不当成坏单据跳过，记成补扫没成功，读照常、结账和正式报表拦下，好了就放开', () => {
  const s = new Store(':memory:'),
    log = new ProblemLog();
  try {
    newSettings(s);
    physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    catchUp(s, maker, log);
    const e = event(s, 1);
    s.db.prepare(`UPDATE fin_events SET snapshot='{"doc":5}' WHERE id=?`).run(e.id);
    reversed(s, 1);
    assert.deepEqual(catchUp(s, maker, log), { processed: 0, remaining: true, failed: true });
    const messages = catchUpProblems(log);
    assert.deepEqual(messages.map((m) => /没能同步/.test(m) && !/读不出来/.test(m)), [true], '记的是补扫没成功，不说单据读不出来');
    catchUp(s, maker, log);
    assert.equal(catchUpProblems(log).length, 1, '同一个原因只记一次');
    assert.ok(new FinanceMonthly(s).get(maker, { period: '2026-01' }), '读照常回答');
    assert.throws(() => new FinanceReports(s).assertReady(maker, '2026-01'), /没能同步/);
    assert.equal(eventsStep(s).ok, false);
    s.db.prepare('UPDATE fin_events SET snapshot=? WHERE id=?').run(e.snapshot, e.id);
    assert.equal(catchUp(s, maker, log).failed, false);
    assert.equal(event(s, 1).event_type, 'delivery.reversed', '好了以后补上');
  } finally {
    s.close();
    log.close();
  }
});

test('没有要补的：补扫只读，不开写事务；财务没启用时什么都不做', () => {
  const s = new Store(':memory:');
  const begun = watchBegins(s);
  try {
    physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    const before = totalChanges(s);
    assert.deepEqual(catchUp(s, maker, quietLog), { processed: 0, remaining: false, failed: false });
    assert.deepEqual([begun.length, totalChanges(s)], [0, before], '财务没启用');
    newSettings(s);
    assert.equal(catchUp(s, maker, quietLog).processed, 1);
    begun.length = 0;
    const synced = totalChanges(s);
    assert.deepEqual(catchUp(s, maker, quietLog), { processed: 0, remaining: false, failed: false });
    assert.deepEqual([begun.length, totalChanges(s)], [0, synced], '都同步过了');
  } finally {
    s.close();
  }
});

test('一次补扫最多扫几批，剩下的留给后面的请求接着扫（大批历史单据不占住服务）', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const batches = CATCH_UP_BATCHES * 100 + 1;
    for (let id = 1; id <= batches; id++) physical(s, id, 'delivery', '2025-12-20', deliveryDoc('1'));
    assert.deepEqual(catchUp(s, maker, quietLog), { processed: 0, remaining: true, failed: false });
    assert.equal(unseenSources(s.db, '2025-12-31'), 1, '这次只扫了几批');
    assert.equal(catchUp(s, maker, quietLog).remaining, false);
    assert.equal(unseenSources(s.db, '2025-12-31'), 0, '下一次接着扫完');
  } finally {
    s.close();
  }
});

test('已撤销送货原来挂的发票关联改掉以后：不用别的单据变化，下次补扫就自动收尾', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1', { taxed: false }));
    physical(s, 2, 'delivery', '2026-01-21', deliveryDoc('1', { taxed: false }));
    catchUp(s, maker, quietLog);
    const invoices = new FinanceInvoices(s);
    const draft = invoices.create(maker, bill('sale', 'SALE-DRAFT'));
    invoices.link(maker, draft.id, { version: 1, requestId: 'link', links: [{ obligationId: obligation(s, 1).id, amount: 10000 }] });
    reversed(s, 1);
    catchUp(s, maker, quietLog);
    assert.equal(event(s, 1).status, 'difference', '挂着发票关联，不自动收尾');
    invoices.link(maker, draft.id, { version: 2, requestId: 'relink', links: [{ obligationId: obligation(s, 2).id, amount: 10000 }] });
    catchUp(s, maker, quietLog);
    assert.equal(event(s, 1).status, 'corrected');
  } finally {
    s.close();
  }
});

test('只能看财务的账号发起读取：补扫照样做，审计记发起读取的人，不多做别的写入；没有财务权限的什么都不做', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    const vouchers = count(s.db, 'SELECT count(*) FROM fin_vouchers');
    const before = totalChanges(s);
    const outsider = pageActor({ id: 'outsider', name: '虚构业务员', permissions: ['business:edit'] });
    assert.throws(() => catchUp(s, outsider, quietLog), /权限/);
    assert.equal(totalChanges(s), before, '没有财务权限的不补扫');
    catchUp(s, viewer, quietLog);
    const e = event(s, 1);
    const audits = many(s.db, auditActors, "SELECT actor_id,action FROM business_audit WHERE entity='fin_events' AND record_id=?", e.id);
    assert.deepEqual(audits, [{ actor_id: viewer.id, action: 'sync' }]);
    assert.equal(count(s.db, 'SELECT count(*) FROM fin_vouchers'), vouchers, '补扫不出凭证');
  } finally {
    s.close();
  }
});

test('业务撤销以后不手动补扫，助手查月度经营就先补扫：事件已经是新的', async () => {
  const t = await flowFinance();
  try {
    const shipped = t.deliver('10');
    t.sync();
    assert.equal(t.current(shipped.id).event_type, 'delivery.confirmed');
    t.reverse(shipped.id);
    readFinanceTool(t.f.store, viewer, 'finance.monthly', { period: '2026-10' }, quietLog);
    assert.equal(t.current(shipped.id).event_type, 'delivery.reversed', '查之前已同步了撤销');
  } finally {
    t.f.store.close();
  }
});
