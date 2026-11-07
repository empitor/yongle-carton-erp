import { Router, type Request } from 'express';
import { z } from 'zod';
import type { ImportManager } from '../import/manager.js';
import type { MarkAi } from './mark-ai.js';
import { MarkImportService } from './mark-import.js';
import { requirePermission } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import { markReviewSchema } from '../../shared/shipping-mark.js';
import { AI_HTTP_TIMEOUT_MS, type AiProgress } from '../../shared/ai-runtime.js';

export function markImportRouter(
  manager: ImportManager,
  ai: MarkAi,
  operator?: (req: Request) => any,
) {
  const router = Router(),
    marks = new MarkImportService(manager, ai);
  const actor = (req: Request) => requirePermission(operator?.(req), 'business:edit');
  router.get('/:id/marks', (req, res) => {
    actor(req);
    res.json(marks.view(String(req.params.id)));
  });
  router.put('/:id/marks', (req, res) => {
    actor(req);
    const v = z
      .strictObject({
        expectedRevision: z.number().int().nonnegative(),
        items: markReviewSchema.shape.items,
      })
      .parse(req.body);
    res.json(marks.saveItems(String(req.params.id), v.expectedRevision, v.items));
  });
  router.post('/:id/marks/recognize', async (req, res, next) => {
    const id = String(req.params.id),
      startedAt = Date.now();
    let done = false,
      sourceId: string | undefined;
    try {
      const who = actor(req),
        w = marks.workspace(id);
      const input = z
        .object({ consent: z.literal(true), stream: z.boolean().default(true) })
        .passthrough()
        .parse(req.body);
      marks.checkProfile(input);
      if (
        manager.markReview(id)?.committed ||
        ai.store.db
          .prepare("SELECT 1 FROM operation_requests WHERE kind='mark-import' AND request_id=?")
          .get(id)
      )
        throw new ImportError('唛头已归档，不能重新识别。', 409);
      req.setTimeout(AI_HTTP_TIMEOUT_MS);
      res.setTimeout(AI_HTTP_TIMEOUT_MS);
      res.on('close', () => {
        if (!done && sourceId) ai.abort(sourceId);
      });
      const perform = (onProgress?: (p: AiProgress) => void) =>
        marks.recognize(id, input, () => actor(req), {
          onSource: (source) => (sourceId = source),
          onProgress,
        });
      if (!input.stream) {
        const result = await perform();
        done = true;
        res.json(result);
        return;
      }
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.flushHeaders();
      const send = (event: string, data: unknown) => {
        if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      try {
        const result = await perform((p) => send('progress', p));
        done = true;
        send('result', result);
      } catch (e) {
        manager.recordFailure(e, w, {
          operation: 'analyze',
          stage: 'shipping-mark',
          stream: true,
          startedAt,
          actor: who,
        });
        send('error', { message: e instanceof Error ? e.message : '唛头识别失败。' });
      }
      res.end();
    } catch (e) {
      try {
        manager.recordFailure(e, manager.get(id), {
          operation: 'analyze',
          stage: 'shipping-mark',
          stream: false,
          startedAt,
          actor: operator?.(req),
        });
      } catch {}
      next(e);
    } finally {
      done = true;
    }
  });
  router.post('/:id/marks/commit', async (req, res, next) => {
    try {
      actor(req);
      res.json(await marks.commit(String(req.params.id), req.body, () => actor(req)));
    } catch (e) {
      next(e);
    }
  });
  return router;
}
