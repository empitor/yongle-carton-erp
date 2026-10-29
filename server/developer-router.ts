import { Router } from 'express';
import { z } from 'zod';
import type { Store } from './db.js';
import type { AuthManager } from './auth.js';
import type { ImportManager } from './import/manager.js';
import { requireDeveloper } from './developer-capability.js';
import { DeveloperService } from './developer-service.js';
import { ImportError } from './import/errors.js';
import { randomUUID } from 'node:crypto';
import { manageWorkspaces } from './workspace-management.js';
import { recordContext } from './business/record-context.js';
import { DatabaseMaintenanceService } from './business/database-maintenance.js';
import { DevelopmentResetService, developmentResetScope } from './business/development-reset.js';
import { executeDevelopmentReset } from './business/reset-execution.js';
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
  router.get('/reset-preview', (req, res) =>
    res.json(
      new DevelopmentResetService(store).preview(
        z.enum(developmentResetScope).parse(req.query.scope),
        auth.actor(req)!,
      ),
    ),
  );
  router.post('/reset', (req, res) =>
    res.json(executeDevelopmentReset(store, imports, req.body, auth.actor(req)!)),
  );
  router.get('/context', (req, res) =>
    res.json(
      recordContext(
        store,
        String(req.query.module),
        z.coerce.number().int().positive().parse(req.query.id),
        auth.actor(req),
      ),
    ),
  );
  router.post('/execute', (req, res) =>
    res.json(service.execute(req.body, auth.actor(req), auth.sessionBinding(req))),
  );
  router.post('/deletions/preview', (req, res) =>
    res.json(new DatabaseMaintenanceService(store).preview(req.body, auth.actor(req))),
  );
  router.get('/workspaces', (_req, res) => {
    if (!imports) throw new ImportError('工作区未配置。', 503);
    res.json({
      active: imports.status().workspaces,
      trash: imports.archives(),
      archives: imports.archives(),
    });
  });
  router.post('/workspaces', async (req, res, next) => {
    try {
      const actor = requireDeveloper(auth.actor(req));
      if (!imports) throw new ImportError('工作区未配置。', 503);
      res.json(
        await manageWorkspaces(
          store,
          imports,
          { ...req.body, requestId: req.body.requestId || randomUUID() },
          actor,
          auth.sessionBinding(req),
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  return router;
}
