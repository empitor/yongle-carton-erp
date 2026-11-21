import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import type { ImportManager } from '../import/index.js';
import { requireLocalAdministrator } from '../core/index.js';
import { AppError, assertPreviewCurrent, previewDigest } from '../core/index.js';
import { audit, count, exists, inSavepoint } from '../core/index.js';
import { snapshotBeforeDestructive } from '../core/index.js';
import { resetClear, resetCounts, resetParticipants } from '../core/index.js';
import { clearArchiveNow, deferArchiveCleanup } from './reset-archive.js';
import { resetRequestSchema, type BusinessResetScope, type ResetPreview, type ResetResult } from '../../shared/admin/index.js';

/**
 * 谁发起的：页面（本机管理员在数据管理里点的）连财务一起清，已结账的期间要在预览里勾选；
 * 助手不做财务写入，财务里有记录就不替用户清业务，交回给页面。
 */
export type ResetBy = 'page' | 'assistant';
/** 初始化要用识别导入的两件事：清空工作区、删原件归档（装配传进来的 ImportManager） */
type ResetImports = Pick<ImportManager, 'deleteAllWorkspaces' | 'clearArchive'>;
/** 清业务数据必须有这几个模块各自清自己的表（server/core/deletion-rules.ts 的 registerReset；别的模块登记了也一起清），连财务一起清再加财务 */
const businessModules = [
  '业务汇总',
  '识别导入',
  '单据流转',
  '采购库存',
  '单据导出',
  '基础',
] as const;
/** 清空 AI 工作区：清了几份、哪几份 */
type WorkspacesCleared = { count: number; ids: string[] };
/** 真正清空时调用方给的：预览里勾选的结果和摘要，有识别导入时清工作区、删原件归档的办法 */
type ResetOptions = {
  clearClosedFinance?: boolean;
  financeDigest?: string;
  workspaces?: () => WorkspacesCleared;
  /** 清空导入台账后一并删掉原件归档，返回删掉的份数。 */
  archive?: () => number;
};

/**
 * 初始化业务数据（数据管理最下面的“初始化业务数据”和助手的 management.reset）：
 * 清空业务记录与/或 AI 识别工作区。账号、审计、AI 配置、提示词和单据模板保留；
 * 清业务记录时导入台账没了，正式导入留下的原件归档一并删。不可撤销，只限本机最高管理员。
 */
export class BusinessReset {
  constructor(
    readonly store: Store,
    readonly imports?: ResetImports,
  ) {}

  /** 财务里还有多少条记录。助手不做财务写入，有记录就不能替用户清空业务。 */
  financeRows() {
    return resetParticipants(['财务'], true)
      .filter((r) => r.finance)
      .reduce(
        (n, r) => n + Object.values(resetCounts(this.store, r)).reduce((a, b) => a + b, 0),
        0,
      );
  }

  /** 只清业务不清财务会留下指向空单据的财务记录；助手又不能写财务，所以交回给页面。 */
  refuseWithFinanceData() {
    const rows = this.financeRows();
    if (rows)
      throw new AppError(
        '财务里已有 ' +
          rows +
          ' 条记录，只清业务会留下对不上的财务数据。请到“系统维护”页面操作，那里会连财务一起清。',
        409,
      );
  }

  /**
   * 清空范围：各张表现有多少条（给人看）。页面发起的还说已结账的期间（finance.closed），
   * 勾选“连已结账的一起清”（clearClosedFinance）后给出摘要（finance.digest），提交时带回来。
   */
  preview(
    scope: BusinessResetScope,
    who: Actor,
    options: { by?: ResetBy; clearClosedFinance?: boolean } = {},
  ): ResetPreview {
    requireLocalAdministrator(who);
    const includeFinance = (options.by ?? 'page') === 'page',
      clearClosedFinance = !!options.clearClosedFinance;
    // 只清 AI 工作区时不动业务表：没有要数的表
    const tables = scope === 'ai-imports' ? {} : this.counts(includeFinance);
    // 已经结账的期间由财务说（初始化要用户在预览里明确勾选才清）
    const closed =
      scope === 'ai-imports' || !includeFinance
        ? []
        : resetParticipants(['财务'], true).flatMap((r) => r.closedPeriods?.(this.store) || []);
    const finance =
      includeFinance && scope !== 'ai-imports'
        ? {
            closed,
            allowed: !closed.length || clearClosedFinance,
            clearClosedFinance,
            digest: previewDigest({ scope, tables, closed, clearClosedFinance }),
          }
        : null;
    return { scope, tables, ...(finance ? { finance } : {}) };
  }

