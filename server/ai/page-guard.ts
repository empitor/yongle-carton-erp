import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * AI 页面（AI 设置、提示词、识别导入工作区）的关卡：不缓存；拒绝跨站来的请求；写入要带这几页的页面凭证
 * （请求头 X-ERP-AI-Token）。page 是拒绝时说的页面叫法。登录和超级管理员模式由各自的路由另外查。
 */
export function aiPageGuard(token: string, page: string) {
  const expected = Buffer.from(token);
  return (req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return res.status(403).json({ message: page + '只允许从本机管理系统页面访问。', code: 'permission' });
    if (req.method !== 'GET') {
      const sent = req.headers['x-erp-ai-token'];
      if (typeof sent !== 'string' || !/^[a-f0-9]{64}$/.test(sent) || !timingSafeEqual(Buffer.from(sent), expected))
        return res.status(403).json({ message: '页面安全凭证无效，请刷新' + page + '后重试。', code: 'permission' });
    }
    next();
  };
}
