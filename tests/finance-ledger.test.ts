import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { cookieOf, startHttp } from './http-fixture.js';
import { financeRouter } from '../server/finance/router.js';
import { Store } from '../server/core/db.js';
import { one, rows } from '../server/core/index.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { maker, newSettings, post, physical, deliveryDoc, booked } from './finance-fixture.js';
import { businessChanges } from './business-changes-fixture.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinanceBooks } from '../server/finance/books.js';
import { FinanceAuditLog } from '../server/finance/audit-log.js';

const voucher = {
  requestId: 'voucher',
  date: '2026-01-20',
  description: '虚构投入',
  entries: [
    { accountCode: '1002', debit: 110, credit: 0, cashFlow: '投入资本' },
    { accountCode: '3001', debit: 0, credit: 110 },
  ],
};

/** express 路由器栈里的各层：挂路由的那层带 route（地址、请求方法），中间件那层没有 */
const routerLayers = z.array(z.object({ route: z.object({ path: z.string(), methods: z.record(z.string(), z.boolean()) }).optional() }));
/** 有单据资料待补时读正式报表的 409 回答：类别和待补的张数、金额 */
const pendingAnswer = z.object({ code: z.string(), details: z.object({ count: z.number(), amount: z.number() }) });

/** 启用财务后记一张 1.10 元的投入凭证并记账，返回凭证编号 */
function postedVoucher(store: Store) {
  newSettings(store);
  const id = Number(new FinanceLedger(store).create(maker, voucher).header.id);
  post(store, id);
  return id;
}

test('未启用、借贷不平、零分录、非末级科目和已关闭期间均拒绝制单', () => {
  const store = new Store(':memory:');
  try {
    const ledger = new FinanceLedger(store);
    assert.throws(() => ledger.create(maker, voucher), /先启用/);
    newSettings(store);
    const [debit, credit] = voucher.entries;
    assert.throws(
      () => ledger.create(maker, { ...voucher, entries: [debit, { ...credit, credit: 109 }] }),
      /借贷必须平衡/,
    );
    assert.throws(
      () => ledger.create(maker, { ...voucher, entries: [debit, { ...credit, credit: 0 }] }),
      /仅能填写一方/,
    );
    assert.throws(
      () =>
        ledger.create(maker, { ...voucher, entries: [debit, { ...credit, accountCode: '2221' }] }),
      /末级/,
    );
    store.db.prepare("UPDATE fin_periods SET status='closed' WHERE period='2026-01'").run();
    assert.throws(() => ledger.create(maker, voucher), /已结账/);
    assert.equal(ledger.list(maker, {}).filteredRecords, 0);
  } finally {
    store.close();
  }
});

test('制单与审核分离，允许后仍审计，记账不可修改或删除，红冲用负的同方向发生额', () => {
  const store = new Store(':memory:');
  try {
    newSettings(store);
    const ledger = new FinanceLedger(store),
      books = new FinanceBooks(store);
    const first = ledger.create(maker, voucher);
    const id = Number(first.header.id);
    assert.deepEqual(ledger.create(maker, voucher), first);
    ledger.transition(maker, id, 'submit', { version: 1, requestId: 'submit' });
    const approve = { version: 2, requestId: 'approve' };
    assert.throws(() => ledger.transition(maker, id, 'approve', approve), /不能审核/);
    new FinanceSettings(store).update(maker, {
      version: 3,
      requestId: 'settings',
      requireSeparateApprover: false,
    });
    ledger.transition(maker, id, 'approve', approve);
    ledger.transition(maker, id, 'post', { version: 3, requestId: 'post' });
    assert.throws(
      () => ledger.update(maker, id, { ...voucher, version: 4, requestId: 'edit' }),
      /不可修改/,
    );
    assert.equal(
      books.read(maker, 'balance', { period: '2026-01', account: '1002' }).rows[0].ending,
      110,
    );
    const red = ledger.reverse(maker, id, {
      version: 4,
      requestId: 'reverse',
      date: '2026-02-01',
      description: '虚构冲销',
    });
    post(store, Number(red.header.id));
    const balance = books.read(maker, 'balance', { period: '2026-02', account: '1002' }).rows[0];
    assert.equal(balance.opening, 110);
    assert.equal(balance.debit, -110);
    assert.equal(balance.ending, 0);
    assert.equal(balance.year_debit, 0);
    const journal = books.read(maker, 'bank', { period: '2026-02' }).rows[0];
    assert.equal(journal.reversal_of, id);
    assert.equal(journal.debit, -110);
    assert.ok(new FinanceAuditLog(store).list(maker, { entity: 'fin_settings' }).rows.length);
  } finally {
    store.close();
  }
});

