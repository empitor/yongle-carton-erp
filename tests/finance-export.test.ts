import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { createApp } from '../server/app.js';
import { AuthManager } from '../server/auth.js';
import { Store } from '../server/db.js';
import { FinanceAssets } from '../server/finance/assets.js';
import { FinanceBank } from '../server/finance/bank.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { FinanceCosting } from '../server/finance/costing.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinancePayroll } from '../server/finance/payroll.js';
import { entry } from '../server/finance/query.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceSettlements } from '../server/finance/settlements.js';
import { customerSchema } from '../shared/domain.js';
import { financePermissions } from '../shared/finance.js';

const maker = { id: 'export-maker', name: '虚构制单员', permissions: [...financePermissions] };
const reviewer = { ...maker, id: 'export-reviewer' };
const period = '2026-10',
  next = '2026-11';
const request = () => ({ requestId: randomUUID() });
const password = 'fictional-export-password';

async function workbook(bytes: Buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]);
  return book;
}

function findRow(sheet: ExcelJS.Worksheet, value: string, column = 1) {
  const result = sheet
    .getRows(1, sheet.rowCount)
    ?.find((row) => row.getCell(column).value === value);
  assert.ok(result, `找不到行 ${value}`);
  return result;
}

function checkLayout(sheet: ExcelJS.Worksheet, headers: string[], period: string) {
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

async function fixture(
  work: (
    store: Store,
    api: (path: string, cookie?: string) => Promise<Response>,
    admin: (path: string, body: unknown) => Promise<Response>,
  ) => Promise<void>,
) {
  const store = new Store(':memory:');
  const auth = new AuthManager(':memory:');
  const server = createServer(createApp(store, { auth }));
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api`;
    let cookie = '';
    const admin = (path: string, body: unknown) =>
      fetch(base + '/auth' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'x-erp-auth-token': auth.csrf },
        body: JSON.stringify(body),
      });
    const login = await admin('/setup', { name: '虚构导出管理员', password });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie')!.split(';')[0];
    await work(
      store,
      (path, session = cookie) =>
        fetch(base + '/finance' + path, {
          headers: { cookie: session },
        }),
      admin,
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    auth.close();
    store.close();
  }
}

function prepare(store: Store) {
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
  const post = () => {
    for (const { id } of store.db
      .prepare("SELECT id FROM fin_vouchers WHERE status='draft' ORDER BY id")
      .all()) {
      ledger.transition(maker, id, 'submit', { ...request(), version: 1 });
      ledger.transition(reviewer, id, 'approve', { ...request(), version: 2 });
      ledger.transition(reviewer, id, 'post', { ...request(), version: 3 });
    }
  };
  ledger.create(maker, {
    ...request(),
    date: period + '-12',
    description: '=虚构凭证摘要',
    entries: [
      entry('1002', 30000, 0, null, '收到其他经营活动现金', '=虚构凭证摘要'),
      entry('5301', 0, 30000),
    ],
  });
  post();
  return post;
}

test('财务 Excel 下载用中文分段、数值元、整数分合计，保留筛选及待补状态', async () => {
  await fixture(async (store, api) => {
    const post = prepare(store);
    const customer = store.saveCustomer(customerSchema.parse({ name: '=1+1' }));
    const other = store.saveCustomer(customerSchema.parse({ name: '虚构预收客户' }));
    const insert = store.db
      .prepare(`INSERT INTO flow_documents(kind,number,date,status,document,actor_id,actor_name,created_at,updated_at)
      VALUES('delivery',?,?,'confirmed',?,'seed','虚构导出测试',?,?)`);
    for (const [index, price] of ['300', '0.01', '0.02', undefined].entries()) {
      const date = next + '-05';
      const number = '虚构送货-' + index;
      insert.run(
        number,
        date,
        JSON.stringify({
          number,
          customerId: customer.id,
          customerName: customer.name,
          lines: [{ quantity: '1', unit: '只', unitPriceExact: price, taxMode: '未税' }],
        }),
        date,
        date,
      );
    }
    new FinanceEvents(store).sync(maker, request());
    const cash = new FinanceSettlements(store);
    const bank = cash.saveAccount(maker, {
      ...request(),
      kind: 'bank',
      name: '虚构银行',
      accountCode: '1002',
    });
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
      rows: [
        {
          date: next + '-15',
          amount: 100,
          reference: '=银行参考',
          description: '虚构未达账',
          party: customer.name,
        },
      ],
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

    const download = async (path: string, filename: string) => {
      const response = await api(path);
      assert.equal(response.status, 200, response.ok ? undefined : await response.text());
      const disposition = response.headers.get('content-disposition')!;
      assert.match(disposition, /^attachment;/);
      assert.equal(
        decodeURIComponent(disposition.split("filename*=UTF-8''")[1]),
        filename + '.xlsx',
      );
      assert.match(response.headers.get('content-type') ?? '', /spreadsheetml/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return (await workbook(Buffer.from(await response.arrayBuffer()))).worksheets[0];
    };

    const flowHeaders = [
      '日期',
      '类型',
      '单号',
      '往来单位',
      '单据月份',
      '状态',
      '到期日',
      '金额',
      '已收付',
      '是否缺税率',
    ];
    const filtered = await download(
      `/flow/export?period=${next}&metric=theoreticalIncome&sourceMonth=${next}&missingTax=1&sort=oldest`,
      '月度台账-' + next,
    );
    checkLayout(filtered, flowHeaders, next);
    const sent = findRow(filtered, '虚构送货-0', 3);
    assert.equal(sent.getCell(2).value, '送货');
    assert.equal(sent.getCell(4).value, '=1+1');
    assert.equal(sent.getCell(4).type, ExcelJS.ValueType.String);
    assert.equal(sent.getCell(6).value, '待补资料');
    assert.equal(sent.getCell(8).value, 300);
    assert.equal(sent.getCell(8).numFmt, '#,##0.00');
    assert.equal(sent.getCell(10).value, '是');
    assert.equal(filtered.rowCount, 7);
    const sum = findRow(filtered, '合计');
    assert.equal(sum.getCell(8).value, 300.03);
    assert.equal(
      Math.round(
        (filtered.getRows(4, 3) ?? []).reduce((n, row) => n + Number(row.getCell(8).value), 0) *
          100,
      ),
      30003,
    );
    const query = await (
      await api(`/flow?period=${next}&metric=theoreticalIncome&missingTax=1`)
    ).json();
    assert.equal(query.rows[0].status, 'info_pending');
    assert.ok(Object.hasOwn(query.rows[0], 'detail'));

    const detail = await download(
      `/monthly-report/detail/export?period=${next}&metric=theoreticalIncome`,
      '经营明细-' + next,
    );
    checkLayout(detail, ['日期', '类型', '单号', '往来单位', '单据月份', '状态', '金额'], next);
    assert.equal(findRow(detail, '虚构送货-3', 3).getCell(7).value, '缺价格');
    assert.equal(findRow(detail, '合计（已知）').getCell(7).value, 300.03);

    const monthly = await download(`/monthly-report/export?period=${next}`, '月度经营报表-' + next);
    checkLayout(monthly, ['项目', '理论', '实际'], next);
    assert.equal(findRow(monthly, '收入').getCell(3).value, 14);
    assert.equal(findRow(monthly, '预收预付').getCell(2).value, 7);
    assert.equal(findRow(monthly, '未核销').getCell(2).value, 7);
    for (const label of ['优惠', '利息', '保证金', '到期对照 · 应收', '到期对照 · 应付'])
      findRow(monthly, label);

    for (const [kind, name, headers, label] of [
      ['balance', '资产负债表', ['项目', '期初', '期末'], '总计差额（平衡）'],
      ['profit', '利润表', ['项目', '本月', '本年累计'], '净利润'],
      ['cashflow', '现金流量表', ['项目', '科目编码', '金额'], '期末现金余额'],
      ['trial', '试算平衡表', ['科目编码', '科目', '期初', '借方', '贷方', '期末'], '合计（平衡）'],
    ] as const) {
      const sheet = await download(`/reports/${kind}/export?period=${period}`, name + '-' + period);
      checkLayout(sheet, [...headers], period);
      findRow(sheet, label);
      if (kind === 'cashflow')
        for (const group of ['经营活动', '投资活动', '筹资活动', '未归类']) findRow(sheet, group);
      if (kind !== 'trial') {
        assert.equal(sheet.getCell('A3').value, '报表项目和公式待财务复核，仅供内部参考');
        const blocked = await api(`/reports/${kind}/export?period=${next}`);
        assert.equal(blocked.status, 409);
        assert.equal((await blocked.json()).code, 'FINANCE_INFO_PENDING');
      }
    }
    const book = await download(
      `/books/detail/export?period=${period}&account=1002`,
      '明细账-' + period,
    );
    checkLayout(
      book,
      ['日期', '凭证号', '科目编码', '科目', '摘要', '辅助项', '借方（元）', '贷方（元）'],
      period,
    );
    assert.equal(findRow(book, '=虚构凭证摘要', 5).getCell(7).value, 300);
    assert.equal(findRow(book, '合计').getCell(7).value, 300);
    const from = next + '-01',
      to = next + '-30',
      dates = `from=${from}&to=${to}`;
    const statement = await download(
      `/statements/export?kind=receivable&partyId=${customer.id}&${dates}`,
      `往来对账单-${from}-至-${to}`,
    );
    checkLayout(statement, ['日期', '凭证号', '摘要', '到期日', '发生额'], next);
    assert.match(String(statement.getCell('A2').value), /应收单位：=1\+1/);
    assert.equal(findRow(statement, '期末余额', 3).getCell(5).value, 300.03);
    const reconciliation = await download(
      `/bank/reconcile/export?accountId=${bank.id}&bankBalance=100&${dates}`,
      `银行余额调节表-${from}-至-${to}`,
    );
    checkLayout(reconciliation, ['项目', '金额'], next);
    assert.equal(findRow(reconciliation, '银行余额').getCell(2).value, 1);
    assert.equal(findRow(reconciliation, '=银行参考', 2).getCell(5).value, 1);
    for (const label of ['账面余额', '调节后差额', '银行未达账', '账面未达账'])
      findRow(reconciliation, label);
    const tax = await download(`/tax/export?period=${next}`, '税务底稿-' + next);
    checkLayout(tax, ['项目', '金额'], next);
    assert.equal(tax.getCell(`A${tax.rowCount}`).value, '内部底稿，请以税局系统为准');
    const dep = await download(`/depreciation/export?period=${next}`, '折旧明细-' + next);
    checkLayout(dep, ['编号', '名称', '部门', '折旧额'], next);
    assert.equal(findRow(dep, '0001').getCell(4).value, 100);
    assert.equal(findRow(dep, '合计').getCell(4).value, 100);
    const invalid = await api(`/reports/invalid/export?period=${period}`);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { message: '填写内容或筛选条件无效，请检查后重试。' });

    const bulkPeriod = '2026-12', bulkDate = bulkPeriod + '-05';
    store.db.prepare(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<205)
      INSERT INTO flow_documents(kind,number,date,status,document,actor_id,actor_name,created_at,updated_at)
      SELECT 'delivery','虚构批量-'||n,?,'confirmed',
        json_object('number','虚构批量-'||n,'customerId',?,'customerName',?,
          'lines',json('[{"quantity":"1","unit":"只","unitPriceExact":"0.01","taxMode":"未税","taxRate":"0"}]')),
        'seed','虚构导出测试',?,? FROM seq`).run(bulkDate, customer.id, customer.name, bulkDate, bulkDate);
    const bulk = await download(
      `/flow/export?period=${bulkPeriod}&metric=theoreticalIncome&page=2&pageSize=1`,
      '月度台账-' + bulkPeriod,
    );
    assert.equal(bulk.rowCount, 209);
    assert.equal(new Set(bulk.getRows(4, 205)?.map((row) => row.getCell(3).value)).size, 205);
    assert.equal(findRow(bulk, '合计').getCell(8).value, 2.05);
  });
});

