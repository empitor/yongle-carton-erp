import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';
import { OperationsService } from '../server/operations/service.js';
import { customerSchema } from '../shared/domain.js';

test('财务 HTTP 从期初和辅助账走通票据、预算、员工借还款、资产处置和红票', async () => {
  const store = new Store(':memory:');
  const auth = new AuthManager(':memory:');
  const server = createServer(createApp(store, { auth }));
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构 HTTP 客户' }));
  const supplier = new OperationsService(store).saveSupplier(
    { name: '虚构 HTTP 供应商' },
    { id: 'seed', name: '虚构操作员', permissions: ['business:edit'] },
  );
  let serial = 0;
  const request = () => ({ requestId: 'http-flow-' + ++serial });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  let owner = '',
    reviewer = '';
  const date = '2026-01-10',
    period = date.slice(0, 7);
  async function call(
    path: string,
    method = 'GET',
    body?: unknown,
    cookie = owner,
    expected = 200,
    csrf = auth.csrf,
  ) {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { cookie, 'x-erp-auth-token': csrf, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, expected, `${method} ${path} ${JSON.stringify(value)}`);
    return { value, response };
  }
  const api = async (
    path: string,
    method = 'GET',
    body?: unknown,
    cookie = owner,
    expected = 200,
  ) => (await call('/finance' + path, method, body, cookie, expected)).value;
  const post = async (id: number) => {
    await api(`/vouchers/${id}/submit`, 'POST', { ...request(), version: 1 });
    await api(`/vouchers/${id}/approve`, 'POST', { ...request(), version: 2 }, reviewer);
    await api(`/vouchers/${id}/post`, 'POST', { ...request(), version: 3 }, reviewer);
  };
  const opening = (
    accountCode: string,
    debit: number,
    credit: number,
    auxiliary = null as unknown,
  ) => ({ accountCode, debit, credit, auxiliary, yearDebit: 0, yearCredit: 0 });
  try {
    const root = await call('/auth/setup', 'POST', {
      name: '虚构制单',
      password: 'fictional-http-owner',
    });
    owner = root.response.headers.get('set-cookie')!.split(';')[0];
    await call(
      '/auth/users',
      'POST',
      { name: '虚构审核', password: 'fictional-http-reviewer', level: 'finance' },
      owner,
      201,
    );
    const review = await call('/auth/login', 'POST', {
      name: '虚构审核',
      password: 'fictional-http-reviewer',
    });
    reviewer = review.response.headers.get('set-cookie')!.split(';')[0];
    await call('/finance/opening/enable', 'POST', {}, owner, 403, 'invalid');
    const customerAux = { kind: 'customer', id: String(customer.id), name: customer.name };
    const supplierAux = { kind: 'supplier', id: String(supplier.id), name: supplier.name };
    const rows = [
      opening('1002', 10000, 0),
      opening('3001', 0, 10000),
      opening('1122', 4000, 0),
      opening('1122', 4000, 0, customerAux),
      opening('2202', 0, 4000),
      opening('2202', 0, 4000, supplierAux),
    ];
    await api('/opening/enable', 'POST', {
      ...request(),
      period,
      taxpayer: 'general',
      version: 1,
      rows,
    });
    assert.equal(
      (await api('/books/auxiliary?period=' + period + '&account=1122')).rows[0].ending,
      4000,
    );
    assert.equal((await api('/obligations?kind=payable')).rows[0].balance, 4000);
    const bank = await api('/cash/accounts', 'PUT', {
      ...request(),
      name: '虚构银行',
      kind: 'bank',
      accountCode: '1002',
    });
    await api('/budgets', 'PUT', { ...request(), period, accountCode: '5603', amount: 150 });
    for (const status of ['endorsed', 'discounted', 'matured', 'returned']) {
      const note = await api('/notes', 'POST', {
        ...request(),
        kind: 'receivable',
        partyId: customer.id,
        number: '虚构票-' + status,
        bank: '虚构承兑行',
        date,
        dueDate: '2026-01-20',
        amount: 500,
      });
      assert.equal(note.status, 'held');
      await post(note.voucher_id);
      const changed = await api(`/notes/${note.id}/status`, 'POST', {
        ...request(),
        version: 1,
        status,
        date: '2026-01-20',
        reason: '虚构票据处理',
        ...(status === 'endorsed' ? { counterPartyId: supplier.id } : {}),
        ...(status === 'matured' || status === 'discounted' ? { accountId: bank.id } : {}),
        ...(status === 'discounted' ? { proceeds: 450 } : {}),
      });
      assert.equal(changed.status, status);
      await post(changed.voucher_id);
      assert.equal((await api('/notes?status=' + status)).filteredRecords, 1);
    }
    const budget = (await api('/budgets?period=' + period)).rows[0];
    assert.deepEqual([budget.amount_cents, budget.actual, budget.difference], [150, 50, -100]);
    await api('/budgets', 'PUT', {
      ...request(),
      version: 1,
      period,
      accountCode: '5603',
      amount: 125,
    });
    assert.equal((await api('/budgets?period=' + period)).rows[0].difference, -75);
    for (const kind of ['loan', 'repayment']) {
      const advance = await api('/employee-advances', 'POST', {
        ...request(),
        kind,
        date,
        accountId: bank.id,
        employeeId: 'http-staff',
        employeeName: '虚构员工',
        amount: 300,
        description: '虚构员工借还款',
        accountCode: '1221',
      });
      const employeeLine = advance.entries.find((e: any) => e.account_code === '1221');
      assert.equal(employeeLine.auxiliary_kind, null);
      assert.match(employeeLine.description, /http-staff/);
      assert.equal(kind === 'loan' ? employeeLine.debit : employeeLine.credit, 300);
      await post(advance.header.id);
    }
    const deposit = await api('/deposits', 'POST', {
      ...request(),
      kind: 'paid',
      partyKind: 'supplier',
      partyId: supplier.id,
      date,
      accountId: bank.id,
      amount: 100,
      description: '虚构保证金',
    });
    await post(deposit.voucher_id);
    assert.equal(
      (await api('/books/balance?period=' + period + '&account=1221')).rows[0].ending,
      100,
    );
    const asset = await api('/assets', 'POST', {
      ...request(),
      number: '虚构设备编号',
      name: '虚构设备',
      category: '机器设备',
      original: 1000,
      date,
      months: 10,
      residualBp: 0,
      department: '虚构部门',
      expenseAccount: '560205',
      counterAccount: '1002',
      cashFlow: '购建固定资产支付的现金',
    });
    await post(asset.voucher_id);
    const disposal = await api(`/assets/${asset.id}/dispose`, 'POST', {
      ...request(),
      version: 1,
      date: '2026-01-22',
      proceeds: 800,
      accountId: bank.id,
      reason: '虚构处置',
    });
    await post(disposal.disposalVoucherId);
    assert.equal((await api('/assets?status=disposed')).rows[0].id, asset.id);
    const bill = {
      direction: 'purchase',
      type: '虚构数电票',
      date,
      partyId: supplier.id,
      rate: '13',
    };
    const blue = await api('/invoices', 'POST', {
      ...request(),
      ...bill,
      number: 'BLUE-1',
      net: 1000,
      tax: 130,
      gross: 1130,
    });
    const original = await api(`/invoices/${blue.id}/confirm`, 'POST', {
      ...request(),
      version: 1,
    });
    await post(original.invoice.voucher_id);
    await api(
      '/invoices',
      'POST',
      { ...request(), ...bill, number: 'RED-BLOCKED', net: -1000, tax: -130, gross: -1130 },
      owner,
      422,
    );
    const red = await api('/invoices', 'POST', {
      ...request(),
      ...bill,
      number: 'RED-1',
      date: '2026-01-25',
      originalId: blue.id,
      net: -1000,
      tax: -130,
      gross: -1130,
    });
    const reversal = await api(`/invoices/${red.id}/confirm`, 'POST', { ...request(), version: 1 });
    await post(reversal.invoice.voucher_id);
    assert.equal(
      (await api(`/vouchers/${reversal.invoice.voucher_id}`)).header.reversal_of,
      original.invoice.voucher_id,
    );
    assert.equal((await api('/reports/trial?period=' + period)).balanced, true);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    auth.close();
    store.close();
  }
});