  /**
   * 执行初始化（页面 POST /api/management/reset、助手执行 management.reset 方案）。
   * 助手发起的财务里有记录就拒绝；清 AI 工作区要有识别导入，没配置在动数据之前就停下。
   */
  execute(raw: unknown, who: Actor, options: { by?: ResetBy } = {}): ResetResult {
    const by = options.by ?? 'page',
      v = resetRequestSchema.parse(raw),
      imports = this.imports;
    if (by === 'assistant' && v.scope !== 'ai-imports') this.refuseWithFinanceData();
    if ((v.scope === 'all' || v.scope === 'ai-imports') && !imports)
      throw new AppError('AI导入服务未配置，未执行清理。', 503);
    return runReset(this.store, v.scope, who, by, {
      clearClosedFinance: v.clearClosedFinance,
      financeDigest: v.financeDigest,
      ...(imports ? { workspaces: () => this.clearWorkspaces(imports, v.scope, who) } : {}),
      // 只清工作区时导入台账还在，原件归档要留着；清业务记录时台账没了，归档跟着清。
      ...(imports && v.scope !== 'ai-imports' ? { archive: () => imports.clearArchive(who) } : {}),
    });
  }

  /** 各张表现有多少条（给人看清空范围）：各模块数自己的表 */
  private counts(includeFinance: boolean): Record<string, number> {
    return countTables(this.store, includeFinance);
  }

  /** 清空全部 AI 识别工作区；有删不掉的记审计并拒绝，说清业务数据清没清、原件归档删没删 */
  private clearWorkspaces(imports: ResetImports, scope: BusinessResetScope, actor: Actor): WorkspacesCleared {
    const r = imports.deleteAllWorkspaces(actor);
    if (r.failed.length) {
      // 还在外层事务里（助手执行方案时）抛错会让外层回滚：业务数据和这条审计都撤回，
      // 已删的工作区文件回不来。直接调用时业务清空已经提交。两种情况提示不同。
      const nested = this.store.db.isTransaction;
      audit(this.store, actor, {
        action: 'business-reset-partial',
        entity: 'ai-imports',
        id: null,
        document: { scope, count: r.count, ids: r.ids, failed: r.failed },
      });
      throw new AppError(
        (scope === 'all' && !nested ? '业务数据已清空；' : '') +
          '已清理' +
          r.count +
          '份AI工作区，另有' +
          r.failed.length +
          '份失败，请核验原回执后处理未完成项。' +
          (scope === 'all'
            ? nested
              ? '本次初始化已撤回，业务数据没有清空，原件归档也没有删。'
              : '原件归档暂未删除，处理完未完成项后再初始化一次即可清掉。'
            : ''),
        409,
      );
    }
    return { count: r.count, ids: r.ids };
  }
}

/** 各张表现在有多少条：各模块按自己的清空语句数（同名的表后数的为准） */
function countTables(store: Store, includeFinance: boolean): Record<string, number> {
  return Object.fromEntries(
    resetParticipants(businessModules, includeFinance).flatMap((r) => Object.entries(resetCounts(store, r))),
  );
}

/** 缺 AI 导入存储时的说法：在动任何数据之前就停下 */
function noWorkspaces(): never {
  throw new AppError('AI导入存储尚未配置，未执行清理。', 503);
}

/** 只清 AI 工作区：导入台账还在，原件归档留着 */
function resetWorkspacesOnly(store: Store, actor: Actor, workspaces: ResetOptions['workspaces']): ResetResult {
  if (!workspaces) throw new AppError('AI导入存储尚未配置，未清理。', 503);
  const removed = workspaces();
  audit(store, actor, {
    action: 'business-reset',
    entity: 'ai-imports',
    id: null,
    document: { scope: 'ai-imports', count: removed.count },
  });
  return { scope: 'ai-imports', count: removed.count };
}