test('只保存一条分录时，凭证接口返回 400 和中文提示', async () => {
  const store = new Store(':memory:');
  const h = await startHttp(store);
  try {
    newSettings(store);
    const response = await h.post('/finance/vouchers', { ...voucher, entries: voucher.entries.slice(0, 1) });
    assert.equal(response.status, 400);
    const { message } = z.object({ message: z.string() }).parse(await response.json());
    assert.equal(message, '至少填写两条分录。');
    assert.equal(new FinanceLedger(store).list(maker, {}).filteredRecords, 0);
  } finally {
    await h.close();
    store.close();
  }
});

test('HTTP 财务路由拒绝无财务权限的账号和已记账凭证修改、删除', async () => {
  const store = new Store(':memory:'),
    h = await startHttp(store, { admin: { name: '虚构管理员', password: 'Test-only-password' } }),
    auth = h.auth;
  try {
    const base = h.api;
    const request = (path: string, method: string, body: unknown, cookie = '') =>
      h.send(path, body, cookie, { method });
    const cookie = h.cookie;
    await h.enterSuperMode();
    const newUser = await request(
      '/auth/users',
      'POST',
      { name: '虚构业务员', password: 'Test-only-password', level: 'staff' },
      cookie,
    );
    assert.equal(newUser.status, 201);
    const login = await request('/auth/login', 'POST', {
      name: '虚构业务员',
      password: 'Test-only-password',
    });
    const staffCookie = cookieOf(login);
    const routes = routerLayers.parse(financeRouter(store, auth).stack);
    for (const { route } of routes) {
      if (!route) continue;
      const path = '/finance' + route.path.replace(/:kind/g, 'balance').replace(/:id/g, '1');
      for (const method of Object.keys(route.methods)) {
        const response =
          method === 'get'
            ? await fetch(base + path, { headers: { cookie: staffCookie } })
            : await request(path, method.toUpperCase(), {}, staffCookie);
        assert.equal(response.status, 403, method + ' ' + path);
      }
    }
    newSettings(store);
    const ledger = new FinanceLedger(store);
    const id = Number(ledger.create(maker, voucher).header.id);
    post(store, id);
    const update = await request(
      '/finance/vouchers/' + id,
      'PUT',
      { ...voucher, version: 4 },
      cookie,
    );
    assert.equal(update.status, 409);
    const remove = await request('/finance/vouchers/' + id, 'DELETE', {}, cookie);
    // 凭证不能删除，也没有删除的地址
    assert.ok(remove.status >= 400);
    const flow = {
      date: '2026-01-19',
      plannedDate: '2026-01-19',
      customerId: 1,
      customerName: '虚构客户',
      lines: [{ orderId: 1, orderLineId: 1, stockId: 1, unit: '个', quantity: '1', unitPriceExact: '10.0000' }],
    };
    businessChanges(store).confirmed('delivery', '2026-01-19', flow, { number: 'FICT' });
    const pending = await fetch(base + '/finance/reports/balance?period=2026-01', {
      headers: { cookie },
    });
    assert.equal(pending.status, 409);
    const payload = pendingAnswer.parse(await pending.json());
    assert.equal(payload.code, 'FINANCE_INFO_PENDING');
    assert.equal(payload.details.count, 1);
    assert.equal(payload.details.amount, 1000);
  } finally {
    await h.close();
    store.close();
  }
});

test('财务状态都有中文名：库里各表存的状态值都在页面和导出共用的词表里，不露英文（核销撤销后的 revoked 等）', async () => {
  const { financeStatusName, voucherStatusName } = await import('../shared/finance/labels.js');
  const { invoiceStates, noteStatusName } = await import('../src/finance/cash/shared.js');
  const stored = await import('../server/finance/stored-values.js');
  const shownWithStatus = [
    ...stored.periodStatuses,
    ...stored.voucherStatuses,
    ...stored.eventStatuses,
    ...stored.observationStatuses,
    ...stored.cashDocumentStatuses,
    ...stored.allocationStatuses,
    ...stored.statementStatuses,
    ...stored.expenseStatuses,
    ...stored.assetStatuses,
  ];
  assert.deepEqual(
    shownWithStatus.filter((s) => !/\p{Script=Han}/u.test(financeStatusName(s) ?? '')),
    [],
    '这些状态在页面和导出里会直接显示英文',
  );
  for (const s of stored.voucherStatuses) assert.match(voucherStatusName(s) ?? '', /\p{Script=Han}/u, s);
  // 发票、承兑票据有自己的叫法表
  assert.deepEqual(stored.invoiceStatuses.filter((s) => !(s in invoiceStates)), []);
  for (const s of stored.noteStatuses) assert.match(noteStatusName(s), /\p{Script=Han}/u, s);
});

