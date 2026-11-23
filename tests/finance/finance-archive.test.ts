// 结账归档 ZIP（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { buffer } from 'node:stream/consumers';
import yauzl from 'yauzl';
import { z } from 'zod';
import type { Store } from '../../server/core/index.js';
import { FinanceAssets } from '../../server/finance/expenses/assets.js';
import { FinanceClosing } from '../../server/finance/reports/closing.js';
import { FinanceCosting } from '../../server/finance/costing/costing.js';
import { FinancePayroll } from '../../server/finance/expenses/payroll.js';
import { maker, period, request, password, workbook, findRow, checkLayout, fixture, prepare } from './finance-http-fixture.js';
import { cookieOf } from '../support/http-fixture.js';

/** 归档里的清单：期间、报表快照版本、各文件的名字大小和 sha256 */
const manifestSchema = z.object({
  period: z.string(),
  version: z.number(),
  files: z.array(z.object({ name: z.string(), size: z.number(), sha256: z.string() })),
});

/** 月末折旧、工资、成本、税费、损益结转都记账，然后结账 */
function closePeriod(store: Store, post: () => void) {
  new FinanceAssets(store).depreciate(maker, { ...request(), period });
  new FinancePayroll(store).confirm(maker, { ...request(), period });
  new FinanceCosting(store).run(maker, { ...request(), period });
  const closing = new FinanceClosing(store);
  closing.accrueTax(maker, { ...request(), period });
  post();
  closing.settleProfit(maker, { ...request(), period });
  post();
  closing.close(maker, { ...request(), period, version: 1 });
  return closing;
}

/** 解包：每个文件都是 deflate、文件名按 UTF-8 标记，CRC 和大小对得上；返回文件名到内容 */
async function unzipChecked(bytes: Buffer) {
  const archive = await yauzl.fromBufferPromise(bytes, { lazyEntries: true });
  const extracted = new Map<string, Buffer>();
  try {
    for await (const item of archive.eachEntry()) {
      assert.equal(item.compressionMethod, 8);
      assert.ok(item.generalPurposeBitFlag & (1 << 11));
      const content = await buffer(await archive.openReadStreamPromise(item));
      assert.equal(crc32(content), item.crc32);
      assert.equal(content.length, item.uncompressedSize);
      extracted.set(item.fileName, content);
    }
  } finally {
    archive.close();
  }
  const file = (name: string) => {
    const content = extracted.get(name);
    assert.ok(content, '归档里有 ' + name);
    return content;
  };
  return { names: [...extracted.keys()], file };
}

test('结账归档 ZIP 能解包，CRC、UTF-8 标记、清单和三个中文工作簿均可核对', async () => {
  await fixture(async (store, api, admin) => {
    const post = prepare(store);
    const suffix = '?period=' + period;
    const zipOpen = await api('/archive/download' + suffix);
    assert.notEqual(zipOpen.status, 200, '还没结账的月份没有归档可下载');
    assert.equal((await api('/archive/download' + suffix, '')).status, 401);
    const staff = await admin('/users', { name: '虚构出纳', password, level: 'cashier' });
    assert.equal(staff.status, 201);
    const login = await admin('/login', { name: '虚构出纳', password });
    const cashier = cookieOf(login);
    assert.equal((await api('/archive/download' + suffix, cashier)).status, 403);

    const closing = closePeriod(store, post);
    const zipped = await api('/archive/download' + suffix);
    assert.equal(zipped.status, 200);
    assert.equal(zipped.headers.get('content-type'), 'application/zip');
    const disposition = zipped.headers.get('content-disposition');
    assert.ok(disposition, '响应带下载的文件名');
    assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), '财务归档-' + period + '.zip');
    const { names, file: extracted } = await unzipChecked(Buffer.from(await zipped.arrayBuffer()));
    assert.deepEqual(names, ['vouchers.xlsx', 'journal.xlsx', 'reports.xlsx', 'manifest.json']);
    const manifest = manifestSchema.parse(JSON.parse(extracted('manifest.json').toString()));
    assert.equal(manifest.period, period);
    assert.equal(manifest.version, 2, '清单的版本是结账时那份报表快照的版本');
    assert.deepEqual(
      manifest.files.map((file) => file.name),
      ['vouchers.xlsx', 'journal.xlsx', 'reports.xlsx'],
    );
    for (const file of manifest.files) {
      const bytes = extracted(file.name);
      assert.equal(bytes.length, file.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
    const vouchers = (await workbook(extracted('vouchers.xlsx'))).worksheets[0];
    checkLayout(
      vouchers,
      ['日期', '凭证号', '摘要', '状态', '制单人', '审核人', '记账人', '借方', '贷方'],
      period,
    );
    assert.equal(findRow(vouchers, '=虚构凭证摘要', 3).getCell(8).value, 300);
    const journal = (await workbook(extracted('journal.xlsx'))).worksheets[0];
    checkLayout(
      journal,
      ['日期', '凭证号', '科目编码', '科目', '摘要', '辅助项', '借方（元）', '贷方（元）'],
      period,
    );
    const report = await workbook(extracted('reports.xlsx'));
    assert.deepEqual(
      report.worksheets.map((sheet) => sheet.name),
      ['资产负债表', '利润表', '现金流量表'],
    );
    const profit = report.getWorksheet('利润表');
    assert.ok(profit, '报表工作簿有利润表');
    assert.equal(findRow(profit, '净利润').getCell(2).value, 300);
    closing.reopen(maker, { ...request(), period, version: 2, reason: '虚构反结账' });
    assert.equal((await api('/archive/download' + suffix)).status, zipOpen.status);
  });
});