/** 有已结账的期间：要在预览里勾选过；勾选了，预览之后表里的条数、已结账的期间变了就重新预览 */
function assertClosedFinanceChosen(store: Store, scope: BusinessResetScope, actor: Actor, by: ResetBy, options: ResetOptions) {
  const preview = new BusinessReset(store).preview(scope, actor, {
    by,
    clearClosedFinance: options.clearClosedFinance,
  });
  if (!preview.finance?.closed.length) return;
  if (!preview.finance.allowed)
    throw new AppError(
      '存在已结账财务数据，请在初始化预览中明确勾选并提交对应范围。',
      409,
      'finance-reset-preview',
    );
  assertPreviewCurrent(options.financeDigest, preview.finance.digest);
}

/** 各模块清自己的表（财务连带清掉启用月份、科目的“用过”标记）：返回清之前各表的条数和范围摘要 */
function clearTables(store: Store, scope: BusinessResetScope, includeFinance: boolean) {
  const participants = resetParticipants(businessModules, includeFinance),
    before = countTables(store, includeFinance),
    tables = Object.keys(before),
    digest = createHash('sha256').update(JSON.stringify({ scope, tables })).digest('hex');
  const db = store.db;
  db.exec('PRAGMA defer_foreign_keys=ON');
  inSavepoint(db, () => {
    for (const r of participants) resetClear(store, r);
    // 编号不复用由 AUTOINCREMENT 保证：初始化只清表，不动 sqlite_sequence。
    if (exists(db, 'PRAGMA foreign_key_check'))
      throw new AppError('初始化后的业务关联检查未通过，已回滚。', 409);
  });
  return { before, digest };
}

/**
 * 真正清空：各模块清自己的表，再清 AI 工作区、记审计、删原件归档。
 * workspaces、archive 由调用方按有没有识别导入给出。
 */
function runReset(store: Store, scope: BusinessResetScope, who: Actor, by: ResetBy, options: ResetOptions): ResetResult {
  const actor = requireLocalAdministrator(who);
  if (scope === 'ai-imports') return resetWorkspacesOnly(store, actor, options.workspaces);
  assertClosedFinanceChosen(store, scope, actor, by, options);
  // 缺AI导入存储时在动任何数据之前就停下，不留下“业务清了、工作区没清”的半截状态。
  const workspaces = scope === 'all' ? (options.workspaces ?? noWorkspaces()) : undefined;
  snapshotBeforeDestructive(store, 'reset');
  const { before, digest } = clearTables(store, scope, by === 'page');
  // 下面几步改不回去，按“可能失败的先做、删原件归档最后做”排：AI工作区 → 审计 → 原件归档。
  const aiImports = workspaces ? workspaces().count : 0;
  const total = Object.values(before).reduce((sum, n) => sum + n, 0),
    resetId = randomUUID(),
    // 还在外层事务里（例如助手执行方案时的 SAVEPOINT），外层之后仍可能整体回滚。
    deferArchive = !!options.archive && store.db.isTransaction;
  audit(store, actor, {
    action: 'business-reset',
    entity: scope,
    id: null,
    document: {
      scope,
      businessCount: total,
      aiImports,
      digest,
      resetId,
      archiveCleanup: !options.archive ? 'none' : deferArchive ? 'after-commit' : 'now',
    },
  });
  const result: ResetResult = { scope, count: total, aiImports, archives: 0 };
  if (!options.archive) return result;
  // 导入台账（import_executions）已清空，原件归档再无引用，留着只会把客户文件留在服务器上。
  if (deferArchive) {
    // 业务库回滚时导入台账还在、仍指向这些原件，所以要等外层确实提交了才删。
    // 刚记的那条审计的编号（last_insert_rowid 是非负整数，按 count 取第一列）
    const auditRow = count(store.db, 'SELECT last_insert_rowid()');
    deferArchiveCleanup({ store, actor, scope, resetId, auditRow, clear: options.archive });
    result.archiveCleanup = 'after-commit';
    return result;
  }
  const cleaned = clearArchiveNow(store, actor, scope, resetId, options.archive);
  result.archives = cleaned.archives;
  if (cleaned.warning) result.warnings = [cleaned.warning];
  return result;
}

