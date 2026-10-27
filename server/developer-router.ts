import { Router } from 'express';
import { z } from 'zod';
import type { Store } from './db.js';
import type { AuthManager } from './auth.js';
import type { ImportManager } from './import/manager.js';
import { requireDeveloper } from './developer-capability.js';
import { DeveloperService } from './developer-service.js';
import { ImportError } from './import/errors.js';
import { audit } from './business/management.js';
export function developerRouter(store: Store, auth: AuthManager, imports?: ImportManager) {
  const router = Router(),
    service = new DeveloperService(store);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    requireDeveloper(auth.actor(req));
    if (req.method !== 'GET' && req.headers['x-erp-auth-token'] !== auth.csrf)
      throw new ImportError('页面凭证失效。', 403);
    next();
  });
  router.get('/records', (req, res) =>
    res.json(service.list(String(req.query.module), auth.actor(req))),
  );
  router.post('/execute', (req, res) =>
    res.json(service.execute(req.body, auth.actor(req), auth.sessionBinding(req))),
  );
  router.get('/workspaces', (_req, res) => {
    if (!imports) throw new ImportError('工作区未配置。', 503);
    res.json({ active: imports.status().workspaces, trash: imports.trash() });
  });
  router.post('/workspaces', async (req, res, next) => {
    try {
      const actor = requireDeveloper(auth.actor(req));
      if (!imports) throw new ImportError('工作区未配置。', 503);
      const v = z
        .strictObject({
          action: z.enum(['fork', 'remove', 'restore', 'purge']),
          items: z
            .array(
              z.strictObject({
                id: z.string().uuid(),
                revision: z.number().int().nonnegative().optional(),
              }),
            )
            .min(1)
            .max(200),
        })
        .parse(req.body);
      if (new Set(v.items.map((i) => i.id)).size !== v.items.length)
        throw new ImportError('重复选择文件。');
      const results = [];
      for (const item of v.items) {
        try {
          const result =
            v.action === 'fork'
              ? await imports.developerFork(item.id, actor)
              : v.action === 'restore'
                ? await imports.restore(item.id)
                : v.action === 'purge'
                  ? await imports.developerPurge(item.id, actor)
                  : await imports.remove(item.id, {
                      expectedRevision: item.revision,
                      acknowledged: true,
                    });
          audit(store, actor, 'local-developer', v.action, 'ai-workspace', null, {
            id: item.id,
            resultId: (result as any).id,
          });
          results.push({ id: item.id, success: true, result });
        } catch (e) {
          results.push({
            id: item.id,
            success: false,
            message: e instanceof Error ? e.message : '操作失败',
          });
        }
      }
      res.json({ results });
    } catch (e) {
      next(e);
    }
  });
  return router;
}
