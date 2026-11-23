import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { exists, many, one, parseStoredJson, rows } from '../../core/index.js';
import { accountChangeSchema, openingSchema, settingsPatchSchema, type accountSchema } from '../../../shared/finance/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { expectRow } from './finance-rows.js';
import { enableOpening } from './opening.js';

type AccountInput = z.output<typeof accountSchema>;

/** 科目代码：一级 4 位，往下每级多 2 位 */
const TOP_LEVEL_DIGITS = 4;
const LEVEL_DIGITS = 2;

const patch = settingsPatchSchema.shape;
/** fin_settings 一行：几个枚举列按取值收窄；账龄分段（aging_days）、小税种税率（tax_rates）存的是改设置时校验过的样子 */
const settingsRow = rows.fin_settings.extend({
  taxpayer: patch.taxpayer.unwrap().nullable(),
  revenue_recognition: patch.revenueRecognition.unwrap(),
  cost_allocation: patch.costAllocation.unwrap(),
});
const agingDays = patch.agingDays.unwrap();
const taxRates = patch.taxRates.unwrap();
/** 页面看到的财务设置（get 返回、改设置和启用的结果） */
const settingsView = z.object({
  version: z.number(),
  startPeriod: z.string().nullable(),
  taxpayer: settingsRow.shape.taxpayer,
  requireSeparateApprover: z.boolean(),
  revenueRecognition: settingsRow.shape.revenue_recognition,
  costAllocation: settingsRow.shape.cost_allocation,
  agingDays,
  archiveRetention: z.object({
    voucherYears: z.number(),
    ledgerYears: z.number(),
    bankYears: z.number(),
    taxWorkpaperYears: z.number(),
    starts: z.string(),
  }),
  taxRates,
});
type SettingsView = z.output<typeof settingsView>;

/** 财务设置那一行（建库时预置，只有一行），两列 JSON 解析好 */
export function readFinanceSettings(db: DatabaseSync) {
  const row = expectRow(one(db, settingsRow, 'SELECT * FROM fin_settings WHERE id=1'), '财务设置');
  return {
    ...row,
    agingDays: parseStoredJson(agingDays, row.aging_days, 'fin_settings.aging_days'),
    taxRates: parseStoredJson(taxRates, row.tax_rates, 'fin_settings.tax_rates'),
  };
}

/** 科目一行，leaf 是不是末级（没有下级科目为 1） */
const accountRow = rows.fin_accounts.extend({ leaf: z.number() });
const accountByCode = (db: DatabaseSync, code: string) =>
  one(db, rows.fin_accounts, 'SELECT * FROM fin_accounts WHERE code=?', code);
type StoredAccount = z.output<typeof rows.fin_accounts>;

/** 新增下级科目：上级要在、类别一致、启用；已用过的科目不能再加下级 */
function checkParent(db: DatabaseSync, a: AccountInput, parentCode: string, isNew: boolean) {
  const parent = accountByCode(db, parentCode);
  if (!parent || parent.category !== a.category) financeError('上级科目必须存在，且类别应一致。');
  if (a.enabled && !parent.enabled) financeError('请先启用上级科目。');
  if (isNew && parent.used) financeError('已使用的科目不能增加下级。', 409);
}

/** 改已有科目：有下级的不能改类别、不能在下级还启用时停用，已用过的只能改启用状态 */
function checkAccountChange(db: DatabaseSync, a: AccountInput, before: StoredAccount) {
  if (before.category !== a.category && exists(db, 'SELECT 1 FROM fin_accounts WHERE parent_code=? LIMIT 1', a.code))
    financeError('请先处理下级科目。', 409);
  if (!a.enabled && exists(db, 'SELECT 1 FROM fin_accounts WHERE parent_code=? AND enabled=1', a.code))
    financeError('请先停用下级科目。', 409);
  const changed =
    a.category !== before.category ||
    a.name !== before.name ||
    a.direction !== before.direction ||
    a.cashKind !== before.cash_kind ||
    a.auxiliary !== before.auxiliary;
  if (before.used && changed) financeError('已使用的科目仅可修改启用状态。', 409);
}

export class FinanceSettings {
  constructor(private store: Store) {}

  get(actor: Actor | null): SettingsView {
    financeActor(actor);
    const row = readFinanceSettings(this.store.db);
    return {
      version: row.version,
      startPeriod: row.start_period,
      taxpayer: row.taxpayer,
      requireSeparateApprover: row.require_separate_approver === 1,
      revenueRecognition: row.revenue_recognition,
      costAllocation: row.cost_allocation,
      agingDays: row.agingDays,
      archiveRetention: {
        voucherYears: 30,
        ledgerYears: 30,
        bankYears: 10,
        taxWorkpaperYears: 10,
        starts: '会计年度结束后第一天起算',
      },
      taxRates: row.taxRates,
    };
  }

