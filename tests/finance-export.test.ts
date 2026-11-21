// 财务 Excel 下载（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { Store } from '../server/core/db.js';
import { FinanceAssets } from '../server/finance/assets.js';
import { FinanceBank } from '../server/finance/bank.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceSettlements } from '../server/finance/settlements.js';
import { customerSchema } from '../shared/core/domain.js';
import { FinanceCashAccounts } from '../server/finance/cash-accounts.js';
import { maker, period, request, workbook, findRow, checkLayout, fixture, prepare, next } from './finance-http-fixture.js';

type Api = (path: string, cookie?: string) => Promise<Response>;
/** 月度台账读接口回答里用到的：每行的状态，别的项原样留着（看有没有 detail） */
const ledgerAnswer = z.object({ rows: z.array(z.looseObject({ status: z.string() })) });
/** 被拦的导出回答里的类别 */
const blockedAnswer = z.object({ code: z.string() });

/**
 * 导出要的虚构账：下个月 5 号四张送货（300、0.01、0.02 元和没价格，客户名像公式），同步进财务；
 * 7 号这个客户和另一个客户各收 7 元（没核销、记预收）；15 号一笔银行未达账；本月 12 号买一台资产，下个月计提折旧。
 */
function exportWorld(store: Store) {
  const post = prepare(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '=1+1' }));
  const other = store.saveCustomer(customerSchema.parse({ name: '虚构预收客户' }));
  const insert = store.db.prepare(`INSERT INTO flow_documents(kind,number,date,planned_date,status,document,actor_id,actor_name,created_at,updated_at)
      VALUES('delivery',?,?,?,'confirmed',?,'seed','虚构导出测试',?,?)`);
  for (const [index, price] of ['300', '0.01', '0.02', undefined].entries()) {
    const date = next + '-05';
    const line = { orderId: 1, orderLineId: 1, stockId: 1, quantity: '1', unit: '只', unitPriceExact: price, taxMode: '未税' };
    const doc = { date, plannedDate: date, customerId: customer.id, customerName: customer.name, lines: [line] };
    insert.run('虚构送货-' + index, date, date, JSON.stringify(doc), date, date);
  }
  new FinanceEvents(store).sync(maker);
  const cash = new FinanceSettlements(store);
  const bank = new FinanceCashAccounts(store).saveAccount(maker, { ...request(), kind: 'bank', name: '虚构银行', accountCode: '1002' });
  for (const partyId of [customer.id, other.id]) {
    const saved = cash.saveCash(maker, {
      ...request(),
      kind: 'receipt',
      accountId: bank.id,
      partyId,
      date: next + '-07',
      amount: 700,
      method: '银行',
      description: '虚构收款',
    });
    cash.confirm(maker, saved.id, { ...request(), version: 1 });
  }
  post();
  new FinanceBank(store).import(maker, {
    ...request(),
    accountId: bank.id,
    rows: [{ date: next + '-15', amount: 100, reference: '=银行参考', description: '虚构未达账', party: customer.name }],
  });
  const assets = new FinanceAssets(store);
  assets.add(maker, {
    ...request(),
    date: period + '-12',
    number: '0001',
    name: '虚构资产',
    category: '设备',
    original: 120000,
    months: 12,
    residualBp: 0,
    department: '虚构部门',
    expenseAccount: '560205',
    counterAccount: '3001',
  });
  post();
  assets.depreciate(maker, { ...request(), period: next });
  return { customer, bank };
}

/** 下载一个导出：200、按附件下载、文件名、Excel 类型、不缓存，返回第一张表 */
const downloader = (api: Api) => async (path: string, filename: string) => {
  const response = await api(path);
  assert.equal(response.status, 200, response.ok ? undefined : await response.text());
  const disposition = response.headers.get('content-disposition');
  assert.ok(disposition, '响应带下载的文件名');
  assert.match(disposition, /^attachment;/);
  assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), filename + '.xlsx');
  assert.match(response.headers.get('content-type') ?? '', /spreadsheetml/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return (await workbook(Buffer.from(await response.arrayBuffer()))).worksheets[0];
};

/** 各条子测试用的：读接口、下载、虚构账里的客户和银行账户、下个月整月的日期条件 */
type Ctx = ReturnType<typeof exportWorld> & {
  store: Store;
  api: Api;
  download: ReturnType<typeof downloader>;
  from: string;
  to: string;
  dates: string;
};

