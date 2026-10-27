import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { PromptPresetManager } from './prompt-presets.js';
export function promptSettingsRouter(manager: PromptPresetManager, csrfToken: string) {
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return res.status(403).json({ message: '提示词设置仅允许从本机管理系统访问。' });
    if (req.method !== 'GET') {
      const token = req.headers['x-erp-ai-token'];
      if (
        typeof token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(token) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken))
      )
        return res.status(403).json({ message: '页面安全凭证无效，请刷新。' });
    }
    next();
  });
  const view = () => ({ ...manager.view(), csrfToken });
  router.get('/', (_req, res) => res.json(view()));
  for (const action of ['save', 'copy', 'activate', 'delete', 'restore'] as const)
    router.post('/' + action, (req, res) => {
      manager.change(action, req.body);
      res.json(view());
    });
  return router;
}
