/** 结账归档：已结期间的报表快照、凭证汇总、日记账打成几张表，给页面下载或打成压缩包 */
import { createHash } from 'node:crypto';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { exists, many, one, rows } from '../core/index.js';
import { financeActor, financeError } from './core.js';
import { FinanceBooks } from './books.js';
import { voucherWorkbook } from './exports.js';
import { reportWorkbook } from './export-reports.js';
import { archiveZip } from './archive-zip.js';
import { z } from 'zod';
import { periodSchema, snapshotKinds } from '../../shared/finance/index.js';
import { readReportSnapshot } from './report-shapes.js';
import { savedReport } from './report-sheets.js';

const periodInput = z.object({ period: periodSchema });
const voucher = rows.fin_vouchers.shape;
/** 已记账凭证清单一行：凭证头和借贷合计（红字凭证取负） */
const voucherTotal = z.object({
  date: voucher.date,
  number: voucher.number,
  description: voucher.description,
  status: voucher.status,
  maker_name: voucher.maker_name,
  approver_name: voucher.approver_name,
  poster_name: voucher.poster_name,
  reversal_of: voucher.reversal_of,
  debit: z.number(),
  credit: z.number(),
});

export class FinanceArchive {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }

  /** 已结账月份的归档文件：凭证、序时账、结账时的报表快照（反结账后快照还在，月份没结账就不给） */
  private async archiveFiles(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close'),
      { period } = periodInput.parse(raw);
    const snapshot = one(
      this.db,
      rows.fin_report_snapshots,
      'SELECT * FROM fin_report_snapshots WHERE period=? ORDER BY version DESC LIMIT 1',
      period,
    );
    if (!snapshot || !exists(this.db, "SELECT 1 FROM fin_periods WHERE period=? AND status='closed'", period))
      financeError('该期间没有归档报表快照。');
    const vouchers = many(
      this.db,
      voucherTotal,
      `SELECT v.date,v.number,v.description,v.status,v.maker_name,v.approver_name,v.poster_name,v.reversal_of,
        coalesce(sum(e.debit),0)*CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END AS debit,
        coalesce(sum(e.credit),0)*CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END AS credit
        FROM fin_vouchers v LEFT JOIN fin_entries e ON e.voucher_id=v.id
        WHERE v.period=? AND v.status='posted' GROUP BY v.id ORDER BY v.number`,
      period,
    );
    const reports = readReportSnapshot(snapshot);
    const files = await Promise.all([
      { name: 'vouchers.xlsx', bytes: voucherWorkbook(period, vouchers) },
      { name: 'journal.xlsx', bytes: new FinanceBooks(this.store).export(user, 'journal', { period }).bytes },
      { name: 'reports.xlsx', bytes: reportWorkbook(period, snapshotKinds.map((kind) => savedReport(reports, kind))) },
    ].map(async (file) => {
      const bytes = await file.bytes;
      return { name: file.name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
    }));
    return { period, version: snapshot.version, files };
  }

  async downloadArchive(actor: Actor | null, raw: unknown) {
    const { period, version, files } = await this.archiveFiles(actor, raw);
    const manifest = { period, version, files: files.map(({ name, size, sha256 }) => ({ name, size, sha256 })) };
    const bytes = archiveZip([...files, { name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2)) }]);
    return { period, bytes };
  }
}