async function ledgerExport({ api, download }: Ctx) {
  const flowHeaders = ['日期', '类型', '单号', '往来单位', '单据月份', '状态', '到期日', '金额', '已收付', '是否缺税率'];
  const filtered = await download(
    `/monthly-ledger/export?period=${next}&metric=theoreticalIncome&sourceMonth=${next}&missingTax=1&sort=oldest`,
    '月度台账-' + next,
  );
  checkLayout(filtered, flowHeaders, next);
  const sent = findRow(filtered, '虚构送货-0', 3);
  assert.equal(sent.getCell(2).value, '送货');
  assert.equal(sent.getCell(4).value, '=1+1');
  assert.equal(sent.getCell(4).type, ExcelJS.ValueType.String);
  assert.equal(sent.getCell(6).value, '待补税率');
  assert.equal(sent.getCell(8).value, 300);
  assert.equal(sent.getCell(8).numFmt, '#,##0.00');
  assert.equal(sent.getCell(10).value, '是');
  assert.equal(filtered.rowCount, 7);
  const sum = findRow(filtered, '合计');
  assert.equal(sum.getCell(8).value, 300.03);
  assert.equal(
    Math.round((filtered.getRows(4, 3) ?? []).reduce((n, row) => n + Number(row.getCell(8).value), 0) * 100),
    30003,
  );
  const query = ledgerAnswer.parse(await (await api(`/monthly-ledger?period=${next}&metric=theoreticalIncome&missingTax=1`)).json());
  assert.equal(query.rows[0].status, 'info_pending');
  assert.ok(Object.hasOwn(query.rows[0], 'detail'));

  // 概览下钻也用台账这一条导出，只带类型条件
  const detail = await download(`/monthly-ledger/export?period=${next}&metric=theoreticalIncome`, '月度台账-' + next);
  checkLayout(detail, flowHeaders, next);
  assert.equal(findRow(detail, '虚构送货-3', 3).getCell(8).value, '缺价格');
  assert.equal(findRow(detail, '合计（已知）').getCell(8).value, 300.03);
}

async function monthlyReportExport({ download }: Ctx) {
  const monthly = await download(`/monthly-report/export?period=${next}`, '月度经营报表-' + next);
  checkLayout(monthly, ['项目', '理论', '实际'], next);
  assert.equal(findRow(monthly, '收入').getCell(3).value, 14);
  assert.equal(findRow(monthly, '预收预付').getCell(2).value, 7);
  assert.equal(findRow(monthly, '没核销到单据').getCell(2).value, 7);
  for (const label of ['优惠', '利息', '保证金', '到期对照 · 应收', '到期对照 · 应付']) findRow(monthly, label);
}

async function formalReportsExport({ api, download }: Ctx) {
  for (const [kind, name, headers, label] of [
    ['balance', '资产负债表', ['项目', '期初', '期末'], '总计差额（平衡）'],
    ['profit', '利润表', ['项目', '本月', '本年累计'], '净利润'],
    ['cashflow', '现金流量表', ['项目', '科目编码', '金额'], '期末现金余额'],
    ['trial', '试算平衡表', ['科目编码', '科目', '期初', '借方', '贷方', '期末'], '合计（平衡）'],
  ] as const) {
    const sheet = await download(`/reports/${kind}/export?period=${period}`, name + '-' + period);
    checkLayout(sheet, [...headers], period);
    findRow(sheet, label);
    if (kind === 'cashflow') for (const group of ['经营活动', '投资活动', '筹资活动', '未归类']) findRow(sheet, group);
    if (kind !== 'trial') {
      assert.equal(sheet.getCell('A3').value, '报表项目和公式待财务复核，仅供内部参考');
      const blocked = await api(`/reports/${kind}/export?period=${next}`);
      assert.equal(blocked.status, 409);
      assert.equal(blockedAnswer.parse(await blocked.json()).code, 'FINANCE_INFO_PENDING');
    }
  }
}

async function bookExport({ download }: Ctx) {
  const book = await download(`/books/detail/export?period=${period}&account=1002`, '明细账-' + period);
  checkLayout(book, ['日期', '凭证号', '科目编码', '科目', '摘要', '辅助项', '借方（元）', '贷方（元）'], period);
  assert.equal(findRow(book, '=虚构凭证摘要', 5).getCell(7).value, 300);
  assert.equal(findRow(book, '合计').getCell(7).value, 300);
}

async function statementExport({ download, customer, from, to, dates }: Ctx) {
  const statement = await download(`/statements/export?kind=receivable&partyId=${customer.id}&${dates}`, `往来对账单-${from}-至-${to}`);
  checkLayout(statement, ['日期', '凭证号', '摘要', '到期日', '发生额'], next);
  assert.match(String(statement.getCell('A2').value), /应收单位：=1\+1/);
  // 这个客户 7 号收的 7 元没核销、记在预收上：对账单列出这笔，期末扣掉，末尾写一句
  // 摘要不用资金单上操作员填的“虚构收款”，写类型、日期、金额
  assert.equal(findRow(statement, '收客户款 ' + next.slice(5) + '-07 7.00（预收款）', 3).getCell(5).value, -7);
  assert.equal(findRow(statement, '期末余额', 3).getCell(5).value, 293.03);
  findRow(statement, '期末余额已扣掉还没抵货款的预收款 7.00 元。');
}

