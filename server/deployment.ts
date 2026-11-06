import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import type { Request } from 'express';

export type Deployment = {
  proxyPort: number;
  hosts: ReadonlySet<string>;
  origins: ReadonlySet<string>;
  backupCopyDir?: string;
  backupCopyKeep?: number;
};

const list = (value?: string) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const publicHost =
  /^(?!localhost(?::|$))(?!127\.)(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?(?::[1-9]\d{0,4})?$/;

export function readDeployment(
  env = process.env,
  localPort = Number(env.PORT || 3001),
): Deployment | undefined {
  if (!env.ERP_DEPLOYMENT || env.ERP_DEPLOYMENT === '0') return;
  if (env.ERP_DEPLOYMENT !== '1') throw new Error('ERP_DEPLOYMENT 只接受 0 或 1。');
  const proxyPort = Number(env.ERP_PROXY_PORT || 3002);
  if (
    ![localPort, proxyPort].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535) ||
    proxyPort === localPort
  )
    throw new Error('ERP_PROXY_PORT 必须是与 PORT 不同的有效端口。');
  const hosts = new Set(list(env.ERP_ALLOWED_HOSTS).map((h) => h.toLowerCase()));
  if (
    !hosts.size ||
    [...hosts].some((host) => !publicHost.test(host) || Number(host.split(':')[1] || 443) > 65535)
  )
    throw new Error('ERP_ALLOWED_HOSTS 必须填写有效的公网域名，可带端口。');
  const configuredOrigins = list(env.ERP_ALLOWED_ORIGINS);
  const origins = new Set(
    configuredOrigins.length ? configuredOrigins : [...hosts].map((host) => 'https://' + host),
  );
  for (const origin of origins) {
    const url = URL.parse(origin);
    if (!url || url.protocol !== 'https:' || url.origin !== origin || !hosts.has(url.host))
      throw new Error('ERP_ALLOWED_ORIGINS 必须是允许域名的 HTTPS 来源。');
  }
  const backupCopyDir = env.ERP_BACKUP_COPY_DIR?.trim() || undefined;
  if (backupCopyDir && !isAbsolute(backupCopyDir))
    throw new Error('ERP_BACKUP_COPY_DIR 必须使用绝对路径。');
  const backupCopyKeep = env.ERP_BACKUP_COPY_KEEP ? Number(env.ERP_BACKUP_COPY_KEEP) : undefined;
  if (
    backupCopyKeep !== undefined &&
    (!backupCopyDir || !Number.isSafeInteger(backupCopyKeep) || backupCopyKeep < 1)
  )
    throw new Error('ERP_BACKUP_COPY_KEEP 必须是正整数，且需要配置备份复制目录。');
  return { proxyPort, hosts, origins, backupCopyDir, backupCopyKeep };
}

export const proxyIngress = (req: Request, deployment?: Deployment) =>
  !!deployment && req.socket.localPort === deployment.proxyPort;

export function forwardedClient(req: Request) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) return;
  const ip = req.headers['x-erp-client-ip'];
  if (typeof ip !== 'string' || !isIP(ip) || ip.includes('%')) return;
  // 统一 IPv6 表示，IPv4 映射地址与原 IPv4 共用限流桶。
  if (isIP(ip) === 4) return ip;
  const normalized = new URL('http://[' + ip + ']').hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const hi = parseInt(mapped[1], 16),
    lo = parseInt(mapped[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

export function hasProxyHeaders(req: Request) {
  return Object.keys(req.headers).some(
    (name) => name === 'forwarded' || name === 'x-erp-client-ip' || name.startsWith('x-forwarded-'),
  );
}
