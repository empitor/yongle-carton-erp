import { createHash } from 'node:crypto';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { requireLocalAdministrator } from '../developer-capability.js';
import { ImportError } from '../import/errors.js';
import { audit, rememberDeletedRecord } from './management.js';
import { snapshotBeforeDestructive } from '../backup.js';

export const developmentResetScope = ['business', 'ai-imports', 'all'] as const;
export type DevelopmentResetScope = (typeof developmentResetScope)[number];

/**
 * 开发阶段的一键初始化：只清空真实业务数据与/或AI识别工作区。
 * 业务清理保留账号、审计、AI配置和提示词，导入台账清空后原件归档一并删除；清理AI工作区会同时删除其原件。
 * 该操作不可撤销，因此仅限本机最高管理员。
 */
const businessTables = [
  'product_marks',
  'mark_files',
  'inbox_items',
  'inbox_files',
  'flow_file_uses',
  'flow_receipt_keys',
  'flow_previews',
  'flow_refs',
  'flow_sources',
  'stock_movement_revisions',
  'stock_movements',
  'purchase_receipts',
  'purchase_lines',
  'stock_items',
  'purchases',
  'suppliers',
  'import_previews',
  'import_executions',
  'permanent_delete_previews',
  'record_lifecycle',
  'product_extensions',
  'order_extensions',
  'order_line_extensions',
  'order_lines',
  'orders',
  'products',
  'customers',
  'flow_documents',
  'operation_requests',
] as const;

export const financeResetTables = [
  'fin_report_snapshots','fin_budgets','fin_period_jobs','fin_cost_sales','fin_inventory_costs',
  'fin_payroll','fin_depreciation','fin_assets','fin_expenses','fin_invoice_links','fin_invoices',
  'fin_attachments','fin_notes','fin_bank_matches','fin_bank_rows','fin_mapping_profiles','fin_statements','fin_interest','fin_deposit_actions',
  'fin_deposits','fin_installments','fin_allocations','fin_bad_debts','fin_cash_documents','fin_cash_accounts','fin_obligations',
  'fin_source_observations','fin_entries','fin_vouchers','fin_events','fin_opening','fin_periods','fin_requests',
  // 账期和税率按往来单位 ID 记。业务清空后新客户可能复用旧 ID，不清就会串到别人头上。
  'fin_party_terms',
] as const;

export class DevelopmentResetService {
  constructor(readonly store: Store) {}

