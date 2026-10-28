import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { AuthManager } from '../auth.js';
import { ImportError } from '../import/errors.js';
import { OperationsService } from './service.js';
import { changeLifecycle } from '../business/management.js';
import { stockKinds, purchaseStatuses, quantityString } from '../../shared/operations.js';

import { purchaseFilterSchema, matchesPurchase } from '../../shared/purchase-filters.js';
import { movementFilterSchema, matchesMovement } from '../../shared/movement-filters.js';
import {
  purchaseMetrics,
  inventoryMetrics,
  summarizeMovements,
  matchesOperationalRecord,
} from '../../shared/business-metrics.js';
export function operationsRouter(store: Store, auth?: AuthManager) {
  const router = Router(),
    service = new OperationsService(store);
  const actor = (req: Request) => {
    if (!auth || req.headers['x-erp-auth-token'] !== auth.csrf)
      throw new ImportError('请登录并刷新页面凭证。', 403);
    return auth.actor(req);
  };
  const include = (req: Request) => {
    if (req.query.archived === 'all') {
      if (!auth) throw new ImportError('请进入超级管理员模式。', 403);
      auth.requireSuperMode(req);
      return true;
    }
    return req.query.archived === '1';
  };
  const id = (req: Request) => z.coerce.number().int().positive().parse(req.params.id);
  for (const entity of ['suppliers', 'purchases', 'stock_items'] as const) {
    const path = entity === 'stock_items' ? '/warehouse/items' : '/' + entity;
    router.get(path, (req, res) => {
      if (entity === 'purchases') {
        const query = purchaseFilterSchema.parse(req.query);
        const scoped = store
            .purchases(include(req))
            .filter((r) => req.query.archived !== '1' || r.archived),
          rows = scoped.filter((r) => matchesPurchase(r, query));
        return res.json(
          req.query.withMetrics === '1'
            ? { rows, totalRecords: scoped.length, metrics: purchaseMetrics(rows) }
            : rows,
        );
      }
      const q = z
        .object({
          q: z.string().max(200).optional(),
          supplierId: z.coerce.number().int().positive().optional(),
          status: z.enum(purchaseStatuses).optional(),
          kind: z.enum(stockKinds).optional(),
          zero: z.enum(['1', '0']).optional(),
          history: z.enum(['with', 'without']).optional(),
        })
        .parse(req.query);
      const scoped = store[entity](include(req)).filter(
        (r) => (req.query.archived !== '1' || r.archived) && (!q.kind || r.kind === q.kind),
      );
      const rows = scoped.filter(
        (r) =>
          (req.query.archived !== '1' || r.archived) &&
          (!q.q ||
            (req.query.withMetrics === '1'
              ? matchesOperationalRecord(r, q.q)
              : JSON.stringify(r).toLowerCase().includes(q.q.toLowerCase()))) &&
          (!q.supplierId || r.supplierId === q.supplierId) &&
          (!q.status || r.status === q.status) &&
          (!q.kind || r.kind === q.kind) &&
          (q.zero !== '1' || r.balanceUnits === 0) &&
          (!q.history || (q.history === 'with') === r.purchaseHistory?.length > 0),
      );
      res.json(
        req.query.withMetrics === '1'
          ? {
              rows,
              totalRecords: scoped.length,
              metrics:
                entity === 'stock_items'
                  ? {
                      raw: inventoryMetrics(rows, 'raw'),
                      finished: inventoryMetrics(rows, 'finished'),
                    }
                  : null,
            }
          : rows,
      );
    });
    for (const method of ['post', 'put'] as const)
      router[method](path + (method === 'put' ? '/:id' : ''), (req, res) => {
        const who = actor(req),
          recordId = method === 'put' ? id(req) : undefined;
        res
          .status(method === 'post' ? 201 : 200)
          .json(
            entity === 'suppliers'
              ? service.saveSupplier(req.body, who, recordId)
              : entity === 'purchases'
                ? service.savePurchase(req.body, who, recordId)
                : service.saveItem(req.body, who, recordId),
          );
      });
    router.post('/' + entity + '/batch', (req, res) =>
      res.json(changeLifecycle(store, entity, req.body, actor(req))),
    );
  }
  router.post('/purchases/:id/receive', (req, res) =>
    res.json(service.receive(id(req), req.body, actor(req))),
  );
  router.post('/warehouse/items/:id/move', (req, res) =>
    res.json(service.move(id(req), req.body, actor(req))),
  );
  router.get('/warehouse/movements', (req, res) => {
    const q = movementFilterSchema.parse(req.query),
      rows = service.repo.movements(q);
    if (req.query.withMetrics !== '1') return res.json(rows);
    const history = service.repo.movements(),
      related = new Set(
        history
          .filter((r) => matchesMovement(r, { ...q, start: undefined, end: undefined }))
          .map((r) => Number(r.item_id)),
      );
    const items = service.repo
      .items(true)
      .filter(
        (i) =>
          (!q.kind || i.kind === q.kind) &&
          (!q.itemId || i.id === q.itemId) &&
          (!q.q || matchesOperationalRecord(i, q.q) || related.has(i.id)),
      );
    res.json({ rows, totalRecords: history.length, metrics: summarizeMovements(rows, items) });
  });
  router.get('/warehouse/summary', (req, res) => {
    const kind = z.enum(stockKinds).optional().parse(req.query.kind),
      groups = new Map<string, { unit: string; quantityUnits: number; itemCount: number }>();
    for (const item of service.repo.items().filter((i) => !kind || i.kind === kind)) {
      const g = groups.get(item.unit) || { unit: item.unit, quantityUnits: 0, itemCount: 0 };
      g.quantityUnits += item.balanceUnits;
      g.itemCount++;
      groups.set(item.unit, g);
    }
    res.json(
      [...groups.values()].map((g) => ({ ...g, quantity: quantityString(g.quantityUnits) })),
    );
  });
  return router;
}
