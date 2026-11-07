import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import type { ImportManager } from '../import/manager.js';
import { DevelopmentResetService } from './development-reset.js';
import { developmentResetSchema } from '../../shared/assistant-development-reset.js';
import { ImportError } from '../import/errors.js';
import { audit } from './management.js';
import { z } from 'zod';
/** 只清业务不清财务会留下指向空单据的财务记录；助手又不能写财务，所以交回给页面。 */
export function refuseWithFinanceData(store: Store) {
  const rows = new DevelopmentResetService(store).financeRows();
  if (rows)
    throw new ImportError(
      '财务里已有 ' + rows + ' 条记录，只清业务会留下对不上的财务数据。请到“系统维护”页面操作，那里会连财务一起清。',
      409,
    );
}
export function executeDevelopmentReset(
  store: Store,
  imports: ImportManager | undefined,
  raw: unknown,
  actor: Actor,
  includeFinance = true,
) {
  const schema=developmentResetSchema.extend({
    clearClosedFinance:z.boolean().optional(),
    financeDigest:z.string().length(64).optional(),
  });
  const v = schema.parse(raw);
  if (!includeFinance && v.scope !== 'ai-imports') refuseWithFinanceData(store);
  const clear = imports
      ? () => {
          const r = imports.deleteAllWorkspaces(actor);
          if (r.failed.length) {
            audit(
              store,
              actor,
              'business-management',
              'development-reset-partial',
              'ai-imports',
              null,
              { scope: v.scope, count: r.count, ids: r.ids, failed: r.failed },
            );
            throw new ImportError(
              (v.scope === 'all' ? '业务数据已清空；' : '') +
                '已清理' +
                r.count +
                '份AI工作区，另有' +
                r.failed.length +
                '份失败，请核验原回执后处理未完成项。',
              409,
            );
          }
          return { count: r.count, ids: r.ids };
        }
      : undefined;
  if ((v.scope === 'all' || v.scope === 'ai-imports') && !clear)
    throw new ImportError('AI导入服务未配置，未执行清理。', 503);
  return new DevelopmentResetService(store).execute(v.scope, actor, clear,{
    includeFinance,clearClosedFinance:v.clearClosedFinance,financeDigest:v.financeDigest,
    // 只清工作区时导入台账还在，原件归档要留着；清业务记录时台账没了，归档跟着清。
    ...(imports && v.scope !== 'ai-imports' ? { clearArchive: () => imports.clearArchive(actor) } : {}),
  });
}