  private tables(includeFinance: boolean): string[] {
    const existing = new Set(
      this.store.db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r: any) => String(r.name)),
    );
    return [...businessTables,...(includeFinance?financeResetTables:[])].filter((name) => existing.has(name));
  }

  private counts(includeFinance: boolean): Record<string, number> {
    return Object.fromEntries(
      this.tables(includeFinance).map((name) => [
        name,
        Number(
          this.store.db
            .prepare(
              'SELECT COUNT(*) AS n FROM "' +
                name +
                '"' +
                (name === 'operation_requests'
                  ? " WHERE kind <> 'document-template-settings'"
                  : ''),
            )
            .get()!.n,
        ),
      ]),
    );
  }

  /** 财务里还有多少条记录。助手不做财务写入，有记录就不能替用户清空业务。 */
  financeRows() {
    return financeResetTables.reduce(
      (n, name) =>
        n + Number(this.store.db.prepare('SELECT count(*) AS n FROM "' + name + '"').get()!.n),
      0,
    );
  }
  preview(scope: DevelopmentResetScope, who: Actor, clearClosedFinance = false, includeFinance = true) {
    requireLocalAdministrator(who);
    const tables=scope==='ai-imports'?[]:this.counts(includeFinance);
    const closed=scope==='ai-imports'||!includeFinance?[]:this.store.db.prepare(
      "SELECT period,version FROM fin_periods WHERE status='closed' ORDER BY period").all();
    const finance=includeFinance && scope!=='ai-imports'?{
      closed,allowed:!closed.length||clearClosedFinance,clearClosedFinance,
      digest:createHash('sha256').update(JSON.stringify({scope,actor:who.id,tables,closed,clearClosedFinance})).digest('hex'),
    }:null;
    return {scope,tables,...(finance?{finance}:{})};
  }

  execute(
    scope: DevelopmentResetScope,
    who: Actor,
    clearImports?: () => { count: number; ids: string[] },
    options: {
      includeFinance?: boolean;
      clearClosedFinance?: boolean;
      financeDigest?: string;
      /** 清空导入台账后一并删掉原件归档，返回删掉的份数。 */
      clearArchive?: () => number;
    } = {},
  ) {
    const actor = requireLocalAdministrator(who);
    if (scope === 'ai-imports') {
      if (!clearImports) throw new ImportError('AI导入存储尚未配置，未清理。', 503);
      const removed = clearImports();
      audit(this.store, actor, 'assistant', 'development-reset', 'ai-imports', null, {
        scope,
        count: removed.count,
      });
      return { scope, count: removed.count };
    }
    const includeFinance=options.includeFinance!==false;
    const preview=this.preview(scope,actor,options.clearClosedFinance,includeFinance);
    if (preview.finance?.closed.length && (!preview.finance.allowed||preview.finance.digest!==options.financeDigest))
      throw new ImportError('存在已结账财务数据，请在初始化预览中明确勾选并提交对应范围。',409,'finance-reset-preview');
    snapshotBeforeDestructive(this.store, 'reset');
    const tables = this.tables(includeFinance),
      before = this.counts(includeFinance),
      digest = createHash('sha256').update(JSON.stringify({ scope, tables })).digest('hex');
    const db = this.store.db;
    db.exec('PRAGMA defer_foreign_keys=ON');
    db.exec('SAVEPOINT development_reset');
    try {
      for (const entity of [
        'customers',
        'products',
        'orders',
        'suppliers',
        'purchases',
        'stock_items',
      ])
        for (const row of db.prepare('SELECT * FROM "' + entity + '"').all())
          rememberDeletedRecord(this.store, actor, entity, row as { id: number });
      for (const name of tables)
        db.exec(
          'DELETE FROM "' +
            name +
            '"' +
            (name === 'operation_requests' ? " WHERE kind <> 'document-template-settings'" : ''),
        );
      if (includeFinance) {
        db.exec('UPDATE fin_settings SET start_period=NULL,version=version+1 WHERE start_period IS NOT NULL');
        db.exec('UPDATE fin_accounts SET used=0 WHERE used=1');
      }
      // 审计与持久任务仍保留旧记录身份，清空业务不能让新记录复用旧ID。
      if (db.prepare('PRAGMA foreign_key_check').all().length)
        throw new ImportError('初始化后的业务关联检查未通过，已回滚。', 409);
      db.exec('RELEASE development_reset');
    } catch (e) {
      db.exec('ROLLBACK TO development_reset');
      db.exec('RELEASE development_reset');
      throw e;
    }
    // 导入台账（import_executions）已清空，原件归档再无引用，留着只会把客户文件留在服务器上。
    let archives = 0;
    if (options.clearArchive) {
      try {
        archives = options.clearArchive();
      } catch (error) {
        throw new ImportError(
          '业务数据已清空，但原件归档没有清理干净：' + (error as Error).message + '。请检查目录权限后重新初始化。',
          500,
        );
      }
    }
    let aiImports = 0;
    if (scope === 'all') {
      if (!clearImports)
        throw new ImportError('AI导入存储尚未配置，业务数据已清空但未清理AI导入。', 503);
      aiImports = clearImports().count;
    }
    const total = Object.values(before).reduce((sum, n) => sum + n, 0);
    audit(this.store, actor, 'assistant', 'development-reset', scope, null, {
      scope,
      businessCount: total,
      aiImports,
      archives,
      digest,
    });
    return { scope, count: total, aiImports, archives };
  }
}
