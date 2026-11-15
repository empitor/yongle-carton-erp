// 银行流水导入、匹配建议、余额调节和进项转出（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { Store } from '../server/core/db.js';
import { FinanceBank } from '../server/finance/bank.js';
import { bankWorkbook } from '../server/finance/exports.js';
import { FinanceInvoices } from '../server/finance/invoices.js';
import { FinanceTax } from '../server/finance/vat.js';
import { funds, bill as invoiceInput, maker, newSettings, postDrafts } from './finance-fixture.js';
import { FinanceInvoiceConfirm } from '../server/finance/invoice-confirm.js';

test('银行导入去重、匹配建议不写入、余额调节与进项转出', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      bank = new FinanceBank(s),
      invoices = new FinanceInvoices(s);
    funds(s, cash, { kind: 'receipt', date: '2026-02-15', amount: 9000 });
    const payload = {
      accountId: 1,
      rows: [{ date: '2026-02-15', amount: 9000, reference: '虚构流水一', party: '虚构客户' }],
    };
    assert.deepEqual(bank.import(maker, { ...payload, requestId: 'bank-1' }), {
      imported: 1,
      duplicates: 0,
    });
    assert.deepEqual(bank.import(maker, { ...payload, requestId: 'bank-2' }), {
      imported: 0,
      duplicates: 1,
    });
    const [suggestion] = bank.suggestions(maker, 1);
    assert.equal(bank.list(maker, {}).rows[0].voucher_id, null);
    bank.match(maker, 1, {
      version: 1,
      requestId: 'match',
      voucherId: suggestion.voucher_id,
      position: suggestion.position,
    });
    assert.equal(
      bank.reconcile(maker, {
        accountId: 1,
        from: '2026-02-01',
        to: '2026-02-28',
        bankBalance: 9000,
      }).difference,
      0,
    );
    const bill = invoices.create(
      maker,
      invoiceInput('purchase', 'A-1', { date: '2026-02-15', rate: '13', net: 10000, tax: 1300, gross: 11300 }),
    );
    assert.throws(
      () => invoices.create(maker, invoiceInput('purchase', 'A-1', { date: '2026-02-15', requestId: 'duplicate' })),
      /已存在/,
    );
    assert.throws(
      () => invoices.create(maker, invoiceInput('purchase', 'R-1', { date: '2026-02-15', net: -10000, tax: -1300, gross: -11300 })),
      /原蓝票/,
    );
    new FinanceInvoiceConfirm(s).confirm(maker, bill.id, { version: 1, requestId: 'invoice-confirm' });
    postDrafts(s);
    invoices.status(maker, bill.id, {
      version: 2,
      requestId: 'no-deduct',
      status: 'nondeductible',
      date: '2026-02-25',
      reason: '虚构不可抵扣',
      counterAccount: '560201',
    });
    postDrafts(s);
    assert.equal(new FinanceTax(s).worksheet(maker, { period: '2026-02' }).transfer, 1300);
    const red = invoices.create(
      maker,
      invoiceInput('purchase', 'R-2', { date: '2026-03-01',
        net: -10000,
        tax: -1300,
        gross: -11300,
        originalId: bill.id }),
    );
    assert.ok(red.id);
  } finally {
    s.close();
  }
});

test('银行余额调节表导出：银行未达账的往来单位一列写流水上的对方户名', async () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const bank = new FinanceBank(s);
    bank.import(maker, {
      accountId: 1,
      requestId: 'bank-party',
      rows: [{ date: '2026-02-15', amount: 500, reference: '虚构流水二', party: '虚构对方户名' }],
    });
    const data = bank.reconcile(maker, { accountId: 1, from: '2026-02-01', to: '2026-02-28', bankBalance: 500 });
    const book = new ExcelJS.Workbook();
    await book.xlsx.read(Readable.from([await bankWorkbook('2026-02-01', '2026-02-28', data)]));
    const sheet = book.worksheets[0];
    const line = sheet.getRows(1, sheet.rowCount)?.find((r) => r.getCell(2).value === '虚构流水二');
    assert.equal(line?.getCell(3).value, '虚构对方户名');
  } finally {
    s.close();
  }
});
