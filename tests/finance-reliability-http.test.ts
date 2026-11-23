// 财务 HTTP 一条龙：从期初和辅助账走通票据、预算、员工借还款、保证金、资产处置和红票（内存库、虚构数据）
import { sales } from '../server/sales/index.js';
import { pageActor } from './actor-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { cookieOf, startHttp } from './http-fixture.js';
import { Store } from '../server/core/db.js';
import { OperationsService } from '../server/operations/index.js';
import { customerSchema } from '../shared/core/domain.js';

const date = '2026-01-10',
  period = date.slice(0, 7);

/** 回答里用到的几项（按结构认，对不上就让测试失败） */
const rowsOf = <T extends z.ZodType>(row: T) => z.object({ rows: z.array(row) });
const endings = rowsOf(z.object({ ending: z.number() }));
const balances = rowsOf(z.object({ balance: z.number() }));
const recordId = z.object({ id: z.number() });
const withVoucher = z.object({ id: z.number(), voucher_id: z.number() });
const note = withVoucher.extend({ status: z.string() });
const counted = z.object({ filteredRecords: z.number() });
const budgets = rowsOf(z.object({ amount_cents: z.number(), actual: z.number(), difference: z.number() }));
const voucherRecord = z.object({
  header: z.object({ id: z.number() }),
  entries: z.array(
    z.object({
      account_code: z.string(),
      auxiliary_kind: z.string().nullable(),
      description: z.string(),
      debit: z.number(),
      credit: z.number(),
    }),
  ),
});
const disposal = z.object({ disposalVoucherId: z.number() });
const confirmedInvoice = z.object({ invoice: z.object({ voucher_id: z.number() }) });
const voucherDetail = z.object({ header: z.object({ reversal_of: z.number().nullable() }) });
const trial = z.object({ balanced: z.boolean() });

type Http = Awaited<ReturnType<typeof startHttp>>;
/** 一次请求：方法（默认 GET）、正文、谁发（默认制单人）、该回的状态码（默认 200）、页面凭证（默认对的） */
type CallOptions = { method?: string; body?: unknown; cookie?: string; expected?: number; csrf?: string };

