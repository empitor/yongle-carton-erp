// 每个财务请求前服务端先补扫（server/finance/router.ts → catch-up.ts），起整套服务测：业务改了不手动补扫，财务段、今日到期
// 一请求就是新的；有坏单据时读取照常回 200、记进出错记录、结账拦下写明是哪张；出纳账号发起读取时补扫照做、审计记他，
// 写入照样要权限（全部是虚构数据，只用内存库）
import '../server/flow/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { ProblemLog, many } from '../server/core/index.js';
import { FinanceParties } from '../server/finance/parties.js';
import { cookieOf, startHttp } from './http-fixture.js';
import { deliveryDoc, maker, newSettings, physical } from './finance-fixture.js';
import { businessChanges } from './business-changes-fixture.js';
import { flowFinance } from './finance-flow-fixture.js';

const page = <T extends z.ZodType>(row: T) => z.object({ rows: z.array(row) });
const relatedRows = page(z.object({ status: z.string(), obligation_id: z.number().nullable() }));
const soonRows = page(z.object({ id: z.number(), balance: z.number() }));
const readiness = z.object({ unsyncedSources: z.array(z.object({ number: z.string().nullable() })) });
const closingSteps = z.object({ steps: z.array(z.looseObject({ key: z.string(), ok: z.boolean() })) });
const auditActor = z.object({ actor_name: z.string() });

test('业务确认、撤销以后不手动补扫：财务段、今日到期一请求就是新的', async () => {
  const t = await flowFinance();
  new FinanceParties(t.f.store).saveTerms(maker, { kind: 'customer', partyId: t.f.customer.id, termDays: 30, requestId: 'terms' });
  const h = await startHttp(t.f.store);
  try {
    // 订单没写税率：送货进财务是“待补资料”，先挂一笔暂估应收
    const shipped = t.deliver('10', [t.f.order(100)]);
    const date = t.f.flow.get(shipped.id).date;
    const related = async () => relatedRows.parse(await (await h.get('/finance/related/delivery/' + shipped.id)).json()).rows;
    const soon = async () => soonRows.parse(await (await h.get(`/finance/due-soon?date=${date}&days=365`)).json()).rows;
    const [row] = await related();
    assert.equal(row.status, 'info_pending');
    assert.ok(row.obligation_id, '确认以后财务段就有暂估应收');
    assert.deepEqual((await soon()).map((r) => r.id), [row.obligation_id], '今日到期里也有');
    t.reverse(shipped.id);
    assert.deepEqual((await related()).map((r) => r.status), ['corrected'], '撤销以后财务段是新的');
    assert.deepEqual(await soon(), [], '撤销以后今日到期里没有了');
  } finally {
    await h.close();
    t.f.store.close();
  }
});

test('有一张单据内容读不出来：财务读取照常回 200，出错记录里有它，结账检查拦下并写明是哪张', async () => {
  const s = new Store(':memory:'),
    problems = new ProblemLog();
  newSettings(s);
  physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
  physical(s, 2, 'delivery', '2026-01-21', deliveryDoc('2'));
  businessChanges(s).tamper('flow_documents', 2, '$.lines', '虚构的坏明细');
  const h = await startHttp(s, { problems });
  try {
    assert.equal((await h.get('/finance/summary?date=2026-01-31')).status, 200);
    const ready = readiness.parse(await (await h.get('/finance/reports/readiness?period=2026-01')).json());
    assert.deepEqual(ready.unsyncedSources, [{ number: 'FICT-2' }]);
    const check = closingSteps.parse(await (await h.get('/finance/closing?period=2026-01')).json());
    assert.equal(check.steps.find((step) => step.key === 'events')?.ok, false);
    const logged = problems.list({ operation: '同步业务单据进财务' }).items;
    assert.deepEqual(logged.map((p) => p.message.includes('FICT-2')), [true], '记了一次，写明是哪张');
  } finally {
    await h.close();
    s.close();
    problems.close();
  }
});

test('补扫没成功（财务自己的数据坏了）：财务的读请求照常回 200，写请求拦下', async () => {
  const s = new Store(':memory:');
  newSettings(s);
  physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
  const h = await startHttp(s);
  try {
    assert.equal((await h.get('/finance/summary?date=2026-01-31')).status, 200);
    s.db.prepare(`UPDATE fin_events SET snapshot='{"doc":5}'`).run();
    s.db.prepare("UPDATE flow_documents SET status='reversed',version=version+1 WHERE id=1").run();
    assert.equal((await h.get('/finance/summary?date=2026-01-31')).status, 200, '读照常');
    const ready = z.object({ syncFailed: z.boolean() }).parse(await (await h.get('/finance/reports/readiness?period=2026-01')).json());
    assert.equal(ready.syncFailed, true, '正式报表、结账照拦');
    const budget = { requestId: 'budget', period: '2026-01', accountCode: '5603', amount: 100 };
    assert.equal((await h.send('/finance/budgets', budget, h.cookie, { method: 'PUT' })).status, 503, '写请求先拦下');
  } finally {
    await h.close();
    s.close();
  }
});

test('出纳账号（只有财务查看和收付款）发起读取：补扫照做、审计记出纳；记凭证照样被拒', async () => {
  const s = new Store(':memory:');
  newSettings(s);
  physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
  const h = await startHttp(s);
  try {
    await h.enterSuperMode();
    const cashier = { name: '虚构出纳', password: 'Fictional-cashier-123' };
    assert.equal((await h.send('/auth/users', { ...cashier, level: 'cashier' }, h.cookie)).status, 201);
    const cookie = cookieOf(await h.send('/auth/login', cashier));
    assert.equal((await h.send('/finance/summary?date=2026-01-31', undefined, cookie)).status, 200);
    const audits = many(s.db, auditActor, "SELECT actor_name FROM business_audit WHERE entity='fin_events' AND action='sync'");
    assert.deepEqual(audits, [{ actor_name: cashier.name }]);
    const voucher = { requestId: 'cashier-voucher', date: '2026-01-21', entries: [] };
    assert.equal((await h.send('/finance/vouchers', voucher, cookie)).status, 403, '补扫不替出纳开别的写入');
  } finally {
    await h.close();
    s.close();
  }
});
