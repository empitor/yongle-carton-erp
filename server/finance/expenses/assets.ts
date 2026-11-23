import { z } from 'zod';
import { dateSchema } from '../../../shared/core/index.js';
import { accountCodeSchema, BASIS_POINTS, centsSchema, periodSchema } from '../../../shared/finance/index.js';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { exists, many, one, rows } from '../../core/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from '../base/core.js';
import { FinanceLedger } from '../ledger/ledger.js';
import { entry, id, label, money, pageSql, request, row, edit } from '../base/query.js';
import { entryNet, expectedVoucher, jobVoucherNet, periodJob, periodJobResult, sameNet, withdrawJob } from '../base/jobs.js';
import { financeTemplate } from '../base/template.js';
import { proportion } from '../base/amounts.js';
import { endOfMonth } from '../base/periods.js';
import { latestSourceVoucher, voucherColumns } from '../parties/obligation-sql.js';
import { assetStatuses } from '../base/stored-values.js';
import { MONTHS_PER_YEAR } from '../base/days.js';
import { expectRow } from '../base/finance-rows.js';

/** 折旧最长 1200 个月（一百年） */
const ASSET_MAX_MONTHS = 1200;

/** 资产列表一行：资产加累计折旧，和处置凭证三列（disposal_ 开头） */
const listRow = rows.fin_assets.extend({
  accumulated: z.number(),
  disposal_voucher_id: z.number().nullable(),
  disposal_voucher_status: z.string().nullable(),
  disposal_voucher_state: z.string().nullable(),
});
const asset = rows.fin_assets.shape;
/** 某个月的折旧明细一行：折旧加资产编号、名称、部门 */
const depreciationRow = rows.fin_depreciation.extend({
  number: asset.number,
  name: asset.name,
  department: asset.department,
});
/** 折旧计提（kind='depreciation'）执行记录的明细：合计和每项资产提了多少、记到哪个费用科目 */
const depreciationDetails = z.object({
  total: z.number(),
  lines: z.array(z.object({ id: z.number(), account: z.string(), amount: z.number() })),
});
const disposed = rows.fin_assets.extend({ disposalVoucherId: z.number() });

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
      .object({ status: z.enum(assetStatuses).optional(), department: label.optional() })
      .parse(raw);
    return pageSql(
      this.db,
      {
        schema: listRow,
        // 处置凭证（disposal_ 三列）：已处置的资产在详情里撤回或红冲处置
        sql: `SELECT a.*,coalesce((SELECT sum(d.amount_cents) FROM fin_depreciation d WHERE asset_id=a.id),0) AS accumulated,
        ${voucherColumns(latestSourceVoucher('asset_disposal', 'a.id'), 'disposal_')}
      FROM fin_assets a WHERE (? IS NULL OR status=?) AND (? IS NULL OR department=?)`,
        values: [q.status ?? null, q.status ?? null, q.department ?? null, q.department ?? null],
        order: 'date',
      },
      raw,
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
        months: z.number().int().min(1).max(ASSET_MAX_MONTHS),
        residualBp: z.number().int().min(0).max(BASIS_POINTS),
        department: label,
        expenseAccount: accountCodeSchema,
        counterAccount: accountCodeSchema,
        cashFlow: label.optional(),
      })
      .parse(raw);
    return financeWrite(this.store, user, { action: 'assets.add', input: v, result: rows.fin_assets }, () => {
      if (exists(this.db, 'SELECT 1 FROM fin_assets WHERE number=?', v.number)) financeError('资产编号已存在。', 409);
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
      financeAudit(this.store, user, { action: 'create', entity: 'fin_assets', id: key, before: null, after });
      return after;
    });
  }
  /**
   * 按现在的资产算某个月的折旧，只读不写；以前月份已提的扣掉，这个月自己已提的不算。
   * 这个月提过折旧以后才处置的资产照样算这个月的（处置时已经按含这个月的累计折旧转出了）。
   */
  private depreciationPlan(period: string) {
    const items = many(
      this.db,
      rows.fin_assets.extend({ prior: z.number() }),
      `SELECT a.*,coalesce((SELECT sum(d.amount_cents) FROM fin_depreciation d
      WHERE asset_id=a.id AND d.period<?),0) AS prior FROM fin_assets a JOIN fin_vouchers v ON v.id=a.voucher_id
      WHERE (a.status='active' OR EXISTS(SELECT 1 FROM fin_depreciation x WHERE x.asset_id=a.id AND x.period=?))
      AND substr(a.date,1,7)<? AND v.status='posted' ORDER BY a.id`,
      period,
      period,
      period,
    );
    const [year, month] = period.split('-').map(Number);
    const lines = items.flatMap((a) => {
      const [y, m] = a.date.split('-').map(Number),
        months = a.months;
      const cost = a.original_cents,
        basis = cost - proportion(cost, a.residual_bp, BASIS_POINTS);
      const age = (year - y) * MONTHS_PER_YEAR + month - m;
      const amount = proportion(basis, Math.min(age, months), months) - a.prior;
      return amount > 0 ? [{ id: a.id, account: a.expense_account, amount }] : [];
    });
    const grouped = new Map<string, number>();
    for (const item of lines) grouped.set(item.account, (grouped.get(item.account) ?? 0) + item.amount);
    const total = lines.reduce((n, l) => n + l.amount, 0);
    const entries = total
      ? [
          ...Array.from(grouped, ([code, amount]) => entry(code, amount, 0)),
          entry(financeTemplate(this.store, 'asset')('depreciation'), 0, total),
        ]
      : [];
    return { lines, total, entries };
  }

  /** 结账检查：折旧计提以后资产变了（新入账、处置、记账），按现在的数重算和那次不一样，要重做。 */
  depreciationStale(period: string) {
    const job = one(
      this.db,
      rows.fin_period_jobs.pick({ voucher_id: true }),
      "SELECT voucher_id FROM fin_period_jobs WHERE period=? AND kind='depreciation'",
      period,
    );
    if (!job) return null;
    const plan = this.depreciationPlan(period);
    return sameNet(entryNet(plan.entries), jobVoucherNet(this.store, job.voucher_id))
      ? null
      : '折旧计提以后，固定资产有变动。';
  }

  depreciate(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = request
      .extend({ period: periodSchema, redo: z.boolean().default(false), expectedVoucherId: expectedVoucher })
      .parse(raw);
    const result = periodJobResult(depreciationDetails);
    return financeWrite(this.store, user, { action: 'assets.depreciate', input: v, result }, () => {
      const date = endOfMonth(v.period);
      this.ledger.openPeriod(user, date);
      const { lines, total, entries } = this.depreciationPlan(v.period);
      if (v.redo) {
        // 重做：原凭证红冲（没记账的作废），这个月的折旧明细按新数重写，原来的留在撤回的执行记录里
        withdrawJob(this.store, user, this.ledger, {
          period: v.period,
          kind: 'depreciation',
          reason: '重做折旧计提',
          expectedVoucherId: v.expectedVoucherId,
        });
        const before = many(this.db, rows.fin_depreciation, 'SELECT * FROM fin_depreciation WHERE period=?', v.period);
        this.db.prepare('DELETE FROM fin_depreciation WHERE period=?').run(v.period);
        financeAudit(this.store, user, {
          action: 'withdraw',
          entity: 'fin_depreciation',
          id: null,
          before: { period: v.period, rows: before },
          after: null,
        });
      }
      if (exists(this.db, "SELECT 1 FROM fin_period_jobs WHERE period=? AND kind='depreciation'", v.period))
        financeError('本月折旧已计提；资产有变动要按现在的数重算，用“重做折旧”。', 409);
      const voucher = total
        ? Number(
            this.ledger.createLinked(
              user,
              'depreciation',
              Number(v.period.replace('-', '')),
              { date, description: '月度折旧', requestId: v.requestId, entries },
              'finance:close',
            ).header.id,
          )
        : null;
      if (voucher)
        for (const item of lines)
          this.db
            .prepare('INSERT INTO fin_depreciation(asset_id,period,amount_cents,voucher_id) VALUES(?,?,?,?)')
            .run(item.id, v.period, item.amount, voucher);
      return periodJob(this.store, user, {
        period: v.period,
        kind: 'depreciation',
        voucher,
        schema: depreciationDetails,
        details: { total, lines },
      });
    });
  }
  depreciation(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z.object({ period: periodSchema }).parse(raw);
    return pageSql(
      this.db,
      {
        schema: depreciationRow,
        sql: `SELECT d.*,a.number,a.name,a.department FROM fin_depreciation d
      JOIN fin_assets a ON a.id=d.asset_id WHERE d.period=?`,
        values: [q.period],
        order: 'asset_id',
      },
      raw,
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
    const input = { ...v, key };
    return financeWrite(this.store, user, { action: 'assets.change', input, result: rows.fin_assets }, () => {
      const before = row(this.db, 'fin_assets', key);
      checkVersion(before, v.version);
      this.ledger.openPeriod(user, v.date);
      if (before.status !== 'active') financeError('已处置资产不能变动。');
      this.db
        .prepare('UPDATE fin_assets SET department=?,expense_account=?,version=version+1 WHERE id=?')
        .run(v.department, v.expenseAccount, key);
      const after = row(this.db, 'fin_assets', key);
      financeAudit(this.store, user, {
        action: 'change',
        entity: 'fin_assets',
        id: key,
        before,
        after: { ...after, reason: v.reason, date: v.date },
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
    const input = { ...v, key };
    return financeWrite(this.store, user, { action: 'assets.dispose', input, result: disposed }, () => {
      const before = row(this.db, 'fin_assets', key);
      checkVersion(before, v.version);
      if (
        before.status !== 'active' ||
        v.date < before.date ||
        this.ledger.get(user, before.voucher_id).header.status !== 'posted'
      )
        financeError('资产未记账、已处置或日期无效。');
      const depreciation = expectRow(
        one(
          this.db,
          z.object({ amount: z.number(), pending: z.number() }),
          `SELECT coalesce(sum(d.amount_cents),0) AS amount,
        coalesce(sum(v.status<>'posted' OR v.date>?),0) AS pending FROM fin_depreciation d
        JOIN fin_vouchers v ON v.id=d.voucher_id WHERE asset_id=?`,
          v.date,
          key,
        ),
        '累计折旧',
      );
      if (depreciation.pending) financeError('请先核对已计提折旧凭证和日期。');
      const voucherId = this.disposeVoucher(user, { before, accumulated: depreciation.amount, ...v });
      this.db.prepare("UPDATE fin_assets SET status='disposed',version=version+1 WHERE id=?").run(key);
      const after = row(this.db, 'fin_assets', key);
      financeAudit(this.store, user, {
        action: 'dispose',
        entity: 'fin_assets',
        id: key,
        before,
        after: { ...after, disposalVoucherId: voucherId, reason: v.reason },
      });
      return { ...after, disposalVoucherId: voucherId };
    });
  }
  /** 处置凭证：转出原值、累计折旧，残值进清理；出售收款进资金账户，清理的差额记收益或损失 */
  private disposeVoucher(
    user: Actor,
    d: {
      before: z.output<typeof rows.fin_assets>;
      accumulated: number;
      date: string;
      proceeds: number;
      accountId?: number;
      reason: string;
      requestId: string;
    },
  ) {
    const original = d.before.original_cents,
      acc = d.accumulated,
      residual = original - acc;
    const mapping = financeTemplate(this.store, 'asset');
    const entries = [
      entry(mapping('asset'), 0, original),
      ...(acc ? [entry(mapping('depreciation'), acc, 0)] : []),
      ...(residual ? [entry(mapping('disposal'), residual, 0)] : []),
    ];
    if (d.proceeds) {
      if (!d.accountId) financeError('出售收款请选资金账户。');
      const cash = row(this.db, 'fin_cash_accounts', d.accountId);
      if (!cash.enabled) financeError('资金账户已停用。');
      entries.push(
        entry(cash.account_code, d.proceeds, 0, null, '处置固定资产收到的现金'),
        entry(mapping('disposal'), 0, d.proceeds),
      );
    }
    const gain = d.proceeds - residual;
    if (gain > 0) entries.push(entry(mapping('disposal'), gain, 0), entry(mapping('gain'), 0, gain));
    if (gain < 0) entries.push(entry(mapping('loss'), -gain, 0), entry(mapping('disposal'), 0, -gain));
    const voucher = this.ledger.createLinked(user, 'asset_disposal', d.before.id, {
      date: d.date,
      description: d.reason,
      requestId: d.requestId,
      entries,
    });
    return voucher.header.id;
  }
}