/** 一条龙用的请求：call 发 /api 后面的地址并核状态码，api 发 /finance 下的，post 把一张凭证提交、审核、记账 */
function flow(h: Http) {
  let serial = 0;
  const request = () => ({ requestId: 'http-flow-' + ++serial });
  const accounts = { owner: h.cookie, reviewer: '' };
  async function call(path: string, options: CallOptions = {}) {
    const { method = 'GET', body, cookie = accounts.owner, expected = 200, csrf = h.auth.csrf } = options;
    const response = await fetch(h.api + path, {
      method,
      headers: { cookie, 'x-erp-auth-token': csrf, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value: unknown = await response.json();
    assert.equal(response.status, expected, `${method} ${path} ${JSON.stringify(value)}`);
    return { value, response };
  }
  const api = async (path: string, options?: CallOptions) => (await call('/finance' + path, options)).value;
  const post = async (id: number) => {
    await api(`/vouchers/${id}/submit`, { method: 'POST', body: { ...request(), version: 1 } });
    await api(`/vouchers/${id}/approve`, { method: 'POST', body: { ...request(), version: 2 }, cookie: accounts.reviewer });
    await api(`/vouchers/${id}/post`, { method: 'POST', body: { ...request(), version: 3 }, cookie: accounts.reviewer });
  };
  return { request, accounts, call, api, post };
}
type Flow = ReturnType<typeof flow>;
/** 一条龙里的往来单位和资金账户 */
type Parties = { customer: number; supplier: number; bank: number };

const opening = (accountCode: string, debit: number, credit: number, auxiliary: unknown = null) => ({
  accountCode,
  debit,
  credit,
  auxiliary,
  yearDebit: 0,
  yearCredit: 0,
});

/** 建审核员、页面凭证不对时拦下、带辅助项启用期初，辅助账和往来对上；建好银行账户，返回它的编号 */
async function openBooks(f: Flow, customer: { id: number; name: string }, supplier: { id: number; name: string }) {
  await f.call('/auth/users', {
    method: 'POST',
    body: { name: '虚构审核', password: 'Fictional-http-reviewer', level: 'finance' },
    expected: 201,
  });
  const review = await f.call('/auth/login', {
    method: 'POST',
    body: { name: '虚构审核', password: 'Fictional-http-reviewer' },
  });
  f.accounts.reviewer = cookieOf(review.response);
  await f.call('/finance/opening/enable', { method: 'POST', body: {}, expected: 403, csrf: 'invalid' });
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
  await f.api('/opening/enable', { method: 'POST', body: { ...f.request(), period, taxpayer: 'general', version: 1, rows } });
  assert.equal(endings.parse(await f.api('/books/auxiliary?period=' + period + '&account=1122')).rows[0].ending, 4000);
  assert.equal(balances.parse(await f.api('/obligations?kind=payable')).rows[0].balance, 4000);
  const bank = recordId.parse(
    await f.api('/cash/accounts', {
      method: 'PUT',
      body: { ...f.request(), name: '虚构银行', kind: 'bank', accountCode: '1002' },
    }),
  );
  return bank.id;
}

/** 应收票据背书、贴现、到期、退回四种处理各记账；贴现利息进财务费用，预算的实际数和差额跟着变 */
async function notesAndBudget(f: Flow, p: Parties) {
  await f.api('/budgets', { method: 'PUT', body: { ...f.request(), period, accountCode: '5603', amount: 150 } });
  for (const status of ['endorsed', 'discounted', 'matured', 'returned']) {
    const held = note.parse(
      await f.api('/notes', {
        method: 'POST',
        body: {
          ...f.request(),
          kind: 'receivable',
          partyId: p.customer,
          number: '虚构票-' + status,
          bank: '虚构承兑行',
          date,
          dueDate: '2026-01-20',
          amount: 500,
        },
      }),
    );
    assert.equal(held.status, 'held');
    await f.post(held.voucher_id);
    const changed = note.parse(
      await f.api(`/notes/${held.id}/status`, {
        method: 'POST',
        body: {
          ...f.request(),
          version: 1,
          status,
          date: '2026-01-20',
          reason: '虚构票据处理',
          ...(status === 'endorsed' ? { counterPartyId: p.supplier } : {}),
          ...(status === 'matured' || status === 'discounted' ? { accountId: p.bank } : {}),
          ...(status === 'discounted' ? { proceeds: 450 } : {}),
        },
      }),
    );
    assert.equal(changed.status, status);
    await f.post(changed.voucher_id);
    assert.equal(counted.parse(await f.api('/notes?status=' + status)).filteredRecords, 1);
  }
  const budget = budgets.parse(await f.api('/budgets?period=' + period)).rows[0];
  assert.deepEqual([budget.amount_cents, budget.actual, budget.difference], [150, 50, -100]);
  await f.api('/budgets', { method: 'PUT', body: { ...f.request(), version: 1, period, accountCode: '5603', amount: 125 } });
  assert.equal(budgets.parse(await f.api('/budgets?period=' + period)).rows[0].difference, -75);
}

/** 员工借款、还款记到其他应收款（不挂往来单位的辅助项，摘要带员工），再付一笔保证金：其他应收款期末只剩保证金 */
async function advancesAndDeposit(f: Flow, p: Parties) {
  for (const kind of ['loan', 'repayment']) {
    const advance = voucherRecord.parse(
      await f.api('/employee-advances', {
        method: 'POST',
        body: {
          ...f.request(),
          kind,
          date,
          accountId: p.bank,
          employeeId: 'http-staff',
          employeeName: '虚构员工',
          amount: 300,
          description: '虚构员工借还款',
          accountCode: '1221',
        },
      }),
    );
    const employeeLine = advance.entries.find((e) => e.account_code === '1221');
    assert.ok(employeeLine, '有记到其他应收款的那行分录');
    assert.equal(employeeLine.auxiliary_kind, null);
    assert.match(employeeLine.description, /http-staff/);
    assert.equal(kind === 'loan' ? employeeLine.debit : employeeLine.credit, 300);
    await f.post(advance.header.id);
  }
  const deposit = withVoucher.parse(
    await f.api('/deposits', {
      method: 'POST',
      body: {
        ...f.request(),
        kind: 'paid',
        partyKind: 'supplier',
        partyId: p.supplier,
        date,
        accountId: p.bank,
        amount: 100,
        description: '虚构保证金',
      },
    }),
  );
  await f.post(deposit.voucher_id);
  assert.equal(endings.parse(await f.api('/books/balance?period=' + period + '&account=1221')).rows[0].ending, 100);
}

/** 买一台设备记账、处置并记账，资产列表里按已处置筛得到它 */
async function assetDisposal(f: Flow, bank: number) {
  const asset = withVoucher.parse(
    await f.api('/assets', {
      method: 'POST',
      body: {
        ...f.request(),
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
      },
    }),
  );
  await f.post(asset.voucher_id);
  const disposed = disposal.parse(
    await f.api(`/assets/${asset.id}/dispose`, {
      method: 'POST',
      body: { ...f.request(), version: 1, date: '2026-01-22', proceeds: 800, accountId: bank, reason: '虚构处置' },
    }),
  );
  await f.post(disposed.disposalVoucherId);
  assert.equal(rowsOf(recordId).parse(await f.api('/assets?status=disposed')).rows[0].id, asset.id);
}

/** 采购蓝票确认记账；不指原票的负数票被拦下；指原票的红票确认记账，红字凭证冲的是蓝票那张 */
async function redInvoice(f: Flow, supplier: number) {
  const bill = { direction: 'purchase', type: '虚构数电票', date, partyId: supplier, rate: '13' };
  const blue = recordId.parse(
    await f.api('/invoices', { method: 'POST', body: { ...f.request(), ...bill, number: 'BLUE-1', net: 1000, tax: 130, gross: 1130 } }),
  );
  const original = confirmedInvoice.parse(
    await f.api(`/invoices/${blue.id}/confirm`, { method: 'POST', body: { ...f.request(), version: 1 } }),
  );
  await f.post(original.invoice.voucher_id);
  await f.api('/invoices', {
    method: 'POST',
    body: { ...f.request(), ...bill, number: 'RED-BLOCKED', net: -1000, tax: -130, gross: -1130 },
    expected: 422,
  });
  const red = recordId.parse(
    await f.api('/invoices', {
      method: 'POST',
      body: {
        ...f.request(),
        ...bill,
        number: 'RED-1',
        date: '2026-01-25',
        originalId: blue.id,
        net: -1000,
        tax: -130,
        gross: -1130,
      },
    }),
  );
  const reversal = confirmedInvoice.parse(
    await f.api(`/invoices/${red.id}/confirm`, { method: 'POST', body: { ...f.request(), version: 1 } }),
  );
  await f.post(reversal.invoice.voucher_id);
  assert.equal(
    voucherDetail.parse(await f.api(`/vouchers/${reversal.invoice.voucher_id}`)).header.reversal_of,
    original.invoice.voucher_id,
  );
}

test('财务 HTTP 从期初和辅助账走通票据、预算、员工借还款、资产处置和红票', async () => {
  const store = new Store(':memory:');
  const h = await startHttp(store, { admin: { name: '虚构制单', password: 'Fictional-http-owner' } });
  const customer = sales(store).createCustomer(customerSchema.parse({ name: '虚构 HTTP 客户' }));
  const supplier = new OperationsService(store).saveSupplier(
    { name: '虚构 HTTP 供应商' },
    pageActor({ id: 'seed', name: '虚构操作员', permissions: ['business:edit'] }),
  );
  const f = flow(h);
  try {
    await h.enterSuperMode();
    const bank = await openBooks(f, customer, supplier);
    const parties = { customer: customer.id, supplier: supplier.id, bank };
    await notesAndBudget(f, parties);
    await advancesAndDeposit(f, parties);
    await assetDisposal(f, bank);
    await redInvoice(f, supplier.id);
    assert.equal(trial.parse(await f.api('/reports/trial?period=' + period)).balanced, true);
  } finally {
    await h.close();
    store.close();
  }
});
