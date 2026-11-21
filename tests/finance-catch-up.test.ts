// 服务端补扫（server/finance/catch-up.ts）：坏单据逐条跳过、没有要补的不开写事务、只读账号补扫记谁、助手查财务前补扫
// （全部是虚构数据，只用内存库）
import '../server/flow/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { ProblemLog, count, many } from '../server/core/index.js';
import { catchUp } from '../server/finance/catch-up.js';
import { readFinanceTool } from '../server/finance/assistant.js';
import { unseenSources } from '../server/finance/events.js';
import { FinanceMonthly } from '../server/finance/monthly.js';
import { FinanceReports } from '../server/finance/reports.js';
import { pageActor } from './actor-fixture.js';
import { deliveryDoc, event, eventsStep, maker, newSettings, physical, setDoc } from './finance-fixture.js';
import { flowFinance } from './finance-flow-fixture.js';

/** 只能看财务的账号（只有财务查看权限） */
const viewer = pageActor({ id: 'finance-viewer', name: '虚构只看财务', permissions: ['finance:view'] });
const totalChanges = (s: Store) => count(s.db, 'SELECT total_changes()');
const auditActors = z.object({ actor_id: z.string(), action: z.string() });

test('有一张单据内容读不出来：别的照样同步，读取照常回答，结账拦下并写明是哪张；出错记录只记一次，修好后再补上', () => {
  const s = new Store(':memory:'),
    log = new ProblemLog();
  try {
    newSettings(s);
    physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    physical(s, 2, 'delivery', '2026-01-21', deliveryDoc('2'));
    setDoc(s, 2, '$.lines', '虚构的坏明细');
    catchUp(s, maker, log);
    assert.equal(event(s, 1).source_id, '1', '好的那张照样同步');
    assert.equal(unseenSources(s.db, '2026-01-31'), 1, '坏的那张一直算还没同步');
    assert.ok(new FinanceMonthly(s).get(maker, { period: '2026-01' }), '月度台账照常回答');
    assert.equal(eventsStep(s).ok, false, '结账检查拦下');
    const reports = new FinanceReports(s);
    assert.deepEqual(reports.readiness(maker, { period: '2026-01' }).unsyncedSources, [
      { source_kind: 'delivery', source_id: '2', number: 'FICT-2' },
    ]);
    assert.throws(() => reports.assertReady(maker, '2026-01'), /FICT-2/, '拦下时写明是哪张');
    const logged = log.list().items;
    assert.equal(logged.length, 1);
    assert.match(logged[0].message, /FICT-2/);
    catchUp(s, maker, log);
    assert.equal(log.list().items.length, 1, '同一版不重复记');
    setDoc(s, 2, '$.lines', deliveryDoc('2').lines);
    catchUp(s, maker, log);
    assert.equal(event(s, 2).source_id, '2', '修好（版本变了）以后下次补扫补上');
    assert.equal(unseenSources(s.db, '2026-01-31'), 0);
  } finally {
    s.close();
    log.close();
  }
});

test('没有要补的：补扫只读，不开写事务；财务没启用时什么都不做', () => {
  const s = new Store(':memory:');
  const begun: string[] = [];
  const exec = s.db.exec.bind(s.db);
  s.db.exec = (sql: string) => {
    if (/^\s*BEGIN/i.test(sql)) begun.push(sql);
    exec(sql);
  };
  try {
    physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    const before = totalChanges(s);
    assert.deepEqual(catchUp(s, maker, undefined), { processed: 0, remaining: false });
    assert.deepEqual([begun.length, totalChanges(s)], [0, before], '财务没启用');
    newSettings(s);
    assert.equal(catchUp(s, maker, undefined).processed, 1);
    begun.length = 0;
    const synced = totalChanges(s);
    assert.deepEqual(catchUp(s, maker, undefined), { processed: 0, remaining: false });
    assert.deepEqual([begun.length, totalChanges(s)], [0, synced], '都同步过了');
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
    assert.throws(() => catchUp(s, outsider, undefined), /权限/);
    assert.equal(totalChanges(s), before, '没有财务权限的不补扫');
    catchUp(s, viewer, undefined);
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
    readFinanceTool(t.f.store, viewer, 'finance.monthly', { period: '2026-10' });
    assert.equal(t.current(shipped.id).event_type, 'delivery.reversed', '查之前已同步了撤销');
  } finally {
    t.f.store.close();
  }
});