test('结账归档 ZIP 能解包，CRC、UTF-8 标记、清单和三个中文工作簿均可核对', async () => {
  await fixture(async (store, api, admin) => {
    const post = prepare(store);
    const suffix = '?period=' + period;
    const legacyOpen = await api('/archive' + suffix);
    const zipOpen = await api('/archive/download' + suffix);
    assert.equal(zipOpen.status, legacyOpen.status);
    assert.deepEqual(await zipOpen.json(), await legacyOpen.json());
    assert.equal((await api('/archive/download' + suffix, '')).status, 401);
    const staff = await admin('/users', { name: '虚构出纳', password, level: 'cashier' });
    assert.equal(staff.status, 201);
    const login = await admin('/login', { name: '虚构出纳', password });
    const cashier = login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await api('/archive/download' + suffix, cashier)).status, 403);

    new FinanceAssets(store).depreciate(maker, { ...request(), period });
    new FinancePayroll(store).confirm(maker, { ...request(), period });
    new FinanceCosting(store).run(maker, { ...request(), period });
    const closing = new FinanceClosing(store);
    closing.accrueTax(maker, { ...request(), period });
    post();
    closing.settleProfit(maker, { ...request(), period });
    post();
    closing.close(maker, { ...request(), period, version: 1 });
    const zipped = await api('/archive/download' + suffix);
    assert.equal(zipped.status, 200);
    assert.equal(zipped.headers.get('content-type'), 'application/zip');
    assert.equal(
      decodeURIComponent(zipped.headers.get('content-disposition')!.split("filename*=UTF-8''")[1]),
      '财务归档-' + period + '.zip',
    );
    const archive = await yauzl.fromBufferPromise(Buffer.from(await zipped.arrayBuffer()), {
      lazyEntries: true,
    });
    const extracted = new Map<string, Buffer>();
    try {
      for await (const item of archive.eachEntry()) {
        assert.equal(item.compressionMethod, 8);
        assert.ok(item.generalPurposeBitFlag & (1 << 11));
        const stream = await archive.openReadStreamPromise(item);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        assert.equal(crc32(bytes), item.crc32);
        assert.equal(bytes.length, item.uncompressedSize);
        extracted.set(item.fileName, bytes);
      }
    } finally {
      archive.close();
    }
    assert.deepEqual(
      [...extracted.keys()],
      ['vouchers.xlsx', 'journal.xlsx', 'reports.xlsx', 'manifest.json'],
    );
    const manifest = JSON.parse(extracted.get('manifest.json')!.toString()) as {
      period: string;
      version: number;
      files: { name: string; size: number; sha256: string }[];
    };
    assert.equal(manifest.period, period);
    const legacy = await (await api('/archive' + suffix)).json();
    assert.equal(manifest.version, legacy.version);
    assert.deepEqual(
      manifest.files.map((file) => file.name),
      ['vouchers.xlsx', 'journal.xlsx', 'reports.xlsx'],
    );
    for (const file of manifest.files) {
      const bytes = extracted.get(file.name)!;
      assert.equal(bytes.length, file.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
    const vouchers = (await workbook(extracted.get('vouchers.xlsx')!)).worksheets[0];
    checkLayout(
      vouchers,
      ['日期', '凭证号', '摘要', '状态', '制单人', '审核人', '记账人', '借方', '贷方'],
      period,
    );
    assert.equal(findRow(vouchers, '=虚构凭证摘要', 3).getCell(8).value, 300);
    const journal = (await workbook(extracted.get('journal.xlsx')!)).worksheets[0];
    checkLayout(
      journal,
      ['日期', '凭证号', '科目编码', '科目', '摘要', '辅助项', '借方（元）', '贷方（元）'],
      period,
    );
    const report = await workbook(extracted.get('reports.xlsx')!);
    assert.deepEqual(
      report.worksheets.map((sheet) => sheet.name),
      ['资产负债表', '利润表', '现金流量表'],
    );
    assert.equal(findRow(report.getWorksheet('利润表')!, '净利润').getCell(2).value, 300);
    closing.reopen(maker, { ...request(), period, version: 2, reason: '虚构反结账' });
    assert.equal((await api('/archive' + suffix)).status, 200);
    assert.equal((await api('/archive/download' + suffix)).status, zipOpen.status);
  });
});
