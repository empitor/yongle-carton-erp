// 财务 HTTP 测试共用的搭建：带登录的测试服务、读工作簿、准备虚构账务（内存库）
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Store } from '../server/core/db.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { entry } from '../server/finance/query.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { startHttp } from './http-fixture.js';
import { maker, postDrafts } from './finance-fixture.js';

export { maker };

export const period = '2026-10',
  next = '2026-11';

export const request = () => ({ requestId: randomUUID() });

export const password = 'Fictional-export-password';

export async function workbook(bytes: Buffer) {
  const book = new ExcelJS.Workbook();
  // ExcelJS 的类型只收 ArrayBuffer（它自己声明的 Buffer），拷成一份独立的 ArrayBuffer 交给它
  await book.xlsx.load(Uint8Array.from(bytes).buffer);
  return book;
}

export function findRow(sheet: ExcelJS.Worksheet, value: string, column = 1) {
  const result = sheet
    .getRows(1, sheet.rowCount)
    ?.find((row) => row.getCell(column).value === value);
  assert.ok(result, `找不到行 ${value}`);
  return result;
}

export function checkLayout(sheet: ExcelJS.Worksheet, headers: string[], period: string) {
  assert.match(String(sheet.getCell('A2').value), new RegExp(period));
  assert.match(String(sheet.getCell('A2').value), /单位：元/);
  const row = findRow(sheet, headers[0]);
  assert.deepEqual(
    headers.map((_, i) => row.getCell(i + 1).value),
    headers,
  );
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.views[0].ySplit, row.number);
  assert.ok((sheet.getColumn(1).width ?? 0) > 10);
  sheet.eachRow((line) =>
    line.eachCell((cell) => {
      assert.notEqual(cell.type, ExcelJS.ValueType.Formula);
      assert.doesNotMatch(
        String(cell.value),
        /^(id|version|detail|drill|voucher_id|source_month|snapshot|metric)$/,
      );
    }),
  );
}

/** 起带登录的测试服务（管理员已进超级管理员模式，能建账号），work 拿到库、读财务地址的 api、发账号请求的 admin */
export async function fixture(
  work: (
    store: Store,
    api: (path: string, cookie?: string) => Promise<Response>,
    admin: (path: string, body: unknown) => Promise<Response>,
  ) => Promise<void>,
) {
  const store = new Store(':memory:');
  const h = await startHttp(store, { admin: { name: '虚构导出管理员', password } });
  try {
    await h.enterSuperMode();
    const admin = (path: string, body: unknown) =>
      fetch(h.api + '/auth' + path, { method: 'POST', headers: h.headers, body: JSON.stringify(body) });
    await work(store, (path, session = h.cookie) => fetch(h.api + '/finance' + path, { headers: { cookie: session } }), admin);
  } finally {
    await h.close();
    store.close();
  }
}

export function prepare(store: Store) {
  const settings = new FinanceSettings(store);
  settings.enable(maker, {
    ...request(),
    version: 1,
    taxpayer: 'general',
    period,
    rows: [
      { accountCode: '1002', debit: 30000, credit: 0, yearDebit: 0, yearCredit: 0 },
      { accountCode: '3001', debit: 0, credit: 30000, yearDebit: 0, yearCredit: 0 },
    ],
  });
  settings.update(maker, {
    ...request(),
    version: 2,
    taxRates: { smallVat: null, urban: 0, education: 0, localEducation: 0, income: 0 },
  });
  const ledger = new FinanceLedger(store);
  const post = () => postDrafts(store);
  ledger.create(maker, {
    ...request(),
    date: period + '-12',
    description: '=虚构凭证摘要',
    entries: [
      { ...entry('1002', 30000, 0, null, '收到其他经营活动现金'), description: '=虚构凭证摘要' },
      entry('5301', 0, 30000),
    ],
  });
  post();
  return post;
}
