import { isSuperMode } from '../business/management.js';
import express, { Router } from 'express';
import { z } from 'zod';
import type { AuthManager } from '../auth.js';
import type { AssistantManager } from './manager.js';
import { ImportError } from '../import/errors.js';
import { AI_HTTP_TIMEOUT_MS } from '../../shared/ai-runtime.js';
import { transcribePcm } from '../speech/service.js';
import { isDeveloperActor } from '../developer-capability.js';
export function assistantRouter(manager: AssistantManager, auth: AuthManager) {
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!auth.actor(req)) throw new ImportError('请先登录管理账号。', 401);
    if (req.method !== 'GET' && req.headers['x-erp-auth-token'] !== auth.csrf)
      throw new ImportError('页面凭证失效，请刷新。', 403);
    next();
  });
  router.get('/', (req, res) => res.json(manager.state(auth.actor(req))));
  router.post('/threads/:id/tasks/activate', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    manager.view(id, auth.actor(req));
    if (manager.isBusy(id)) throw new ImportError('请先等待或停止当前回复。', 409);
    const v = z.strictObject({ taskId: z.string().uuid() }).parse(req.body);
    manager.tasks.activate(id, auth.actor(req)!, v.taskId);
    res.json(manager.view(id, auth.actor(req)));
  });
  router.get('/diagnostics', (req, res) => {
    const actor = auth.actor(req)!,
      threadId = z.string().uuid().parse(req.query.threadId);
    manager.view(threadId, actor);
    res.json({
      protocol: 'custom-json-envelope-v1',
      events: manager.store.db
        .prepare(
          "SELECT state,document,created_at AS at FROM assistant_audit WHERE user_id=? AND thread_id=? AND tool='provider.diagnostic' ORDER BY id DESC LIMIT 150",
        )
        .all(actor.id, threadId)
        .map(({ document, ...r }) => ({ ...r, ...JSON.parse(String(document)) })),
    });
  });
  router.post('/page/results', (req, res) => {
    res.json(manager.pageBridge.complete(req.body, auth.actor(req)!, auth.sessionBinding(req)));
  });
  router.get('/plugins', (req, res) => {
    const actor = auth.actor(req)!;
    const state = manager.registry.pluginsView(actor);
    res.json({
      ...state,
      canManage:
        actor.role === 'super_admin' &&
        (actor.permissions.includes('business:edit') || isSuperMode(actor)),
      plugins: state.plugins.map((p) => ({
        ...p,
        tools: p.tools.map((t) => ({
          ...t,
          lastExecution:
            manager.store.db
              .prepare(
                'SELECT state,created_at AS at FROM assistant_audit WHERE user_id=? AND tool=? ORDER BY id DESC LIMIT 1',
              )
              .get(actor.id, t.name) || null,
        })),
        logs: p.tools.length
          ? manager.store.db
              .prepare(
                'SELECT tool,state,created_at AS at FROM assistant_audit WHERE user_id=? AND tool IN (' +
                  p.tools.map(() => '?').join(',') +
                  ') ORDER BY id DESC LIMIT 20',
              )
              .all(actor.id, ...p.tools.map((t) => t.name))
          : [],
      })),
    });
  });
  router.post('/plugins/settings', (req, res) => {
    const actor = auth.actor(req)!;
    manager.registry.setPlugin(req.body, actor);
    manager.store.db
      .prepare(
        'INSERT INTO assistant_audit(user_id,thread_id,tool,state,document,created_at) VALUES(?,NULL,?,?,?,?)',
      )
      .run(
        actor.id,
        'plugins.configure',
        'completed',
        JSON.stringify(req.body),
        new Date().toISOString(),
      );
    res.json(manager.registry.pluginsView());
  });
  router.get('/tools', (req, res) => {
    const actor = auth.actor(req)!;
    const state = manager.registry.view(actor);
    res.json({
      ...state,
      canManage:
        actor.role === 'super_admin' &&
        (actor.permissions.includes('business:edit') || isSuperMode(actor)),
      tools: state.tools.map((t) => ({
        ...t,
        lastExecution:
          manager.store.db
            .prepare(
              'SELECT state,created_at AS at FROM assistant_audit WHERE user_id=? AND tool=? ORDER BY id DESC LIMIT 1',
            )
            .get(actor.id, t.name) || null,
      })),
    });
  });
  router.post('/tools/settings', (req, res) => {
    const actor = auth.actor(req)!;
    manager.registry.set(req.body, actor);
    manager.store.db
      .prepare(
        'INSERT INTO assistant_audit(user_id,thread_id,tool,state,document,created_at) VALUES(?,NULL,?,?,?,?)',
      )
      .run(
        actor.id,
        'tools.configure',
        'completed',
        JSON.stringify(req.body),
        new Date().toISOString(),
      );
    res.json(manager.registry.view(actor));
  });
  // 本地语音识别：音频只在本机后端内存中处理，不落盘、不外发。
  router.post(
    '/transcribe',
    express.raw({ type: 'application/octet-stream', limit: '3mb' }),
    async (req, res) => {
      const owner = auth.actor(req);
      if (!owner) throw new ImportError('登录状态已失效，请重新登录。', 401, 'speech');
      if (!Buffer.isBuffer(req.body) || !req.body.length)
        throw new ImportError('请通过语音识别入口提交 16kHz 单声道音频。', 415, 'speech');
      const result = await transcribePcm(req.body);
      if (res.destroyed) return;
      if (auth.actor(req)?.id !== owner.id)
        throw new ImportError('登录状态已变化，已丢弃本次语音结果。', 403, 'speech');
      res.json(result);
    },
  );
  router.post('/threads', (req, res) => res.status(201).json(manager.create(auth.actor(req))));
  router.post(
    '/threads/:id/attachments',
    express.raw({ type: 'application/octet-stream', limit: '10mb' }),
    async (req, res) => {
      if (manager.isBusy(String(req.params.id)))
        throw new ImportError('请先等待或停止当前AI回复，再上传附件。', 409);
      let name: string;
      try {
        name = decodeURIComponent(String(req.headers['x-file-name'] || ''));
      } catch {
        throw new ImportError('文件名编码无效。');
      }
      if (!Buffer.isBuffer(req.body))
        throw new ImportError('请通过附件上传入口提交原始字节。', 415);
      res
        .status(201)
        .json(
          await manager.attachments.upload(
            String(req.params.id),
            req.body,
            name,
            String(req.headers['x-upload-id'] || ''),
            auth.actor(req),
            () => (res.destroyed ? null : auth.actor(req)),
          ),
        );
    },
  );
  router.get('/attachments/:id/file', (req, res) => {
    const { meta, bytes } = manager.attachments.file(String(req.params.id), auth.actor(req));
    res.set({
      'Content-Type': meta.mime + (meta.kind === 'text' ? '; charset=utf-8' : ''),
      'Content-Disposition':
        (req.query.download === '1' ? 'attachment' : 'inline') +
        "; filename*=UTF-8''" +
        encodeURIComponent(meta.name),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.send(bytes);
  });
  router.post('/threads/:id/attachments/cancel-upload', (req, res) => {
    const input = z
      .strictObject({ uploadId: z.string().uuid(), acknowledged: z.literal(true) })
      .parse(req.body);
    if (manager.isBusy(String(req.params.id))) throw new ImportError('请先停止当前AI回复。', 409);
    res.json(
      manager.attachments.cancelUpload(String(req.params.id), input.uploadId, auth.actor(req)),
    );
  });
  router.get('/attachments/:id/text', (req, res) =>
    res.json(manager.attachments.textPreview(String(req.params.id), auth.actor(req))),
  );
  router.post('/attachments/:id/delete', (req, res) => {
    z.strictObject({ acknowledged: z.literal(true) }).parse(req.body);
    const file = manager.attachments.info(String(req.params.id), auth.actor(req));
    if (manager.isBusy(file.threadId))
      throw new ImportError('请先停止本会话AI回复，再删除附件。', 409);
    res.json(manager.attachments.remove(String(req.params.id), auth.actor(req)));
  });
  router.get('/threads/:id', (req, res) =>
    res.json(manager.view(String(req.params.id), auth.actor(req))),
  );
  router.post('/threads/:id/clear', (req, res) => {
    z.object({ acknowledged: z.literal(true) }).parse(req.body);
    res.json(manager.clear(String(req.params.id), auth.actor(req)));
  });
  router.post('/threads/:id/delete', (req, res) => {
    z.strictObject({ acknowledged: z.literal(true) }).parse(req.body);
    manager.removeThread(String(req.params.id), auth.actor(req));
    res.json({ deleted: true });
  });
  router.post('/threads/:id/cancel', (req, res) => {
    manager.cancel(String(req.params.id), auth.actor(req));
    res.json({ ok: true });
  });
  router.post('/threads/:id/chat', async (req, res, next) => {
    let done = false;
    const id = String(req.params.id);
    try {
      req.setTimeout(AI_HTTP_TIMEOUT_MS * 4);
      res.setTimeout(AI_HTTP_TIMEOUT_MS * 4);
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
      res.on('close', () => {
        if (!done && auth.actor(req)) {
          try {
            manager.cancel(id, auth.actor(req));
          } catch {
            /* 无效会话已由主请求安全拒绝。 */
          }
        }
      });
      const timer = setInterval(() => send('heartbeat', { at: Date.now() }), 10000);
      timer.unref();
      try {
        send(
          'result',
          await manager.chat(id, req.body, auth.actor(req), auth.sessionBinding(req), send, () =>
            auth.actor(req),
          ),
        );
      } catch (e) {
        send('error', {
          message:
            e instanceof ImportError
              ? e.message
              : '全局助手请求失败，请重新载入历史核实结果后再试。',
        });
      } finally {
        done = true;
        clearInterval(timer);
        res.end();
      }
    } catch (e) {
      done = true;
      next(e);
    }
  });
  router.post('/previews/:id/execute', (req, res) => {
    const actor = auth.actor(req)!,
      row = manager.store.db
        .prepare('SELECT document FROM assistant_previews WHERE id=? AND user_id=?')
        .get(String(req.params.id), actor.id);
    if (!row) throw new ImportError('方案不存在或无权访问。', 404);
    const { password, ...input } = req.body;
    if (JSON.parse(String(row.document)).plan.highRisk && !isDeveloperActor(auth.actor(req))) {
      auth.requireSuperMode(req);
      auth.verifyPassword(req, z.string().min(1).max(128).parse(password));
    }
    res.json(
      manager.execute(String(req.params.id), input, auth.actor(req), auth.sessionBinding(req)),
    );
  });
  return router;
}
