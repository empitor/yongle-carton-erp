import { z } from 'zod';
import { dateSchema } from '../../shared/domain.js';
import { accountCodeSchema, centsSchema, periodSchema } from '../../shared/finance.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { FinanceLedger } from './ledger.js';
import {
  endOfMonth,
  entry,
  id,
  label,
  money,
  pageSql,
  proportion,
  request,
  row,
  edit,
} from './query.js';
import { periodJob } from './jobs.js';
import { financeTemplate } from './template.js';

export class FinanceAssets {
  private ledger: FinanceLedger;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
  }
  private get db() {
    return this.store.db;
  }
  list(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({ status: z.enum(['active', 'disposed']).optional(), department: label.optional() })
      .parse(raw);
    return pageSql(
      this.db,
      `SELECT a.*,coalesce((SELECT sum(d.amount_cents) FROM fin_depreciation d WHERE asset_id=a.id),0) AS accumulated
      FROM fin_assets a WHERE (? IS NULL OR status=?) AND (? IS NULL OR department=?)`,
      [q.status ?? null, q.status ?? null, q.department ?? null, q.department ?? null],
      raw,
      'date',
    );
  }
  add(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const v = request
      .extend({
        number: label,
        name: label,
        category: label,
        original: money,
        date: dateSchema,
        months: z.number().int().min(1).max(1200),
        residualBp: z.number().int().min(0).max(10000),
        department: label,
        expenseAccount: accountCodeSchema,
        counterAccount: accountCodeSchema,
        cashFlow: label.optional(),
      })
      .parse(raw);
    return financeWrite(this.store, user, 'assets.add', v, () => {
      if (this.db.prepare('SELECT 1 FROM fin_assets WHERE number=?').get(v.number))
        financeError('资产编号已存在。', 409);
      const key = Number(
        this.db
          .prepare(
            `INSERT INTO fin_assets(number,name,category,original_cents,date,months,residual_bp,department,
        expense_account,status) VALUES(?,?,?,?,?,?,?,?,?,'active')`,
          )
          .run(
            v.number,
            v.name,
            v.category,
            v.original,
            v.date,
            v.months,
            v.residualBp,
            v.department,
            v.expenseAccount,
          ).lastInsertRowid,
      );
      const voucher = this.ledger.createLinked(user, 'asset', key, {
        requestId: v.requestId,
        date: v.date,
        description: '资产入账 ' + v.name,
        entries: [
          entry(financeTemplate(this.store, 'asset')('asset'), v.original, 0),
          entry(v.counterAccount, 0, v.original, null, v.cashFlow ?? null),
        ],
      });
      this.db.prepare('UPDATE fin_assets SET voucher_id=? WHERE id=?').run(voucher.header.id, key);
      const after = row(this.db, 'fin_assets', key);
      financeAudit(this.store, user, 'create', 'fin_assets', key, null, after);
      return after;
    });
  }
  depreciate(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = request.extend({ period: periodSchema }).parse(raw);
    return financeWrite(this.store, user, 'assets.depreciate', v, () => {
      const date = endOfMonth(v.period);
      this.ledger.openPeriod(user, date);
      if (
        this.db
          .prepare("SELECT 1 FROM fin_period_jobs WHERE period=? AND kind='depreciation'")
          .get(v.period)
      )
        financeError('本月折旧已计提。', 409);
      const items = this.db
        .prepare(
          `SELECT a.*,coalesce((SELECT sum(d.amount_cents) FROM fin_depreciation d
        WHERE asset_id=a.id AND d.period<?),0) AS prior FROM fin_assets a JOIN fin_vouchers v ON v.id=a.voucher_id
        WHERE status='active' AND substr(a.date,1,7)<? AND v.status='posted' ORDER BY a.id`.replace(
            "WHERE status='active'",
            "WHERE a.status='active'",
          ),
        )
        .all(v.period, v.period);
      const [year, month] = v.period.split('-').map(Number);
      const lines = items.flatMap((a) => {
        const [y, m] = String(a.date).split('-').map(Number),
          months = Number(a.months);
        const cost = Number(a.original_cents),
          basis = cost - proportion(cost, Number(a.residual_bp), 10000);
        const age = (year - y) * 12 + month - m;
        const amount = proportion(basis, Math.min(age, months), months) - Number(a.prior);
        return amount > 0 ? [{ id: Number(a.id), account: String(a.expense_account), amount }] : [];
      });
      const grouped = new Map<string, number>();
      for (const item of lines)
        grouped.set(item.account, (grouped.get(item.account) ?? 0) + item.amount);
      const total = lines.reduce((n, l) => n + l.amount, 0);
      const voucher = total
        ? Number(
            this.ledger.createLinked(
              user,
              'depreciation',
              Number(v.period.replace('-', '')),
              {
                date,
                description: '月度折旧',
                requestId: v.requestId,
                entries: [
                  ...Array.from(grouped, ([code, amount]) => entry(code, amount, 0)),
                  entry(financeTemplate(this.store, 'asset')('depreciation'), 0, total),
                ],
              },
              'finance:close',
            ).header.id,
          )
        : null;
      if (voucher)
        for (const item of lines)
          this.db
            .prepare('INSERT INTO fin_depreciation VALUES(?,?,?,?)')
            .run(item.id, v.period, item.amount, voucher);
      return periodJob(this.store, user, v.period, 'depreciation', voucher, { total, lines });
    });
  }
  depreciation(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z.object({ period: periodSchema }).parse(raw);
    return pageSql(
      this.db,
      `SELECT d.*,a.number,a.name,a.department FROM fin_depreciation d
      JOIN fin_assets a ON a.id=d.asset_id WHERE d.period=?`,
      [q.period],
      raw,
      'asset_id',
    );
  }
  change(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit
      .extend({
        date: dateSchema,
        department: label,
        expenseAccount: accountCodeSchema,
        reason: label,
      })
      .parse(raw);
    return financeWrite(this.store, user, 'assets.change', { ...v, key }, () => {
      const before = row(this.db, 'fin_assets', key);
      checkVersion(before, v.version);
      this.ledger.openPeriod(user, v.date);
      if (before.status !== 'active') financeError('已处置资产不能变动。');
      this.db
        .prepare(
          'UPDATE fin_assets SET department=?,expense_account=?,version=version+1 WHERE id=?',
        )
        .run(v.department, v.expenseAccount, key);
      const after = row(this.db, 'fin_assets', key);
      financeAudit(this.store, user, 'change', 'fin_assets', key, before, {
        ...after,
        reason: v.reason,
        date: v.date,
      });
      return after;
    });
  }
  dispose(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit
      .extend({
        date: dateSchema,
        proceeds: centsSchema.default(0),
        accountId: id.optional(),
        reason: label,
      })
      .parse(raw);
    return financeWrite(this.store, user, 'assets.dispose', { ...v, key }, () => {
      const before = row(this.db, 'fin_assets', key);
      checkVersion(before, v.version);
      if (
        before.status !== 'active' ||
        v.date < String(before.date) ||
        this.ledger.get(user, before.voucher_id).header.status !== 'posted'
      )
        financeError('资产未记账、已处置或日期无效。');
      const depreciation = this.db
        .prepare(
          `SELECT coalesce(sum(d.amount_cents),0) AS amount,
        coalesce(sum(v.status<>'posted' OR v.date>?),0) AS pending FROM fin_depreciation d
        JOIN fin_vouchers v ON v.id=d.voucher_id WHERE asset_id=?`,
        )
        .get(v.date, key);
      if (depreciation?.pending) financeError('请先核对已计提折旧凭证和日期。');
      const acc = Number(depreciation?.amount),
        original = Number(before.original_cents),
        residual = original - acc;
      const mapping = financeTemplate(this.store, 'asset');
      const entries = [
        entry(mapping('asset'), 0, original),
        ...(acc ? [entry(mapping('depreciation'), acc, 0)] : []),
        ...(residual ? [entry(mapping('disposal'), residual, 0)] : []),
      ];
      if (v.proceeds) {
        if (!v.accountId) financeError('出售收款请选资金账户。');
        const cash = row(this.db, 'fin_cash_accounts', v.accountId);
        if (!cash.enabled) financeError('资金账户已停用。');
        entries.push(
          entry(String(cash.account_code), v.proceeds, 0, null, '处置固定资产收到的现金'),
          entry(mapping('disposal'), 0, v.proceeds),
        );
      }
      const gain = v.proceeds - residual;
      if (gain > 0)
        entries.push(entry(mapping('disposal'), gain, 0), entry(mapping('gain'), 0, gain));
      if (gain < 0)
        entries.push(entry(mapping('loss'), -gain, 0), entry(mapping('disposal'), 0, -gain));
      const voucher = this.ledger.createLinked(user, 'asset_disposal', key, {
        date: v.date,
        description: v.reason,
        requestId: v.requestId,
        entries,
      });
      this.db
        .prepare("UPDATE fin_assets SET status='disposed',version=version+1 WHERE id=?")
        .run(key);
      const after = row(this.db, 'fin_assets', key);
      financeAudit(this.store, user, 'dispose', 'fin_assets', key, before, {
        ...after,
        disposalVoucherId: voucher.header.id,
        reason: v.reason,
      });
      return { ...after, disposalVoucherId: voucher.header.id };
    });
  }
}
