import { Router, type Request } from 'express';
import { z } from 'zod';
import { extname } from 'node:path';
import type { ImportManager } from '../import/manager.js';
import type { MarkAi } from './mark-ai.js';
import { MarkService } from './service.js';
import { requirePermission, audit } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import { markReviewSchema, type MarkReview } from '../../shared/shipping-mark.js';
import { matchMarkToProducts, normalizeCode } from '../../shared/mark-matching.js';
import { productSchema } from '../../shared/domain.js';
import { AI_HTTP_TIMEOUT_MS, type AiProgress } from '../../shared/ai-runtime.js';

export function markImportRouter(
  manager: ImportManager,
  ai: MarkAi,
  operator?: (req: Request) => any,
) {
  const router = Router(),
    service = new MarkService(ai.store);
  const actor = (req: Request) => requirePermission(operator?.(req), 'business:edit');
  const workspace = (id: string) => {
    const w = manager.get(id);
    if (w.mode !== 'mark') throw new ImportError('请先将此文件切换为唛头识别。', 409);
    return w;
  };
  const products = () =>
    ai.store
      .products()
      .map(({ id, name, customerProductCode, length, width, height, dimensionUnit }) => ({
        id,
        name,
        customerProductCode,
        length,
        width,
        height,
        dimensionUnit,
      }));
  const view = (id: string) => {
    workspace(id);
    const review = manager.markReview(id),
      all = products();
    return {
      review,
      candidates: Object.fromEntries(
        (review?.items || []).map((i) => [i.key, matchMarkToProducts(i.fields, all)]),
      ),
      products: all,
    };
  };
  router.get('/:id/marks', (req, res) => {
    actor(req);
    res.json(view(String(req.params.id)));
  });
  router.put('/:id/marks', (req, res) => {
    actor(req);
    const id = String(req.params.id);
    workspace(id);
    const old = manager.markReview(id);
    if (!old) throw new ImportError('请先识别唛头。', 409);
    const v = z
      .strictObject({
        expectedRevision: z.number().int().nonnegative(),
        items: markReviewSchema.shape.items,
      })
      .parse(req.body);
    if (
      v.items.length !== old.items.length ||
      new Set(v.items.map((i) => i.key)).size !== old.items.length ||
      v.items.some((i) => !old.items.some((o) => o.key === i.key))
    )
      throw new ImportError('唛头条目与识别结果不一致。', 400);
    res.json(manager.saveMarkReview(id, v.expectedRevision, { ...old, items: v.items }));
  });
  router.post('/:id/marks/recognize', async (req, res, next) => {
    const id = String(req.params.id),
      startedAt = Date.now();
    let done = false,
      sourceId: string | undefined;
    try {
      const who = actor(req),
        w = workspace(id);
      if (
        manager.markReview(id)?.committed ||
        ai.store.db
          .prepare("SELECT 1 FROM operation_requests WHERE kind='mark-import' AND request_id=?")
          .get(id)
      )
        throw new ImportError('唛头已归档，不能重新识别。', 409);
      const input = z
        .object({
          consent: z.literal(true),
          stream: z.boolean().default(true),
          force: z.boolean().default(false),
          policyVersion: z.number().int().optional(),
          profile: z
            .object({
              id: z.string(),
              endpoint: z.string(),
              model: z.string(),
              apiStyle: z.enum(['responses', 'chat-completions']),
            })
            .optional(),
        })
        .parse(req.body);
      const profile = ai.settings.view().active;
      if (!profile?.hasApiKey || !profile.model)
        throw new ImportError('请先保存并启用AI预设。', 400);
      if (
        input.profile &&
        ['id', 'endpoint', 'model', 'apiStyle'].some(
          (k) => (input.profile as any)[k] !== (profile as any)[k],
        )
      )
        throw new ImportError('AI配置已变化，请重新确认外发范围。', 409);
      const original = await manager.original(id),
        source = ai.upload(original.bytes, original.fileName, who)!;
      sourceId = source.id;
      req.setTimeout(AI_HTTP_TIMEOUT_MS);
      res.setTimeout(AI_HTTP_TIMEOUT_MS);
      res.on('close', () => {
        if (!done && sourceId) ai.abort(sourceId);
      });
      const perform = async (onProgress?: (p: AiProgress) => void) => {
        const result =
          source.result && !input.force
            ? source
            : await ai.analyze(source.id, { ...input, profile }, who, onProgress);
        actor(req);
        const all = products();
        const review: MarkReview = {
          fileHash: w.fileHash,
          recognizedAt: result!.recognizedAt,
          warnings: result!.result.warnings,
          committed: null,
          items: result!.result.marks.map(({ page, title, ...fields }: any, index: number) => {
            const recommended = matchMarkToProducts(fields, all).filter((c) => c.recommended);
            return {
              key: 'p' + page + '-' + index,
              page,
              title,
              fields,
              choice:
                recommended.length === 1
                  ? { mode: 'existing', id: recommended[0].id }
                  : { mode: 'pending' },
              skip: false,
            };
          }),
        };
        return manager.saveMarkReview(id, w.revision, review);
      };
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
      const who = actor(req),
        id = String(req.params.id),
        w = workspace(id);
      const input = z
        .strictObject({
          expectedRevision: z.number().int().nonnegative(),
          requestId: z.string().uuid(),
        })
        .parse(req.body);
      const review = manager.markReview(id);
      if (!review) throw new ImportError('请先识别唛头。', 409);
      const db = ai.store.db;
      const prior = db
        .prepare("SELECT result FROM operation_requests WHERE kind='mark-import' AND request_id=?")
        .get(id);
      if (review.committed || prior) {
        const committed = review.committed || JSON.parse(String(prior!.result));
        if (!review.committed) manager.saveMarkReview(id, w.revision, { ...review, committed });
        res.json(committed);
        return;
      }
      if (w.revision !== input.expectedRevision) throw new ImportError('草稿已变化，请刷新。', 409);
      const pending = review.items.filter((i) => !i.skip && i.choice.mode === 'pending');
      if (pending.length)
        throw new ImportError(
          '请先选择产品：' + pending.map((i) => i.title || i.key).join('、'),
          400,
        );
      const original = await manager.original(id);
      actor(req);
      const currentReview = manager.markReview(id);
      const currentPrior = db
        .prepare("SELECT result FROM operation_requests WHERE kind='mark-import' AND request_id=?")
        .get(id);
      if (currentReview?.committed || currentPrior) {
        const committed = currentReview?.committed || JSON.parse(String(currentPrior!.result));
        if (!currentReview?.committed)
          manager.saveMarkReview(id, manager.get(id).revision, { ...currentReview!, committed });
        res.json(committed);
        return;
      }
      if (manager.get(id).revision !== input.expectedRevision)
        throw new ImportError('草稿已变化，请刷新。', 409);
      const reuse = db
        .prepare(
          "SELECT digest FROM operation_requests WHERE kind='mark-import-request' AND request_id=?",
        )
        .get(input.requestId);
      if (reuse && reuse.digest !== id) throw new ImportError('请求编号已用于其他工作区。', 409);
      const mime =
        (
          {
            '.pdf': 'application/pdf',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
          } as Record<string, string>
        )[extname(original.fileName).toLowerCase()] || 'application/octet-stream';
      db.exec('SAVEPOINT mark_commit');
      let committed: NonNullable<MarkReview['committed']>;
      try {
        // Recheck after awaiting the original: another commit may have completed meanwhile.
        const previous = db
          .prepare(
            "SELECT result FROM operation_requests WHERE kind='mark-import' AND request_id=?",
          )
          .get(id);
        if (previous) committed = JSON.parse(String(previous.result));
        else {
          // 同一份文件里多款选“新建”且名称相同时，只建一个产品。
          const created = new Map<string, any>();
          const results = review.items
            .filter((i) => !i.skip)
            .map((i) => {
              if (i.choice.mode === 'pending') throw new ImportError('请选择产品。', 400);
              const newKey = i.choice.mode === 'new' ? normalizeCode(i.choice.name) : '';
              const isNew = i.choice.mode === 'new' && !created.has(newKey);
              const product =
                i.choice.mode === 'existing'
                  ? ai.store.product(i.choice.id)
                  : created.get(newKey) ||
                    ai.store.saveProduct(
                      productSchema.parse({
                        name: i.choice.name,
                        customerProductCode: i.choice.customerProductCode,
                      }),
                    );
              if (i.choice.mode === 'new') created.set(newKey, product);
              if (!product) throw new ImportError('产品不存在或已归档。', 404);
              if (isNew)
                audit(ai.store, who, 'marks', 'create-product', 'products', product.id, product);
              const mark = service.add(
                {
                  productId: product.id,
                  bytes: original.bytes,
                  name: original.fileName,
                  mime,
                  page: i.page,
                  title: i.title || '',
                  fields: i.fields,
                  sourceKind: 'ai-import',
                  sourceRef: id,
                },
                who,
              );
              return { key: i.key, productId: product.id, markId: mark.id };
            });
          committed = { at: new Date().toISOString(), results };
          db.prepare('INSERT INTO operation_requests VALUES(?,?,?,?)').run(
            'mark-import',
            id,
            review.fileHash,
            JSON.stringify(committed),
          );
          db.prepare('INSERT INTO operation_requests VALUES(?,?,?,?)').run(
            'mark-import-request',
            input.requestId,
            id,
            JSON.stringify(committed),
          );
        }
        db.exec('RELEASE mark_commit');
      } catch (e) {
        db.exec('ROLLBACK TO mark_commit; RELEASE mark_commit');
        throw e;
      }
      manager.saveMarkReview(id, input.expectedRevision, { ...review, committed });
      res.json(committed);
    } catch (e) {
      next(e);
    }
  });
  return router;
}
