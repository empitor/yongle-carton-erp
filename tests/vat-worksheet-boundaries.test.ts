// 税务底稿的边界：进项转出加到应纳、期初留抵从启用月起滚、小规模按销项票不含税额乘征收率、税率写法、没财务权限不能看。
// 全部虚构数据，内存库；只用非负金额（负数四舍五入另有测试）。
import { sales } from '../server/sales/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceInvoices } from '../server/finance/invoices.js';
import { entry } from '../server/finance/query.js';
import { FinanceTax } from '../server/finance/vat.js';
import { percentCents, percentage } from '../server/finance/terms.js';
import { customerSchema } from '../shared/core/domain.js';
import { pageActor } from './actor-fixture.js';
import { bill, maker, newSettings, post } from './finance-fixture.js';

function book(s: Store, requestId: string, date: string, entries: ReturnType<typeof entry>[]) {
  post(s, new FinanceLedger(s).create(maker, { requestId, date, description: '虚构税额', entries }).header.id);
}

test('有进项转出的月份：应纳 = 销项 - 进项 + 进项转出', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    book(s, 'vat-out', '2026-01-10', [entry('1403', 1000, 0), entry('22210102', 0, 1000)]);
    book(s, 'vat-in', '2026-01-11', [entry('22210101', 600, 0), entry('1403', 0, 600)]);
    book(s, 'vat-transfer', '2026-01-12', [entry('1403', 100, 0), entry('22210103', 0, 100)]);
    const jan = new FinanceTax(s).worksheet(maker, { period: '2026-01' });
    assert.deepEqual([jan.output, jan.input, jan.transfer, jan.payable, jan.carryOut], [1000, 600, 100, 500, 0]);
  } finally {
    s.close();
  }
});

test('期初进项留抵在启用月记入，启用后几个月没有发生额，到第一笔销项的月份照样抵掉', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-01', [
      { accountCode: '22210101', debit: 500, credit: 0, yearDebit: 0, yearCredit: 0 },
      { accountCode: '3001', debit: 0, credit: 500, yearDebit: 0, yearCredit: 0 },
    ]);
    book(s, 'vat-mar', '2026-03-10', [entry('1403', 300, 0), entry('22210102', 0, 300)]);
    const mar = new FinanceTax(s).worksheet(maker, { period: '2026-03' });
    assert.deepEqual([mar.carryIn, mar.payable, mar.carryOut], [500, 0, 200]);
  } finally {
    s.close();
  }
});

test('小规模纳税人：应纳按本月已确认销项票的不含税额乘征收率估算，附加税按它再算', () => {
  const s = new Store(':memory:');
  try {
    const settings = new FinanceSettings(s);
    settings.enable(maker, { period: '2026-01', taxpayer: 'small', version: 1, requestId: 'enable', rows: [] });
    settings.update(maker, {
      version: 2,
      requestId: 'rates',
      taxRates: { smallVat: 300, urban: 700, education: 0, localEducation: 0, income: 0 },
    });
    sales(s).createCustomer(customerSchema.parse({ name: '虚构客户' }));
    const invoice = new FinanceInvoices(s).create(maker, bill('sale', 'XN-0001', { date: '2026-01-15', gross: 10000 }));
    // 只要一张已确认的销项票（确认流程另有测试），直接标成已确认
    s.db.prepare("UPDATE fin_invoices SET status='normal' WHERE id=?").run(invoice.id);
    const jan = new FinanceTax(s).worksheet(maker, { period: '2026-01' });
    assert.deepEqual([jan.taxpayer, jan.payable, jan.urban], ['small', 300, 21]);
  } finally {
    s.close();
  }
});

test('没有财务查看权限的账号不能看税务底稿', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const sales = pageActor({ id: 'fictional-sales', name: '虚构业务员', role: 'admin' as const, permissions: ['business:edit'] });
    assert.throws(() => new FinanceTax(s).worksheet(sales, { period: '2026-01' }), /没有执行此操作的权限/);
  } finally {
    s.close();
  }
});

test('税率写法：0 到 100 之间、最多三位整数六位小数的百分数，别的写法拒收', () => {
  for (const ok of ['0', '13', '0.5', '36.123456', '100']) assert.equal(percentage.safeParse(ok).success, true, ok);
  for (const bad of ['101', '100.000001', '1.1234567', '-1', '1.', '.5', 'a13', '13a', '1000'])
    assert.equal(percentage.safeParse(bad).success, false, bad);
});

test('按百分比算分：乘的倍数和除的倍数都算进去', () => {
  assert.equal(percentCents(10000, '3'), 300);
  assert.equal(percentCents(10000, '300', 1, 100), 300);
  assert.equal(percentCents(10000, '13', 2), 2600);
  assert.equal(percentCents(10000, '0.5'), 50);
});
