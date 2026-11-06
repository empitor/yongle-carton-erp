import { z } from 'zod';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { snapshotBeforeDestructive } from '../backup.js';
import {
  accountCodeSchema,
  accountSchema,
  openingSchema,
  requestIdSchema,
  settingsPatchSchema,
  versionSchema,
} from '../../shared/finance.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';

const accountChange = z.strictObject({
  account: accountSchema,
  version: versionSchema.optional(),
  requestId: requestIdSchema,
});
const accountDelete = z.strictObject({
  code: accountCodeSchema,
  version: versionSchema,
  requestId: requestIdSchema,
});

export class FinanceSettings {
  constructor(private store: Store) {}

  get(actor: Actor | null) {
    financeActor(actor);
    const row = this.store.db.prepare('SELECT * FROM fin_settings WHERE id=1').get()!;
    return {
      version: Number(row.version),
      startPeriod: row.start_period as string | null,
      taxpayer: row.taxpayer as string | null,
      requireSeparateApprover: row.require_separate_approver === 1,
      revenueRecognition: String(row.revenue_recognition),
      costAllocation: String(row.cost_allocation),
      agingDays: JSON.parse(String(row.aging_days)) as number[],
      archiveRetention: {
        voucherYears: 30,
        ledgerYears: 30,
        bankYears: 10,
        taxWorkpaperYears: 10,
        starts: '会计年度结束后第一天起算',
      },
      taxRates: JSON.parse(String(row.tax_rates)) as z.infer<
        typeof settingsPatchSchema
      >['taxRates'],
    };
  }

  update(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const input = settingsPatchSchema.parse(raw);
    if (input.requireSeparateApprover !== undefined && user.role !== 'super_admin')
      financeError('仅管理员可修改制单与审核分离设置。', 403);
    return financeWrite(this.store, user, 'settings.update', input, () => {
      const before = this.get(user);
      checkVersion(before, input.version);
      const db = this.store.db;
      db.prepare(
        `UPDATE fin_settings SET version=version+1, taxpayer=?, require_separate_approver=?,
        revenue_recognition=?, cost_allocation=?, aging_days=?, tax_rates=? WHERE id=1`,
      ).run(
        input.taxpayer ?? before.taxpayer,
        Number(input.requireSeparateApprover ?? before.requireSeparateApprover),
        input.revenueRecognition ?? before.revenueRecognition,
        input.costAllocation ?? before.costAllocation,
        JSON.stringify(input.agingDays ?? before.agingDays),
        JSON.stringify(input.taxRates ?? before.taxRates),
      );
      const after = this.get(user);
      financeAudit(this.store, user, 'update', 'fin_settings', 1, before, after);
      return { ...after };
    });
  }

  accounts(actor: Actor | null) {
    financeActor(actor);
    return this.store.db
      .prepare(
        `SELECT a.*, NOT EXISTS(
      SELECT 1 FROM fin_accounts WHERE parent_code=a.code) AS leaf
      FROM fin_accounts a ORDER BY code`,
      )
      .all();
  }

  saveAccount(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const input = accountChange.parse(raw);
    return financeWrite(this.store, user, 'accounts.save', input, () => {
      const db = this.store.db,
        a = input.account;
      const find = db.prepare('SELECT * FROM fin_accounts WHERE code=?');
      const before = find.get(a.code);
      const parentCode = a.code.length > 4 ? a.code.slice(0, -2) : null;
      if (parentCode) {
        const parent = find.get(parentCode);
        if (!parent || parent.category !== a.category)
          financeError('上级科目必须存在，且类别应一致。');
        if (a.enabled && !parent.enabled) financeError('请先启用上级科目。');
        if (!before && parent.used) financeError('已使用的科目不能增加下级。', 409);
      }
      const hasChild = db
        .prepare('SELECT 1 FROM fin_accounts WHERE parent_code=? LIMIT 1')
        .get(a.code);
      if (before) {
        if (input.version === undefined) financeError('科目已存在。', 409);
        checkVersion(before, input.version);
        if (hasChild && before.category !== a.category) financeError('请先处理下级科目。', 409);
        if (
          !a.enabled &&
          db.prepare('SELECT 1 FROM fin_accounts WHERE parent_code=? AND enabled=1').get(a.code)
        )
          financeError('请先停用下级科目。', 409);
        if (
          before.used &&
          (a.category !== before.category ||
            a.name !== before.name ||
            a.direction !== before.direction ||
            a.cashKind !== before.cash_kind ||
            a.auxiliary !== before.auxiliary)
        )
          financeError('已使用的科目仅可修改启用状态。', 409);
        db.prepare(
          `UPDATE fin_accounts SET name=?,category=?,direction=?,cash_kind=?,auxiliary=?,
          enabled=?,version=version+1 WHERE code=?`,
        ).run(a.name, a.category, a.direction, a.cashKind, a.auxiliary, Number(a.enabled), a.code);
      } else {
        if (input.version !== undefined) financeError('科目不存在。', 404);
        db.prepare(
          `INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled)
          VALUES(?,?,?,?,?,?,?,?)`,
        ).run(
          a.code,
          parentCode,
          a.name,
          a.category,
          a.direction,
          a.cashKind,
          a.auxiliary,
          Number(a.enabled),
        );
      }
      const after = find.get(a.code)!;
      financeAudit(this.store, user, 'save', 'fin_accounts', null, before ?? null, after);
      return { ...after };
    });
  }