test('凭证面板的来源用中文叫法加单号：每种生成凭证的财务功能都有中文名，不露出内部代码', async () => {
  const { voucherModuleNames, voucherSourceText, eventSourceNames } = await import('../src/finance/labels.js');
  const { voucherModuleSources, eventSourceKinds } = await import('../server/finance/stored-values.js');
  assert.deepEqual(Object.keys(voucherModuleNames).sort(), [...voucherModuleSources].sort());
  assert.deepEqual(Object.keys(eventSourceNames).sort(), [...eventSourceKinds].sort());
  assert.equal(voucherSourceText({ source_kind: 'delivery', source_id: '12', number: 'SH-20261027-00012' }), '送货 SH-20261027-00012');
  assert.equal(voucherSourceText({ source_kind: 'stock', source_id: 'x', number: null }), '盘点 x');
  assert.equal(
    voucherSourceText({ module: 'event_reversal', id: 3, event: { source_kind: 'arrival', source_id: '1', number: 'DH-20261026-00001' } }),
    '红字冲销 · 到货 DH-20261026-00001',
  );
  assert.equal(voucherSourceText({ module: 'payroll', id: 202610 }), '工资计提 2026-10');
  // 收付款、保证金、压款利息没有单号：服务端带上那笔记录，写“叫法 月-日 金额”，不露内部编号
  assert.equal(
    voucherSourceText({ module: 'cash', id: 7, record: { kind: 'receipt', date: '2026-11-12', amount: 10000 } }),
    '收客户款 11-12 100.00',
  );
  assert.equal(voucherSourceText({ module: 'cash', id: 7 }), '收付款');
  assert.equal(
    voucherSourceText({ module: 'interest', id: 2, record: { kind: null, date: '2026-11-30', amount: 1234 } }),
    '压款利息 11-30 12.34',
  );
  assert.equal(voucherSourceText({ module: 'invoice', id: 4 }), '发票');
  assert.equal(voucherSourceText(null), null);
  for (const module of voucherModuleSources)
    assert.doesNotMatch(String(voucherSourceText({ module, id: 1 })), /[a-z_]{3,}/, module);
});

test('财务修改记录按北京时间的日期筛选，只收日期', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const add = (at: string, recordId: number) =>
      s.db
        .prepare(
          `INSERT INTO business_audit(at,actor_id,actor_name,source,action,entity,record_id,document)
        VALUES(?,?,?,'page','fixture','fin_vouchers',?,'{}')`,
        )
        .run(at, maker.id, maker.name, recordId);
    add('2026-03-31T15:30:00.000Z', 1); // 北京时间 3 月 31 日 23:30
    add('2026-03-31T16:30:00.000Z', 2); // 北京时间 4 月 1 日 00:30
    const ids = (q: Record<string, string>) =>
      new FinanceAuditLog(s).list(maker, { entity: 'fin_vouchers', ...q }).rows.map((r) => Number(r.record_id));
    assert.deepEqual(ids({ from: '2026-04-01', to: '2026-04-01' }), [2]);
    assert.deepEqual(ids({ from: '2026-03-31', to: '2026-03-31' }), [1]);
    assert.throws(() => new FinanceAuditLog(s).list(maker, { from: '2026-03' }));
    assert.throws(() => new FinanceAuditLog(s).list(maker, { from: '2026-13-01' }));
  } finally {
    s.close();
  }
});

