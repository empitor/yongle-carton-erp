import { createHash } from 'node:crypto';
import { z } from 'zod';
import { periodSchema } from '../../shared/finance.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { FinanceLedger } from './ledger.js';
import { FinanceReports } from './reports.js';
import { FinanceInvoices } from './invoices.js';
import { FinanceBooks } from './books.js';
import { periodJob } from './jobs.js';
import { activeCashAllocation } from './pending-delivery.js';
import { reportWorkbook, voucherWorkbook } from './exports.js';
import type { ExportRow } from './export-workbook.js';
import { archiveZip } from './archive-zip.js';
import {
  adjacentPeriod,
  edit,
  entry,
  endOfMonth,
  label,
  proportion,
  request,
} from './query.js';

const periodInput = z.object({ period: periodSchema });
const snapshotKinds = ['balance', 'profit', 'cashflow'] as const;
export class FinanceClosing {
  private ledger: FinanceLedger;
  private reports: FinanceReports;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
    this.reports = new FinanceReports(store);
  }
  private get db() {
    return this.store.db;
  }

  check(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor),
      { period } = periodInput.parse(raw);
    const start = this.db.prepare('SELECT start_period FROM fin_settings WHERE id=1').get()!
      .start_period;
    const latest = this.db
      .prepare("SELECT max(period) AS period FROM fin_periods WHERE status='closed'")
      .get()?.period;
    const next = latest ? adjacentPeriod(String(latest), 1) : (start ?? null);
    const record = this.db.prepare('SELECT * FROM fin_periods WHERE period=?').get(period);
    const readiness = this.reports.readiness(user, { period });
    const count = (sql: string, ...args: string[]) => Number(this.db.prepare(sql).get(...args)?.n);
    const outstanding =
      readiness.unsynced +
      count(
        `SELECT count(*) AS n FROM fin_events e
      WHERE substr(date,1,7)<=? AND status IN ('info_pending','ready','difference','source_deleted','cost_pending','waiting_invoice','awaiting_allocation_reversal')
      AND NOT (status='info_pending' AND source_kind='delivery' AND EXISTS(
        SELECT 1 FROM flow_documents f WHERE f.id=cast(e.source_id AS INTEGER) AND f.kind='delivery' AND f.status='reversed')
        AND NOT EXISTS(SELECT 1 FROM fin_obligations o JOIN fin_allocations a ON a.obligation_id=o.id
          JOIN fin_vouchers original ON original.id=a.voucher_id WHERE o.event_id=e.id AND ${activeCashAllocation}))`,
        period,
      );
    const unposted = count(
      "SELECT count(*) AS n FROM fin_vouchers WHERE period<=? AND status NOT IN ('posted','void')",
      period,
    );
    const runs = this.db
      .prepare(
        `SELECT j.kind,j.voucher_id,v.status FROM fin_period_jobs j LEFT JOIN fin_vouchers v ON v.id=j.voucher_id
      WHERE j.period=?`,
      )
      .all(period);
    const has = (kind: string) =>
      runs.some((r) => r.kind === kind && (r.voucher_id === null || r.status === 'posted'));
    const required = ['depreciation', 'payroll', 'costing', 'tax'];
    const trial =
      start && period >= String(start) ? this.reports.get(user, 'trial', { period }) : null;
    const balance =
      trial && readiness.ready ? this.reports.get(user, 'balance', { period }, false) : null;
    const bank = count(
      'SELECT count(*) AS n FROM fin_bank_rows WHERE substr(date,1,7)<=? AND voucher_id IS NULL',
      period,
    );
    const steps = [
      { key: 'events', ok: !outstanding, count: outstanding, blocking: true },
      { key: 'vouchers', ok: !unposted, count: unposted, blocking: true },
      {
        key: 'jobs',
        ok: required.every(has),
        missing: required.filter((key) => !has(key)),
        blocking: true,
      },
      { key: 'bank', ok: !bank, count: bank, blocking: false },
      { key: 'trial', ok: trial?.balanced === true, blocking: true },
      { key: 'balance', ok: balance?.balanced === true, blocking: true },
      {
        key: 'profit',
        ok: has('profit_close') && (!period.endsWith('-12') || has('annual_close')),
        // 12 月分两步：先月末损益，记账后再年度利润。
        annualNext: period.endsWith('-12') && has('profit_close') && !has('annual_close'),
        blocking: true,
      },
    ];
    return {
      period,
      next,
      record: record ?? null,
      readiness,
      steps,
      canClose: period === next && steps.every((s) => !s.blocking || s.ok),
    };
  }

  accrueTax(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = request.extend({ period: periodSchema }).parse(raw);
    return financeWrite(this.store, user, 'closing.tax', v, () => {
      const date = endOfMonth(v.period);
      this.ledger.openPeriod(user, date);
      const tax = new FinanceInvoices(this.store).tax(user, v);
      const b = this.db
        .prepare(
          `SELECT coalesce(sum((credit-debit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)),0) AS profit
        FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id JOIN fin_accounts a ON a.code=e.account_code
        WHERE v.status='posted' AND v.period=? AND a.category='profit' AND e.account_code NOT LIKE '5801%'
        AND coalesce(v.module_source,'') NOT IN ('profit_close','annual_close')`,
        )
        .get(v.period);
      if (tax.payable == null && tax.taxpayer === 'small') financeError('请到财务设置填写小规模征收率。');
      const surcharges = [
        ['222102', tax.urban],
        ['222103', tax.education],
        ['222104', tax.localEducation],
      ] as const;
      if (Number(tax.payable) > 0 && surcharges.some(([, value]) => value == null))
        financeError('本月有应交增值税，请到财务设置填写附加税率，不用缴的填 0。');
      const pretax = Math.max(0, Number(b?.profit)),
        rate = tax.rates.income;
      if (pretax && rate == null) financeError('本月有利润，请到财务设置填写所得税率，暂不计提的填 0。');
      const extra = surcharges.reduce((n, [, value]) => n + (value ?? 0), 0);
      const income = rate == null ? 0 : proportion(Math.max(0, pretax - extra), rate, 10000);
      const entries = extra
        ? [
            entry('5403', extra, 0),
            ...surcharges.flatMap(([code, amount]) => (amount ? [entry(code, 0, amount)] : [])),
          ]
        : [];
      if (income) entries.push(entry('5801', income, 0), entry('222105', 0, income));
      const voucher = entries.length
        ? Number(
            this.ledger.createLinked(
              user,
              'tax',
              Number(v.period.replace('-', '')),
              { date, requestId: v.requestId, description: '税费计提', entries },
              'finance:close',
            ).header.id,
          )
        : null;
      return periodJob(this.store, user, v.period, 'tax', voucher, { ...tax, pretax, income });
    });
  }

  settleProfit(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = request
      .extend({ period: periodSchema, annual: z.boolean().default(false) })
      .parse(raw);
    return financeWrite(this.store, user, 'closing.profit', v, () => {
      const date = endOfMonth(v.period);
      this.ledger.openPeriod(user, date);
      if (
        this.db
          .prepare("SELECT 1 FROM fin_vouchers WHERE period=? AND status NOT IN ('posted','void')")
          .get(v.period)
      )
        financeError('请先处理本期全部未记账凭证。');
      const check = this.check(user, v);
      if (check.next !== v.period) financeError('须按顺序结转损益。', 409);
      if (!check.steps.filter((s) => s.blocking && s.key !== 'profit').every((s) => s.ok))
        financeError('请先完成结账向导的前置检查。', 409);
      let entries;
      if (v.annual) {
        if (!v.period.endsWith('-12')) financeError('仅 12 月可结转年度利润。');
        const prior = this.db
          .prepare(
            "SELECT j.*,v.status FROM fin_period_jobs j LEFT JOIN fin_vouchers v ON v.id=j.voucher_id WHERE j.period=? AND j.kind='profit_close'",
          )
          .get(v.period);
        if (!prior || (prior.voucher_id && prior.status !== 'posted'))
          financeError('请先记账月末损益结转。');
        const value = this.reports
          .balances(user, v.period)
          .filter((r) => r.account_code.startsWith('3103'))
          .reduce((n, r) => n + r.ending, 0);
        entries = value
          ? [
              entry('3103', Math.max(-value, 0), Math.max(value, 0)),
              entry('3104', Math.max(value, 0), Math.max(-value, 0)),
            ]
          : [];
      } else entries = this.reports.profitClosingEntries(user, v.period);
      const kind = v.annual ? 'annual_close' : 'profit_close';
      const previous = this.db
        .prepare('SELECT * FROM fin_period_jobs WHERE period=? AND kind=?')
        .get(v.period, kind);
      if (previous && !entries.length) financeError('该期间已结转且无新增损益。', 409);
      const voucher = entries.length
        ? Number(
            this.ledger.createLinked(
              user,
              kind,
              Number(v.period.replace('-', '')),
              {
                date,
                requestId: v.requestId,
                description: v.annual ? '年度利润结转' : '月末损益结转',
                entries,
              },
              'finance:close',
            ).header.id,
          )
        : null;
      if (previous) {
        const details = { entries: entries.length, previousVoucher: previous.voucher_id };
        this.db
          .prepare('UPDATE fin_period_jobs SET voucher_id=?,details=? WHERE period=? AND kind=?')
          .run(voucher, JSON.stringify(details), v.period, kind);
        const after = { period: v.period, kind, voucherId: voucher, details };
        financeAudit(this.store, user, 'supplement', 'fin_period_jobs', null, previous, after);
        return after;
      }
      return periodJob(this.store, user, v.period, kind, voucher, { entries: entries.length });
    });
  }

  close(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = edit.extend({ period: periodSchema }).parse(raw);
    return financeWrite(this.store, user, 'closing.close', v, () => {
      this.reports.assertReady(user, v.period);
      const before = this.check(user, v);
      if (!before.record || !before.canClose)
        financeError('结账检查未通过，或期间顺序不正确。', 409);
      checkVersion(before.record, v.version);
      if (this.reports.profitClosingEntries(user, v.period).length)
        financeError('损益结转后又有新发生，请先补齐结转。', 409);
      const document = Object.fromEntries(
        snapshotKinds.map((kind) => [kind, this.reports.get(user, kind, v, false)]),
      );
      this.db
        .prepare("UPDATE fin_periods SET status='closed',version=version+1 WHERE period=?")
        .run(v.period);
      this.db
        .prepare('INSERT INTO fin_report_snapshots VALUES(?,?,?,?)')
        .run(v.period, v.version + 1, JSON.stringify(document), new Date().toISOString());
      const after = this.db.prepare('SELECT * FROM fin_periods WHERE period=?').get(v.period)!;
      financeAudit(this.store, user, 'close', 'fin_periods', null, before.record, after);
      return { ...after };
    });
  }

  reopen(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = edit.extend({ period: periodSchema, reason: label }).parse(raw);
    if (v.period.endsWith('-12') && user.role !== 'super_admin')
      financeError('年度反结账只允许管理员。', 403);
    return financeWrite(this.store, user, 'closing.reopen', v, () => {
      const before = this.db
        .prepare("SELECT * FROM fin_periods WHERE status='closed' ORDER BY period DESC LIMIT 1")
        .get();
      if (!before || before.period !== v.period) financeError('只能反结最近一个已结期间。', 409);
      checkVersion(before, v.version);
      this.db
        .prepare("UPDATE fin_periods SET status='open',version=version+1 WHERE period=?")
        .run(v.period);
      const after = this.db.prepare('SELECT * FROM fin_periods WHERE period=?').get(v.period)!;
      financeAudit(this.store, user, 'reopen', 'fin_periods', null, before, {
        ...after,
        reason: v.reason,
      });
      return { ...after };
    });
  }

  private async archiveFiles(actor: Actor | null, raw: unknown, closedOnly = false) {
    const user = financeActor(actor, 'finance:close'),
      { period } = periodInput.parse(raw);
    const snapshot = this.db
      .prepare('SELECT * FROM fin_report_snapshots WHERE period=? ORDER BY version DESC LIMIT 1')
      .get(period);
    if (!snapshot || (closedOnly && !this.db.prepare("SELECT 1 FROM fin_periods WHERE period=? AND status='closed'").get(period)))
      financeError('该期间没有归档报表快照。');
    const vouchers = this.db
      .prepare(`SELECT v.date,v.number,v.description,v.status,v.maker_name,v.approver_name,v.poster_name,v.reversal_of,
        coalesce(sum(e.debit),0)*CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END AS debit,
        coalesce(sum(e.credit),0)*CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END AS credit
        FROM fin_vouchers v LEFT JOIN fin_entries e ON e.voucher_id=v.id
        WHERE v.period=? AND v.status='posted' GROUP BY v.id ORDER BY v.number`)
      .all(period);
    const reports = JSON.parse(String(snapshot.document)) as Record<typeof snapshotKinds[number], ExportRow>;
    const files = await Promise.all([
      { name: 'vouchers.xlsx', bytes: voucherWorkbook(period, vouchers) },
      { name: 'journal.xlsx', bytes: new FinanceBooks(this.store).export(user, 'journal', { period }).bytes },
      { name: 'reports.xlsx', bytes: reportWorkbook(period, snapshotKinds.map((kind) => ({ kind, data: reports[kind] }))) },
    ].map(async (file) => {
      const bytes = await file.bytes;
      return { name: file.name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
    }));
    return { period, version: snapshot.version, files };
  }

  async archive(actor: Actor | null, raw: unknown) {
    const { period, version, files } = await this.archiveFiles(actor, raw);
    return { period, version, files: files.map(({ bytes, ...file }) => ({ ...file, base64: bytes.toString('base64') })) };
  }

  async downloadArchive(actor: Actor | null, raw: unknown) {
    const { period, version, files } = await this.archiveFiles(actor, raw, true);
    const manifest = { period, version, files: files.map(({ name, size, sha256 }) => ({ name, size, sha256 })) };
    const bytes = archiveZip([...files, { name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2)) }]);
    return { period, bytes };
  }
}
