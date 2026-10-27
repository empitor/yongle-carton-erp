import express, { Router, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import { ImportManager } from './manager.js';
import { FlowService } from '../flow/service.js';
import { requirePermission } from '../business/management.js';
import type { ReceiptAi } from '../flow/receipt-ai.js';
import { ImportError } from './errors.js';
import { AiConnectionError } from '../ai/connection-error.js';
import { AI_HTTP_TIMEOUT_MS, type AiProgress } from '../../shared/ai-runtime.js';
import { requireLocalAdministrator, isLocalAdministrator } from '../developer-capability.js';
import type { Actor } from '../auth.js';
export function importRouter(
  manager: ImportManager,
  operator?: (req: express.Request) => { id: string; name: string; permissions?: string[] } | null,
  receiptAi?: ReceiptAi,
) {
  if (receiptAi) manager.abortArrival = (id) => receiptAi.abort(id);
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return res.status(403).json({ message: '导入工作区仅允许从本机管理系统页面访问。' });
    if (req.method !== 'GET') {
      const token = req.headers['x-erp-ai-token'];
      if (
        typeof token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(token) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(manager.csrfToken))
      )
        return res.status(403).json({ message: '页面安全凭证无效，请刷新工作区。' });
    }
    next();
  });
  const safe =
    (job: (req: express.Request, res: Response) => Promise<unknown> | unknown) =>
    (req: express.Request, res: Response, next: express.NextFunction) => {
      Promise.resolve()
        .then(() => job(req, res))
        .catch(next);
    };
  router.get(
    '/',
    safe((_req, res) => {
      const status = manager.status();
      if (receiptAi?.store) {
        const documents = new FlowService(receiptAi.store).list('arrival', true),
          sources = receiptAi.sources();
        for (const file of status.workspaces as any[]) {
          const source = sources.find((s) => s.id === file.arrivalSourceId),
            document = documents.find((d) => d.id === file.arrivalDocId);
          file.arrivalStatus =
            document?.status === 'confirmed'
              ? 'confirmed'
              : source && receiptAi.isBusy(source.id)
                ? 'running'
                : source?.lastError?.state ||
                  document?.status ||
                  (source?.result ? 'recognized' : 'uploaded');
          file.arrivalNumber = document?.number || null;
        }
      }
      res.json(status);
    }),
  );
  router.post(
    '/:id/mode',
    safe((req, res) => {
      const workspace = manager.get(String(req.params.id));
      if (
        receiptAi &&
        workspace.arrivalDocId &&
        req.body.mode !== workspace.mode &&
        new FlowService(receiptAi.store).get(workspace.arrivalDocId).status !== 'draft'
      )
        throw new ImportError('到货单已确认或取消，识别类型已锁定，请保留原记录。', 409);
      res.json(manager.setMode(workspace.id, req.body));
    }),
  );
  const arrivalActor = (req: express.Request) => {
    const actor = operator?.(req);
    if (!actor) throw new ImportError('请登录有业务编辑权限的账号。', 403);
    return requirePermission(
      { ...actor, permissions: actor.permissions || [] } as any,
      'business:edit',
    );
  };
  router.get(
    '/:id/arrival/assistant',
    safe((req, res) => {
      const actor = arrivalActor(req);
      if (!receiptAi) throw new ImportError('到货助手未配置。', 503);
      res.json(receiptAi.draftAssistant.view(manager, String(req.params.id), actor));
    }),
  );
  for (const action of ['sync', 'undo', 'chat'] as const)
    router.post(
      '/:id/arrival/assistant' + (action === 'sync' ? '' : '/' + action),
      safe(async (req, res) => {
        const actor = arrivalActor(req),
          id = String(req.params.id);
        if (!receiptAi) throw new ImportError('到货助手未配置。', 503);
        if (action !== 'chat') {
          res.json(receiptAi.draftAssistant[action](manager, id, req.body, actor));
          return;
        }
        const diagnosticWorkspace = manager.get(id),
          startedAt = Date.now();
        const diagnose = (error: unknown) => {
          try {
            return {
              failureId: manager.recordFailure(error, diagnosticWorkspace, {
                operation: 'chat',
                stream: req.body.stream === true,
                stage: 'arrival-draft-chat',
                startedAt,
                actor,
              }),
            };
          } catch {
            return { diagnosticStorageError: true };
          }
        };
        req.setTimeout(AI_HTTP_TIMEOUT_MS * 3);
        res.setTimeout(AI_HTTP_TIMEOUT_MS * 3);
        let done = false;
        res.on('close', () => {
          if (!done) receiptAi.draftAssistant.abort(id);
        });
        const live = () => {
          try {
            return arrivalActor(req);
          } catch {
            return null;
          }
        };
        if (req.body.stream !== true) {
          try {
            res.json(await receiptAi.draftAssistant.chat(manager, id, req.body, actor, live));
          } catch (e) {
            diagnose(e);
            throw e;
          } finally {
            done = true;
          }
          return;
        }
        res
          .set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
          })
          .flushHeaders();
        const send = (event: string, data: unknown) => {
          if (!res.destroyed)
            res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
        };
        const timer = setInterval(
          () => send('progress', { stage: 'waiting', elapsedMs: Date.now() - startedAt }),
          10000,
        );
        timer.unref();
        try {
          send(
            'result',
            await receiptAi.draftAssistant.chat(manager, id, req.body, actor, live, (p) =>
              send('progress', p),
            ),
          );
        } catch (e) {
          send('error', {
            message:
              e instanceof ImportError || e instanceof AiConnectionError
                ? e.message
                : e instanceof ZodError
                  ? '到货助手返回的字段不合法，原草稿保留。'
                  : '到货助手处理失败，原草稿保留。',
            ...diagnose(e),
          });
        } finally {
          done = true;
          clearInterval(timer);
          res.end();
        }
      }),
    );
  router.post(
    '/:id/arrival/link',
    safe((req, res) => {
      arrivalActor(req);
      if (!receiptAi) throw new ImportError('供应商到货AI未配置。', 503);
      const workspace = manager.get(String(req.params.id));
      const input = z
        .strictObject({
          expectedRevision: z.number().int().nonnegative(),
          docId: z.number().int().positive().nullable(),
          sourceId: z.string().uuid().nullable().optional(),
        })
        .parse(req.body);
      const document = input.docId ? new FlowService(receiptAi.store).get(input.docId) : null;
      if (document && document.kind !== 'arrival')
        throw new ImportError('只能关联采购到货草稿。', 422);
      const sourceId = input.sourceId || document?.sourceId;
      if (document && (!sourceId || document.sourceId !== sourceId))
        throw new ImportError('到货草稿与来源原件不一致。', 409);
      if (sourceId && receiptAi.source(sourceId).hash !== workspace.fileHash)
        throw new ImportError('不能关联其他文件的到货记录。', 409);
      res.json(manager.linkArrival(workspace.id, { ...input, ...(sourceId ? { sourceId } : {}) }));
    }),
  );
  router.post(
    '/:id/arrival/recognize',
    safe(async (req, res) => {
      const actor = arrivalActor(req),
        id = String(req.params.id);
      if (!receiptAi) throw new ImportError('供应商到货AI未配置。', 503);
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
      const workspace = manager.get(id);
      if (workspace.mode !== 'arrival')
        throw new ImportError('请先将此文件切换为到货单识别。', 409);
      if (
        workspace.arrivalDocId &&
        receiptAi.store &&
        new FlowService(receiptAi.store).get(workspace.arrivalDocId).status !== 'draft'
      )
        throw new ImportError('已确认或取消的到货单不能重新识别覆盖。', 409);
      const profile = receiptAi.settings.view().active;
      if (!profile?.hasApiKey || !profile.model)
        throw new ImportError('请先保存并启用AI预设。', 400);
      if (
        input.profile &&
        ['id', 'endpoint', 'model', 'apiStyle'].some(
          (key) => (input.profile as any)[key] !== (profile as any)[key],
        )
      )
        throw new ImportError('AI配置已变化，请重新确认当前文件外发范围。', 409);
      const original = await manager.original(id),
        source = receiptAi.upload(original.bytes, original.fileName, actor)!;
      if (workspace.arrivalSourceId !== source.id)
        manager.linkArrival(id, {
          expectedRevision: workspace.revision,
          docId: workspace.arrivalDocId || null,
          sourceId: source.id,
        });
      let done = false;
      req.setTimeout(AI_HTTP_TIMEOUT_MS);
      res.setTimeout(AI_HTTP_TIMEOUT_MS);
      res.on('close', () => {
        if (!done) receiptAi.abort(source.id);
      });
      const startedAt = Date.now();
      const perform = async (progress?: (p: AiProgress) => void) => {
        if ((source as any).result && !input.force) return source;
        return receiptAi.analyze(
          source.id,
          {
            consent: true,
            stream: input.stream,
            force: input.force,
            policyVersion: input.policyVersion,
            profile: {
              id: profile.id,
              endpoint: profile.endpoint,
              model: profile.model,
              apiStyle: profile.apiStyle || 'chat-completions',
            },
          },
          actor,
          progress,
        );
      };
      const diagnose = (error: unknown) =>
        manager.recordFailure(error, workspace, {
          operation: 'analyze',
          stream: input.stream,
          stage: 'supplier-arrival',
          startedAt,
          actor,
        });
      if (!input.stream) {
        try {
          const result = await perform();
          done = true;
          res.json(result);
        } catch (error) {
          diagnose(error);
          throw error;
        }
        return;
      }
      res
        .set({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        })
        .flushHeaders();
      const send = (event: string, data: unknown) => {
        if (!res.destroyed)
          res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      };
      const timer = setInterval(
        () => send('progress', { stage: 'waiting', elapsedMs: Date.now() - startedAt }),
        10000,
      );
      timer.unref();
      try {
        send('progress', { stage: 'connecting', elapsedMs: 0 });
        send('result', await perform((p) => send('progress', p)));
      } catch (error) {
        const failureId = diagnose(error);
        send('error', {
          message:
            error instanceof ImportError || error instanceof AiConnectionError
              ? error.message
              : error instanceof ZodError
                ? '到货识别格式不正确，未保存草稿。'
                : '到货识别失败，请查看错误档案。',
          failureId,
        });
      } finally {
        done = true;
        clearInterval(timer);
        res.end();
      }
    }),
  );
  router.post(
    '/remove-many',
    safe(async (req, res) => res.json(await manager.removeMany(req.body))),
  );
  router.post(
    '/delete-many',
    safe(async (req, res) => {
      const actor = requireLocalAdministrator(operator?.(req) as Actor),
        v = z
          .object({
            items: z
              .array(z.object({ id: z.string().uuid(), expectedRevision: z.number().int() }))
              .min(1)
              .max(200),
          })
          .parse(req.body),
        results = [];
      for (const item of v.items) {
        try {
          await manager.deleteWorkspace(item.id, item.expectedRevision, actor);
          results.push({
            id: item.id,
            removed: true,
            deleted: true,
            message: '已从数据库和文件系统删除',
          });
        } catch (e) {
          results.push({ id: item.id, removed: false, message: (e as Error).message });
        }
      }
      res.json({ results });
    }),
  );
  router.post(
    '/:id/delete',
    safe(async (req, res) =>
      res.json(
        await manager.deleteWorkspace(
          String(req.params.id),
          z.object({ expectedRevision: z.number().int() }).parse(req.body).expectedRevision,
          requireLocalAdministrator(operator?.(req) as Actor),
        ),
      ),
    ),
  );
  router.post(
    '/:id/open-archive',
    safe(async (req, res) =>
      res.json(
        await manager.openArchivedWorkspace(
          String(req.params.id),
          requireLocalAdministrator(operator?.(req) as Actor),
        ),
      ),
    ),
  );
  router.post(
    '/:id/archive',
    safe((req, res) =>
      res.json(
        manager.archiveWorkspace(
          String(req.params.id),
          z.object({ expectedRevision: z.number().int() }).parse(req.body).expectedRevision,
          requireLocalAdministrator(operator?.(req) as Actor),
        ),
      ),
    ),
  );
  const diagnosticActor = (req: express.Request) => {
    const actor = operator?.(req);
    if (!actor?.permissions?.includes('business:edit'))
      throw new ImportError('请登录有业务管理权限的账号查看错误档案。', 403);
    return actor;
  };
  router.get(
    '/diagnostics',
    safe((req, res) => {
      diagnosticActor(req);
      const q = z
        .object({
          workspaceId: z.string().uuid().optional(),
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
        })
        .parse(req.query);
      res.json(manager.failures(q.workspaceId, q.offset));
    }),
  );
  router.get(
    '/diagnostics/:failureId',
    safe((req, res) => {
      diagnosticActor(req);
      const record = manager.failure(String(req.params.failureId));
      if (req.query.download === '1')
        res.set('Content-Disposition', 'attachment; filename="ai-failure-' + record.id + '.json"');
      res.json(record);
    }),
  );
  router.post('/:id/enqueue', (req, res) =>
    res.status(202).json(manager.enqueue(String(req.params.id), req.body, operator?.(req))),
  );
  for (const action of ['analyze', 'chat'] as const)
    router.post(
      '/:id/' + action,
      safe(async (req, res) => {
        const id = String(req.params.id),
          stream = req.body?.stream === true,
          input = { ...req.body, stream };
        req.setTimeout(AI_HTTP_TIMEOUT_MS);
        res.setTimeout(AI_HTTP_TIMEOUT_MS);
        let finished = false;
        const closed = () => {
          if (!finished) manager.abortRequest(id);
        };
        res.on('close', closed);
        if (!stream) {
          try {
            res.json(await manager[action](id, input, undefined, operator?.(req)));
          } finally {
            finished = true;
            res.off('close', closed);
          }
          return;
        }
        res.status(200).set({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
          Connection: 'keep-alive',
        });
        res.flushHeaders();
        const started = Date.now();
        let progress: AiProgress = { stage: 'connecting', receivedChars: 0, elapsedMs: 0 },
          last = 0;
        const send = (event: string, data: unknown) => {
          if (!res.destroyed && !res.writableEnded)
            res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
        };
        const update = (p: AiProgress) => {
          progress = { ...p, elapsedMs: Date.now() - started };
          if (Date.now() - last >= 250 || p.stage === 'validating') {
            send('progress', progress);
            last = Date.now();
          }
        };
        send('progress', progress);
        const heartbeat = setInterval(
          () => send('progress', { ...progress, elapsedMs: Date.now() - started }),
          10000,
        );
        heartbeat.unref();
        try {
          if (res.destroyed) return;
          const workspace = await manager[action](id, input, update, operator?.(req));
          send('result', workspace);
        } catch (error) {
          const message =
            error instanceof ImportError || error instanceof AiConnectionError
              ? error.message
              : error instanceof ZodError
                ? 'AI返回结构或订单字段不符合约定，未保存本次草稿。'
                : 'AI请求失败，未保存不完整草稿。';
          send('error', {
            message,
            code:
              error instanceof ImportError || error instanceof AiConnectionError
                ? error.code
                : 'schema',
          });
        } finally {
          finished = true;
          clearInterval(heartbeat);
          res.off('close', closed);
          if (!res.destroyed) res.end();
        }
      }),
    );
  router.post(
    '/:id/remove',
    safe(async (req, res) => res.json(await manager.remove(String(req.params.id), req.body))),
  );
  router.post(
    '/:id/restore',
    safe(async (req, res) =>
      res.json(
        isLocalAdministrator(operator?.(req) as Actor)
          ? await manager.restoreWorkspace(String(req.params.id), operator!(req) as Actor)
          : await manager.restore(String(req.params.id)),
      ),
    ),
  );
  router.post(
    '/:id/confirm',
    safe((req, res) => res.json(manager.confirm(String(req.params.id), req.body, operator?.(req)))),
  );
  router.post(
    '/upload',
    express.raw({ type: 'application/octet-stream', limit: '10mb' }),
    safe(async (req, res) => {
      let name = '';
      try {
        name = decodeURIComponent(String(req.headers['x-file-name'] || ''));
      } catch {}
      if (!name || !Buffer.isBuffer(req.body))
        throw new ImportError('请通过文件上传区域选择有效文件。', 415);
      res.status(201).json(await manager.upload(req.body, name));
    }),
  );
  router.get(
    '/:id',
    safe((req, res) => res.json(manager.get(String(req.params.id)))),
  );
  router.get(
    '/:id/file',
    safe(async (req, res) => {
      const page =
        req.query.page === undefined
          ? undefined
          : z.coerce.number().int().positive().parse(req.query.page);
      const f = await manager.file(String(req.params.id), page);
      res.type(f.mime);
      if (page === undefined)
        res.set(
          'Content-Disposition',
          (req.query.view === 'image' && f.mime.startsWith('image/') ? 'inline' : 'attachment') +
            "; filename*=UTF-8''" +
            encodeURIComponent(f.name),
        );
      res.send(f.bytes);
    }),
  );
  for (const [path, fn] of [
    ['consent', manager.consent.bind(manager)],
    ['revoke-consent', manager.revoke.bind(manager)],
    ['cancel', manager.cancel.bind(manager)],
  ] as const)
    router.post(
      '/:id/' + path,
      safe(async (req, res) => res.json(await fn(String(req.params.id), req.body))),
    );
  for (const action of ['edit', 'undo', 'mapping'] as const)
    router.post(
      '/:id/' + action,
      safe((req, res) => {
        const id = String(req.params.id),
          who = operator?.(req) as Actor | null;
        res.json(
          action === 'edit'
            ? manager.edit(id, req.body, 'manual', who)
            : manager[action](id, req.body, who),
        );
      }),
    );
  router.post('/:id/execute', (_req, res) =>
    res
      .status(403)
      .json({ message: '正式 ERP 写入尚未开放。本轮仅核对草稿，不得绕过业务服务的导入写入限制。' }),
  );
  router.use((error: unknown, req: express.Request, res: Response, _next: express.NextFunction) => {
    // 文件/模型正文、密钥、请求内容与堆栈均不进入一般日志。
    let failureId: string | undefined;
    if (req.method === 'POST' && req.path === '/upload') {
      let name = '未知上传文件';
      try {
        name = decodeURIComponent(String(req.headers['x-file-name'] || name));
      } catch {}
      const failure =
        (error as any)?.type === 'entity.too.large'
          ? new ImportError('文件超过10MB，上传已拒绝。', 413, 'file-size')
          : error;
      try {
        failureId = manager.recordFailure(
          failure,
          { fileName: name, size: Buffer.isBuffer(req.body) ? req.body.length : 0 },
          { operation: 'upload', stage: 'upload-validation', actor: operator?.(req) },
        );
      } catch {}
    }
    if (error instanceof ImportError || error instanceof AiConnectionError)
      return res.status(error.status).json({ message: error.message, code: error.code, failureId });
    if (error instanceof ZodError)
      return res.status(422).json({
        message:
          '文件解析、草稿操作或 AI 返回结构不符合约定，未保存本次结果。请检查字段与来源后重试。',
        code: 'schema',
      });
    if ((error as any)?.type === 'entity.too.large')
      return res.status(413).json({ message: '文件超过 10 MB，已拒绝上传。', code: 'file-size' });
    res.status(500).json({
      message: '导入工作区操作失败，可能是文件损坏、磁盘不可写或解析器异常。未修改正式 ERP 数据。',
      code: 'import',
    });
  });
  return router;
}