test('红字冲销只对已记账的原凭证做一次：草稿、红字凭证本身、已红冲过的都被拒，红冲日期不能早于原凭证', () => {
  const store = new Store(':memory:');
  try {
    const id = postedVoucher(store);
    const ledger = new FinanceLedger(store);
    const reverse = (key: number, date: string, requestId: string, version = 4) =>
      ledger.reverse(maker, key, { version, requestId, date, description: '虚构冲销' });
    assert.throws(() => reverse(id, '2026-01-19', 'early'), /不得早于原凭证/);
    const red = Number(reverse(id, '2026-01-25', 'red').header.id);
    assert.throws(() => reverse(id, '2026-01-26', 'again'), /已存在有效红冲凭证/);
    post(store, red);
    assert.throws(() => reverse(red, '2026-01-26', 'red-of-red'), /只可红冲已记账的原凭证/);
    const draft = Number(ledger.create(maker, { ...voucher, requestId: 'draft' }).header.id);
    assert.throws(() => reverse(draft, '2026-01-26', 'red-draft', 1), /只可红冲已记账的原凭证/);
  } finally {
    store.close();
  }
});

test('已记账凭证不能作废；送货等来源生成的凭证不能在凭证页红冲，要到来源页面', () => {
  const store = new Store(':memory:');
  try {
    const id = postedVoucher(store);
    const ledger = new FinanceLedger(store);
    assert.throws(() => ledger.transition(maker, id, 'void', { version: 4, requestId: 'void' }), /不可修改或删除，只能红冲/);
    physical(store, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    const source = Number(booked(store, 1).voucher_id);
    assert.throws(
      () => ledger.reverse(maker, source, { version: 4, requestId: 'red-source', date: '2026-01-25', description: '虚构' }),
      /请到来源页面红字冲销/,
    );
  } finally {
    store.close();
  }
});

test('草稿凭证能改，跨期间改日期、改红字凭证或来源凭证的分录、跳过审核直接记账都被拒', () => {
  const store = new Store(':memory:');
  try {
    const id = postedVoucher(store);
    const ledger = new FinanceLedger(store);
    const draft = Number(ledger.create(maker, { ...voucher, requestId: 'draft' }).header.id);
    const edited = ledger.update(maker, draft, { ...voucher, requestId: 'edit', version: 1, description: '虚构改摘要' });
    assert.equal(edited.header.description, '虚构改摘要');
    assert.throws(
      () => ledger.update(maker, draft, { ...voucher, requestId: 'cross', version: 2, date: '2026-02-03' }),
      /跨期间更正须先作废/,
    );
    assert.throws(() => ledger.transition(maker, draft, 'post', { version: 2, requestId: 'skip' }), /状态不允许/);
    const red = Number(ledger.reverse(maker, id, { version: 4, requestId: 'red', date: '2026-01-25', description: '虚构' }).header.id);
    assert.throws(() => ledger.update(maker, red, { ...voucher, requestId: 'edit-red', version: 1 }), /红冲分录按原凭证固定/);
    physical(store, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    new FinanceEvents(store).sync(maker, { requestId: 'scan' });
    const e = one(store.db, rows.fin_events.pick({ id: true, version: true }), "SELECT id,version FROM fin_events WHERE source_id='1'");
    if (!e) throw new Error('测试数据：送货单 1 没有财务事件');
    const source = Number(new FinanceEventVouchers(store).generate(maker, e.id, { version: e.version, requestId: 'g' }).voucher_id);
    assert.throws(() => ledger.update(maker, source, { ...voucher, requestId: 'edit-source', version: 1 }), /来源凭证分录不能手工覆盖/);
  } finally {
    store.close();
  }
});

test('同一请求编号：原样重发返回原结果，换内容或换操作被拒；写失败不占号，改正后同一编号能用；别的账号同一编号互不影响', () => {
  const store = new Store(':memory:');
  try {
    newSettings(store);
    const ledger = new FinanceLedger(store);
    const first = ledger.create(maker, voucher);
    assert.deepEqual(ledger.create(maker, voucher), first);
    assert.throws(() => ledger.create(maker, { ...voucher, description: '虚构换了内容' }), /同一请求凭据已用于不同内容/);
    assert.throws(
      () => ledger.transition(maker, Number(first.header.id), 'submit', { version: 1, requestId: voucher.requestId }),
      /同一请求凭据已用于不同内容/,
    );
    const [debit, credit] = voucher.entries;
    const retry = { ...voucher, requestId: 'retry' };
    assert.throws(() => ledger.create(maker, { ...retry, entries: [debit, { ...credit, credit: 100 }] }), /借贷必须平衡/);
    assert.notEqual(ledger.create(maker, retry).header.id, first.header.id, '改正后同一编号新建成功');
    const other = { ...maker, id: 'other-maker', name: '虚构另一位制单员' };
    assert.notEqual(ledger.create(other, voucher).header.id, first.header.id);
  } finally {
    store.close();
  }
});