  deleteAccount(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const input = accountDelete.parse(raw);
    snapshotBeforeDestructive(this.store, 'finance-account');
    return financeWrite(this.store, user, 'accounts.delete', input, () => {
      const db = this.store.db;
      const before = db.prepare('SELECT * FROM fin_accounts WHERE code=?').get(input.code);
      if (!before) financeError('科目不存在。', 404);
      checkVersion(before, input.version);
      if (
        before.used ||
        db.prepare('SELECT 1 FROM fin_accounts WHERE parent_code=? LIMIT 1').get(input.code)
      )
        financeError('已使用的科目及有下级的科目不能删除。', 409);
      db.prepare('DELETE FROM fin_accounts WHERE code=?').run(input.code);
      financeAudit(this.store, user, 'delete', 'fin_accounts', null, before, null);
      return { code: input.code };
    });
  }

  opening(actor: Actor | null) {
    const user = financeActor(actor, 'finance:close');
    return {
      period: this.get(user).startPeriod,
      rows: this.store.db
        .prepare('SELECT * FROM fin_opening ORDER BY account_code, auxiliary_id')
        .all(),
    };
  }

  enable(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const input = openingSchema.parse(raw);
    return financeWrite(this.store, user, 'opening.enable', input, () => {
      const db = this.store.db;
      const before = this.get(user);
      checkVersion(before, input.version);
      if (before.startPeriod) financeError('期初已启用并锁定。', 409);
      const accounts = new Map(this.accounts(user).map((row) => [row.code, row]));
      const balances = new Map<string, { control?: bigint[]; detail: bigint[] }>();
      const unique = new Set<string>();
      const insert = db.prepare(`INSERT INTO fin_opening
        (account_code,auxiliary_kind,auxiliary_id,auxiliary_name,debit,credit,year_debit,year_credit)
        VALUES(?,?,?,?,?,?,?,?)`);
      let net = 0n,
        yearNet = 0n;
      for (const row of input.rows) {
        const account = accounts.get(row.accountCode),
          auxiliary = row.auxiliary;
        if (!account?.enabled || !account.leaf) financeError('期初科目必须启用且为末级。');
        if (row.debit > 0 && row.credit > 0) financeError('期初余额只可填一方。');
        if (auxiliary && account.auxiliary !== auxiliary.kind)
          financeError('期初辅助项与科目不一致。');
        const key = JSON.stringify([row.accountCode, auxiliary?.id]);
        if (unique.has(key)) financeError('期初科目或辅助明细重复。');
        unique.add(key);
        const amounts = [row.debit, row.credit, row.yearDebit, row.yearCredit].map(BigInt);
        if (account.auxiliary) {
          const group = balances.get(row.accountCode) ?? { detail: [0n, 0n, 0n, 0n] };
          if (auxiliary)
            group.detail = group.detail.map((amount, index) => amount + amounts[index]);
          else group.control = amounts;
          balances.set(row.accountCode, group);
        }
        if (!auxiliary) {
          net += amounts[0] - amounts[1];
          yearNet += amounts[2] - amounts[3];
        }
        insert.run(
          row.accountCode,
          auxiliary?.kind ?? null,
          auxiliary?.id ?? null,
          auxiliary?.name ?? null,
          row.debit,
          row.credit,
          row.yearDebit,
          row.yearCredit,
        );
        db.prepare('UPDATE fin_accounts SET used=1 WHERE code=?').run(row.accountCode);
      }
      for (const [code, group] of balances) {
        const { control, detail } = group;
        if (
          !control ||
          control[0] - control[1] !== detail[0] - detail[1] ||
          control[2] !== detail[2] ||
          control[3] !== detail[3]
        )
          financeError(`科目 ${code} 的期初及本年累计与辅助明细不一致。`);
      }
      if (net !== 0n || yearNet !== 0n) financeError('期初余额和本年累计必须分别借贷平衡。');
      db.prepare("INSERT INTO fin_periods(period,status) VALUES(?,'open')").run(input.period);
      db.prepare(
        'UPDATE fin_settings SET start_period=?,taxpayer=?,version=version+1 WHERE id=1',
      ).run(input.period, input.taxpayer);
      db.prepare(
        `INSERT INTO fin_obligations(kind,party_id,party_name,date,amount_cents,description,opening_id)
        SELECT CASE WHEN account_code LIKE '1122%' THEN 'receivable' ELSE 'payable' END,
          auxiliary_id,auxiliary_name,?,CASE WHEN account_code LIKE '1122%' THEN debit-credit ELSE credit-debit END,'期初往来',id
        FROM fin_opening WHERE auxiliary_id IS NOT NULL AND debit<>credit AND
          (account_code LIKE '1122%' OR account_code LIKE '2202%')`,
      ).run(input.period + '-01');
      const after = this.get(user);
      financeAudit(
        this.store,
        user,
        'enable',
        'fin_opening',
        null,
        { settings: before, rows: [] },
        { settings: after, rows: input.rows },
      );
      return after;
    });
  }

  periods(actor: Actor | null) {
    financeActor(actor);
    return this.store.db.prepare('SELECT * FROM fin_periods ORDER BY period').all();
  }
}
