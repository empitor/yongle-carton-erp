import { createHash } from 'node:crypto';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { requireLocalAdministrator } from '../developer-capability.js';
import { ImportError } from '../import/errors.js';
import { audit, rememberDeletedRecord } from './management.js';

export const developmentResetScope = ['business', 'ai-imports', 'all'] as const;
export type DevelopmentResetScope = (typeof developmentResetScope)[number];

/**
 * 开发阶段的一键初始化：只清空真实业务数据与/或AI识别工作区。
 * 业务清理保留账号、审计、AI配置和提示词；清理AI工作区会同时删除其原件。
 * 该操作不可撤销，因此仅限本机最高管理员。
 */
const businessTables = [
  'flow_file_uses',
  'flow_receipt_keys',
  'flow_previews',
  'flow_refs',
  'flow_sources',
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

export class DevelopmentResetService {
  constructor(readonly store: Store) {}

  private tables(): string[] {
    const existing = new Set(
      this.store.db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r: any) => String(r.name)),
    );
    return businessTables.filter((name) => existing.has(name));
  }

  private counts(): Record<string, number> {
    return Object.fromEntries(
      this.tables().map((name) => [
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

  preview(scope: DevelopmentResetScope, who: Actor) {
    requireLocalAdministrator(who);
    return {
      scope,
      tables: scope === 'ai-imports' ? [] : this.counts(),
    };
  }

  execute(
    scope: DevelopmentResetScope,
    who: Actor,
    clearImports?: () => { count: number; ids: string[] },
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
    const tables = this.tables(),
      before = this.counts(),
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
      // 审计、正式归档与持久任务仍保留旧记录身份，清空业务不能让新记录复用旧ID。
      if (db.prepare('PRAGMA foreign_key_check').all().length)
        throw new ImportError('初始化后的业务关联检查未通过，已回滚。', 409);
      db.exec('RELEASE development_reset');
    } catch (e) {
      db.exec('ROLLBACK TO development_reset');
      db.exec('RELEASE development_reset');
      throw e;
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
      digest,
    });
    return { scope, count: total, aiImports };
  }
}