async function reconciliationExport({ download, bank, from, to, dates }: Ctx) {
  const reconciliation = await download(`/bank/reconcile/export?accountId=${bank.id}&bankBalance=100&${dates}`, `银行余额调节表-${from}-至-${to}`);
  checkLayout(reconciliation, ['项目', '金额'], next);
  assert.equal(findRow(reconciliation, '银行余额').getCell(2).value, 1);
  assert.equal(findRow(reconciliation, '=银行参考', 2).getCell(5).value, 1);
  for (const label of ['账面余额', '调节后差额', '银行未达账', '账面未达账']) findRow(reconciliation, label);
}

async function taxAndDepreciationExport({ download }: Ctx) {
  const tax = await download(`/tax/export?period=${next}`, '税务底稿-' + next);
  checkLayout(tax, ['项目', '金额'], next);
  assert.equal(tax.getCell(`A${tax.rowCount}`).value, '内部底稿，请以税局系统为准');
  const dep = await download(`/depreciation/export?period=${next}`, '折旧明细-' + next);
  checkLayout(dep, ['编号', '名称', '部门', '折旧额'], next);
  assert.equal(findRow(dep, '0001').getCell(4).value, 100);
  assert.equal(findRow(dep, '合计').getCell(4).value, 100);
}

async function unknownReport({ api }: Ctx) {
  const invalid = await api(`/reports/invalid/export?period=${period}`);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { message: '填写内容或筛选条件无效，请检查后重试。' });
}

async function bulkLedgerExport({ store, download, customer }: Ctx) {
  const bulkPeriod = '2026-12',
    bulkDate = bulkPeriod + '-05';
  store.db
    .prepare(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<205)
        INSERT INTO flow_documents(kind,number,date,planned_date,status,document,actor_id,actor_name,created_at,updated_at)
        SELECT 'delivery','虚构批量-'||n,?,?,'confirmed',
          json_object('date',?,'plannedDate',?,'customerId',?,'customerName',?,
            'lines',json('[{"orderId":1,"orderLineId":1,"stockId":1,"quantity":"1","unit":"只","unitPriceExact":"0.01","taxMode":"未税","taxRate":"0"}]')),
          'seed','虚构导出测试',?,? FROM seq`)
    .run(bulkDate, bulkDate, bulkDate, bulkDate, customer.id, customer.name, bulkDate, bulkDate);
  const bulk = await download(`/monthly-ledger/export?period=${bulkPeriod}&metric=theoreticalIncome&page=2&pageSize=1`, '月度台账-' + bulkPeriod);
  assert.equal(bulk.rowCount, 209);
  assert.equal(new Set(bulk.getRows(4, 205)?.map((row) => row.getCell(3).value)).size, 205);
  assert.equal(findRow(bulk, '合计').getCell(8).value, 2.05);
}

test('财务 Excel 下载：中文分段、金额按元、合计按整数分，保留筛选和待补状态', async (t) => {
  await fixture(async (store, api) => {
    const from = next + '-01',
      to = next + '-30';
    const ctx: Ctx = { ...exportWorld(store), store, api, download: downloader(api), from, to, dates: `from=${from}&to=${to}` };
    await t.test('月度台账：按筛选导出，金额是元、合计按整数分，公式样的往来单位原样当文字；概览下钻带同一条导出', () => ledgerExport(ctx));
    await t.test('月度经营报表：理论和实际两列，预收预付、优惠利息保证金、到期对照各有一行', () => monthlyReportExport(ctx));
    await t.test('四张报表：中文分段、写明待复核；有待补税率的月份正式报表被拦', () => formalReportsExport(ctx));
    await t.test('明细账：摘要原样当文字，借贷按元，合计对得上', () => bookExport(ctx));
    await t.test('往来对账单：没核销的预收列出并在期末扣掉，摘要写类型日期金额', () => statementExport(ctx));
    await t.test('银行余额调节表：银行余额、调节后差额和两边未达账', () => reconciliationExport(ctx));
    await t.test('税务底稿和折旧明细：写明内部底稿，折旧额和合计', () => taxAndDepreciationExport(ctx));
    await t.test('不认识的报表地址：报中文错，不露英文', () => unknownReport(ctx));
    await t.test('月度台账导出不分页：两百多行一次导出，合计按全部', () => bulkLedgerExport(ctx));
  });
});
