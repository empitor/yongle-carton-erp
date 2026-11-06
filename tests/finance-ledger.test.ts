import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { financeRouter } from '../server/finance/router.js';
import { AuthManager } from '../server/auth.js';
import { Store } from '../server/db.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinanceBooks } from '../server/finance/books.js';
import { financePermissions } from '../shared/finance.js';

const admin = {
  id: 'maker',
  name: '虚构管理员',
  role: 'super_admin' as const,
  permissions: [...financePermissions],
};
const reviewer = { ...admin, id: 'reviewer', name: '虚构审核员' };
const voucher = {
  requestId: 'voucher',
  date: '2026-01-20',
  description: '虚构投入',
  entries: [
    { accountCode: '1002', debit: 110, credit: 0, cashFlow: '投入资本' },
    { accountCode: '3001', debit: 0, credit: 110 },
  ],
};
function enable(store: Store) {
  new FinanceSettings(store).enable(admin, {
    requestId: 'enable',
    version: 1,
    period: '2026-01',
    taxpayer: 'general',
    rows: [],
  });
}
function post(ledger: FinanceLedger, id: number, suffix: string) {
  ledger.transition(admin, id, 'submit', { version: 1, requestId: 'submit-' + suffix });
  ledger.transition(reviewer, id, 'approve', { version: 2, requestId: 'approve-' + suffix });
  ledger.transition(reviewer, id, 'post', { version: 3, requestId: 'post-' + suffix });
}

test('未启用、借贷不平、零分录、非末级科目和已关闭期间均拒绝制单', () => {
  const store = new Store(':memory:');
  try {
    const ledger = new FinanceLedger(store);
    assert.throws(() => ledger.create(admin, voucher), /先启用/);
    enable(store);
    const [debit, credit] = voucher.entries;
    assert.throws(
      () => ledger.create(admin, { ...voucher, entries: [debit, { ...credit, credit: 109 }] }),
      /借贷必须平衡/,
    );
    assert.throws(
      () => ledger.create(admin, { ...voucher, entries: [debit, { ...credit, credit: 0 }] }),
      /仅能填写一方/,
    );
    assert.throws(
      () =>
        ledger.create(admin, { ...voucher, entries: [debit, { ...credit, accountCode: '2221' }] }),
      /末级/,
    );
    store.db.prepare("UPDATE fin_periods SET status='closed' WHERE period='2026-01'").run();
    assert.throws(() => ledger.create(admin, voucher), /已结账/);
    assert.equal(ledger.list(admin, {}).filteredRecords, 0);
  } finally {
    store.close();
  }
});

test('制单与审核分离，允许后仍审计，记账不可修改或删除，红冲用负的同方向发生额', () => {
  const store = new Store(':memory:');
  try {
    enable(store);
    const ledger = new FinanceLedger(store),
      books = new FinanceBooks(store);
    const first = ledger.create(admin, voucher);
    const id = Number(first.header.id);
    assert.deepEqual(ledger.create(admin, voucher), first);
    ledger.transition(admin, id, 'submit', { version: 1, requestId: 'submit' });
    const approve = { version: 2, requestId: 'approve' };
    assert.throws(() => ledger.transition(admin, id, 'approve', approve), /不能审核/);
    new FinanceSettings(store).update(admin, {
      version: 2,
      requestId: 'settings',
      requireSeparateApprover: false,
    });
    ledger.transition(admin, id, 'approve', approve);
    ledger.transition(admin, id, 'post', { version: 3, requestId: 'post' });
    assert.throws(
      () => ledger.update(admin, id, { ...voucher, version: 4, requestId: 'edit' }),
      /不可修改/,
    );
    assert.throws(() => ledger.remove(admin, id), /不可修改/);
    assert.equal(
      books.read(admin, 'balance', { period: '2026-01', account: '1002' }).rows[0].ending,
      110,
    );
    const red = ledger.reverse(admin, id, {
      version: 4,
      requestId: 'reverse',
      date: '2026-02-01',
      description: '虚构冲销',
    });
    post(ledger, Number(red.header.id), 'red');
    const balance = books.read(admin, 'balance', { period: '2026-02', account: '1002' }).rows[0];
    assert.equal(balance.opening, 110);
    assert.equal(balance.debit, -110);
    assert.equal(balance.ending, 0);
    assert.equal(balance.year_debit, 0);
    const journal = books.read(admin, 'bank', { period: '2026-02' }).rows[0];
    assert.equal(journal.reversal_of, id);
    assert.equal(journal.debit, -110);
    assert.ok(books.audit(admin, { entity: 'fin_settings' }).rows.length);
  } finally {
    store.close();
  }
});

test('HTTP 财务路由拒绝无财务权限的账号和已记账凭证修改、删除', async () => {
  const store = new Store(':memory:'),
    auth = new AuthManager(':memory:');
  const server = createApp(store, { auth }).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api`;
    const request = (path: string, method: string, body: unknown, cookie = '') =>
      fetch(base + path, {
        method,
        headers: { cookie, 'content-type': 'application/json', 'x-erp-auth-token': auth.csrf },
        body: JSON.stringify(body),
      });
    const response = await request('/auth/setup', 'POST', {
      name: '虚构管理员',
      password: 'test-only-password',
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const newUser = await request(
      '/auth/users',
      'POST',
      { name: '虚构业务员', password: 'test-only-password', level: 'staff' },
      cookie,
    );
    assert.equal(newUser.status, 201);
    const login = await request('/auth/login', 'POST', {
      name: '虚构业务员',
      password: 'test-only-password',
    });
    const staffCookie = login.headers.get('set-cookie')!.split(';')[0];
    const routes = financeRouter(store, auth).stack as {
      route?: { path: string; methods: Record<string, boolean> };
    }[];
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
    enable(store);
    const ledger = new FinanceLedger(store);
    const id = Number(ledger.create(admin, voucher).header.id);
    post(ledger, id, 'http');
    const update = await request(
      '/finance/vouchers/' + id,
      'PUT',
      { ...voucher, version: 4 },
      cookie,
    );
    assert.equal(update.status, 409);
    const remove = await request('/finance/vouchers/' + id, 'DELETE', {}, cookie);
    assert.equal(remove.status, 409);
    const flow = {
      customerId: 1,
      customerName: '虚构客户',
      lines: [{ unit: '个', quantity: '1', unitPriceExact: '10.0000' }],
    };
    store.db
      .prepare(
        `INSERT INTO flow_documents(kind,number,date,status,document,actor_id,actor_name,created_at,updated_at)
      VALUES('delivery','FICT','2026-01-19','confirmed',?,'fixture','虚构财务','2026-01-19','2026-01-19')`,
      )
      .run(JSON.stringify(flow));
    const pending = await fetch(base + '/finance/reports/balance?period=2026-01', {
      headers: { cookie },
    });
    assert.equal(pending.status, 409);
    const payload = (await pending.json()) as {
      code: string;
      details: { count: number; amount: number };
    };
    assert.equal(payload.code, 'FINANCE_INFO_PENDING');
    assert.equal(payload.details.count, 1);
    assert.equal(payload.details.amount, 1000);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    auth.close();
    store.close();
  }
});
