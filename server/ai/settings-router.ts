import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { AiSettingsManager } from './settings-manager.js';
import { AiConnectionError } from './connection-error.js';

export function aiSettingsRouter(manager: AiSettingsManager) {
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return res
        .status(403)
        .json({ error: { code: 'permission', message: 'AI 设置只允许从本机 ERP 页面访问。' } });
    if (req.method !== 'GET') {
      const token = req.headers['x-erp-ai-token'];
      if (
        typeof token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(token) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(manager.csrfToken))
      )
        return res.status(403).json({
          error: { code: 'permission', message: '页面安全凭证无效，请刷新 AI 设置后重试。' },
        });
    }
    next();
  });
  router.get('/', (_req, res) => res.json(manager.view()));
  router.post('/connect', async (req, res) => {
    try {
      res.json(await manager.connect(req.body));
    } catch (error) {
      sendError(error, res);
    }
  });
  for (const [path, handler] of [
    ['/preset', (body: unknown) => manager.saveDraft(body)],
    ['/activate', (body: unknown) => manager.activate(body)],
    ['/delete', (body: unknown) => manager.remove(body)],
    ['/preferences', (body: unknown) => manager.preferences(body)],
  ] as const)
    router.post(path, (req, res) => {
      try {
        res.json(handler(req.body));
      } catch (error) {
        sendError(error, res);
      }
    });
  router.post('/test', async (req, res) => {
    try {
      res.json(await manager.test(req.body));
    } catch (error) {
      sendError(error, res);
    }
  });
  router.post('/models', async (req, res) => {
    try {
      res.json(await manager.models(req.body));
    } catch (error) {
      sendError(error, res);
    }
  });
  router.post('/save', (req, res) => {
    try {
      res.json(manager.save(req.body));
    } catch (error) {
      sendError(error, res);
    }
  });
  router.post('/disable', (req, res) => {
    try {
      res.json(manager.disable(req.body));
    } catch (error) {
      sendError(error, res);
    }
  });
  return router;
}
function sendError(error: unknown, res: import('express').Response) {
  // 不透传 SDK/上游正文、堆栈或输入值，防止供应商回显 API Key。
  if (error instanceof AiConnectionError)
    return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  if (error instanceof ZodError)
    return res.status(400).json({
      error: {
        code: 'validation',
        message: '请检查服务商、地址、模型、密钥长度及设置版本；提交格式不符合要求。',
      },
    });
  return res.status(500).json({
    error: { code: 'upstream', message: 'AI 设置操作失败，请刷新后重试；密钥不会写入运行日志。' },
  });
}
