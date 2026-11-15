import type { IncomingMessage } from 'node:http';
import type { CookieOptions } from 'express';
import { proxyIngress, type Deployment } from './deployment.js';

/**
 * 登录 Cookie 的名字和属性跟入口走，登录写、退出清、每次请求读都按这里：
 * - 从域名（经 HTTPS 代理）进来：`__Host-` 前缀加 Secure，只有本域名的 HTTPS 页面能写，同域名的其它子站和明文回应都写不了；
 * - 本机入口和维护通道是 http，浏览器不一定收带 Secure 的 Cookie，用原名、不加 Secure。
 * 每个入口只认自己的名字。
 */
export function sessionCookie(req: IncomingMessage, deployment?: Deployment): { name: string; options: CookieOptions } {
  const secure = proxyIngress(req, deployment);
  return {
    name: secure ? '__Host-erp_session' : 'erp_session',
    options: { httpOnly: true, sameSite: 'strict', path: '/', ...(secure ? { secure: true } : {}) },
  };
}