  update(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const input = settingsPatchSchema.parse(raw);
    if (input.requireSeparateApprover !== undefined && user.role !== 'super_admin')
      financeError('仅管理员可修改制单与审核分离设置。', 403);
    return financeWrite(this.store, user, { action: 'settings.update', input, result: settingsView }, () => {
      const before = this.get(user);
      checkVersion(before, input.version);
      // 启用时纳税人身份和期初一起锁定：留抵、附加税都按它算，中途改了以前的月份就对不上了。
      if (before.startPeriod && input.taxpayer !== undefined && input.taxpayer !== before.taxpayer)
        financeError('财务启用后纳税人身份已锁定，不能再改。', 409);
      this.store.db
        .prepare(
          `UPDATE fin_settings SET version=version+1, taxpayer=?, require_separate_approver=?,
        revenue_recognition=?, cost_allocation=?, aging_days=?, tax_rates=? WHERE id=1`,
        )
        .run(
          input.taxpayer ?? before.taxpayer,
          Number(input.requireSeparateApprover ?? before.requireSeparateApprover),
          input.revenueRecognition ?? before.revenueRecognition,
          input.costAllocation ?? before.costAllocation,
          JSON.stringify(agingDays.parse(input.agingDays ?? before.agingDays)),
          JSON.stringify(taxRates.parse(input.taxRates ?? before.taxRates)),
        );
      const after = this.get(user);
      this.recordHistory(user, after);
      financeAudit(this.store, user, { action: 'update', entity: 'fin_settings', id: 1, before, after });
      return { ...after };
    });
  }

  /**
   * 财务设置每改一次，把改完以后的样子记进 fin_settings_history。
   * “某个时间点按什么口径”（现在是收入确认方式）查这张表，不查审计；审计照常另写。
   */
  private recordHistory(user: Actor, after: SettingsView) {
    this.store.db
      .prepare(
        `INSERT INTO fin_settings_history(changed_at,settings_version,taxpayer,require_separate_approver,
        revenue_recognition,cost_allocation,aging_days,tax_rates,actor_id,actor_name) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        new Date().toISOString(),
        after.version,
        after.taxpayer,
        Number(after.requireSeparateApprover),
        after.revenueRecognition,
        after.costAllocation,
        JSON.stringify(agingDays.parse(after.agingDays)),
        JSON.stringify(taxRates.parse(after.taxRates)),
        user.id,
        user.name,
      );
  }

  accounts(actor: Actor | null) {
    financeActor(actor);
    return many(
      this.store.db,
      accountRow,
      `SELECT a.*, NOT EXISTS(SELECT 1 FROM fin_accounts WHERE parent_code=a.code) AS leaf
      FROM fin_accounts a ORDER BY code`,
    );
  }

  saveAccount(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const input = accountChangeSchema.parse(raw);
    return financeWrite(this.store, user, { action: 'accounts.save', input, result: rows.fin_accounts }, () => {
      const db = this.store.db,
        a = input.account;
      const before = accountByCode(db, a.code);
      const parentCode = a.code.length > TOP_LEVEL_DIGITS ? a.code.slice(0, -LEVEL_DIGITS) : null;
      if (parentCode) checkParent(db, a, parentCode, !before);
      if (before) {
        if (input.version === undefined) financeError('科目已存在。', 409);
        checkVersion(before, input.version);
        checkAccountChange(db, a, before);
        db.prepare(
          `UPDATE fin_accounts SET name=?,category=?,direction=?,cash_kind=?,auxiliary=?,
          enabled=?,version=version+1 WHERE code=?`,
        ).run(a.name, a.category, a.direction, a.cashKind, a.auxiliary, Number(a.enabled), a.code);
      } else {
        if (input.version !== undefined) financeError('科目不存在。', 404);
        db.prepare(
          `INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled)
          VALUES(?,?,?,?,?,?,?,?)`,
        ).run(a.code, parentCode, a.name, a.category, a.direction, a.cashKind, a.auxiliary, Number(a.enabled));
      }
      const after = expectRow(accountByCode(db, a.code), '科目 ' + a.code);
      financeAudit(this.store, user, { action: 'save', entity: 'fin_accounts', id: null, before: before ?? null, after });
      return { ...after };
    });
  }

  opening(actor: Actor | null) {
    const user = financeActor(actor, 'finance:close');
    return {
      period: this.get(user).startPeriod,
      rows: many(this.store.db, rows.fin_opening, 'SELECT * FROM fin_opening ORDER BY account_code, auxiliary_id'),
    };
  }

  enable(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const input = openingSchema.parse(raw);
    return financeWrite(this.store, user, { action: 'opening.enable', input, result: settingsView }, () => {
      const before = this.get(user);
      checkVersion(before, input.version);
      if (before.startPeriod) financeError('期初已启用并锁定。', 409);
      const accounts = new Map(this.accounts(user).map((row) => [row.code, row]));
      const rows = enableOpening(this.store.db, input, accounts);
      const after = this.get(user);
      // 纳税人身份在启用时定下来，也是一次设置变更
      this.recordHistory(user, after);
      financeAudit(this.store, user, {
        action: 'enable',
        entity: 'fin_opening',
        id: null,
        before: { settings: before, rows: [] },
        after: { settings: after, rows },
      });
      return after;
    });
  }

  periods(actor: Actor | null) {
    financeActor(actor);
    return many(this.store.db, rows.fin_periods, 'SELECT * FROM fin_periods ORDER BY period');
  }
}
