import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import type { ImportManager } from '../import/manager.js';
import { DevelopmentResetService } from './development-reset.js';
import { developmentResetSchema } from '../../shared/assistant-development-reset.js';
import { ImportError } from '../import/errors.js';
import { audit } from './management.js';
export function executeDevelopmentReset(
  store: Store,
  imports: ImportManager | undefined,
  raw: unknown,
  actor: Actor,
) {
  const v = developmentResetSchema.parse(raw),
    clear = imports
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
  return new DevelopmentResetService(store).execute(v.scope, actor, clear);
}
