import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import type { IncomingMessage } from 'node:http';

export type Deployment = {
  proxyPort: number;
  hosts: ReadonlySet<string>;
  origins: ReadonlySet<string>;
  backupCopyDir?: string;
  backupCopyKeep?: number;
};

/** 没设 ERP_PROXY_PORT 时给 Caddy 的代理入口端口；域名不带端口时按 HTTPS 的 443 算 */
const DEFAULT_PROXY_PORT = 3002,
  HTTPS_PORT = 443,
  PORT_MAX = 65535;
/** isIP 的返回值；IPv6 一共 8 组，访客网段取前 4 组（/64）；IPv4 映射地址的两组各拆成两个字节 */
const IP_VERSION = { v4: 4, v6: 6 },
  IPV6_GROUPS = 8,
  NETWORK_GROUPS = 4,
  BYTE = { bits: 8, mask: 0xff };

const list = (value?: string) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const publicHost =
  /^(?!localhost(?::|$))(?!127\.)(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?(?::[1-9]\d{0,4})?$/;
const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= PORT_MAX;

/** 部署模式的配置（环境变量）：ERP_DEPLOYMENT 不是 1 就是本机模式，返回 undefined；有不合规的值说清是哪一项、拒绝启动 */
export function readDeployment(env: NodeJS.ProcessEnv, localPort: number): Deployment | undefined {
  if (!env.ERP_DEPLOYMENT || env.ERP_DEPLOYMENT === '0') return;
  if (env.ERP_DEPLOYMENT !== '1') throw new Error('ERP_DEPLOYMENT 只接受 0 或 1。');
  const proxyPort = Number(env.ERP_PROXY_PORT || DEFAULT_PROXY_PORT);
  if (![localPort, proxyPort].every(validPort) || proxyPort === localPort)
    throw new Error('ERP_PROXY_PORT 必须是与 PORT 不同的有效端口。');
  const hosts = allowedHosts(env);
  return { proxyPort, hosts, origins: allowedOrigins(env, hosts), ...backupCopy(env) };
}

function allowedHosts(env: NodeJS.ProcessEnv) {
  const hosts = new Set(list(env.ERP_ALLOWED_HOSTS).map((h) => h.toLowerCase()));
  if (
    !hosts.size ||
    [...hosts].some((host) => !publicHost.test(host) || Number(host.split(':')[1] || HTTPS_PORT) > PORT_MAX)
  )
    throw new Error('ERP_ALLOWED_HOSTS 必须填写有效的公网域名，可带端口。');
  return hosts;
}

function allowedOrigins(env: NodeJS.ProcessEnv, hosts: ReadonlySet<string>) {
  const configuredOrigins = list(env.ERP_ALLOWED_ORIGINS);
  const origins = new Set(
    configuredOrigins.length ? configuredOrigins : [...hosts].map((host) => 'https://' + host),
  );
  for (const origin of origins) {
    const url = URL.parse(origin);
    if (!url || url.protocol !== 'https:' || url.origin !== origin || !hosts.has(url.host))
      throw new Error('ERP_ALLOWED_ORIGINS 必须是允许域名的 HTTPS 来源。');
  }
  return origins;
}

/** 备份另存一份的目录和保留份数 */
function backupCopy(env: NodeJS.ProcessEnv) {
  const backupCopyDir = env.ERP_BACKUP_COPY_DIR?.trim() || undefined;
  if (backupCopyDir && !isAbsolute(backupCopyDir))
    throw new Error('ERP_BACKUP_COPY_DIR 必须使用绝对路径。');
  const backupCopyKeep = env.ERP_BACKUP_COPY_KEEP ? Number(env.ERP_BACKUP_COPY_KEEP) : undefined;
  if (
    backupCopyKeep !== undefined &&
    (!backupCopyDir || !Number.isSafeInteger(backupCopyKeep) || backupCopyKeep < 1)
  )
    throw new Error('ERP_BACKUP_COPY_KEEP 必须是正整数，且需要配置备份复制目录。');
  return { backupCopyDir, backupCopyKeep };
}

export const proxyIngress = (req: IncomingMessage, deployment?: Deployment) =>
  !!deployment && req.socket.localPort === deployment.proxyPort;

export function forwardedClient(req: IncomingMessage) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) return;
  const ip = req.headers['x-erp-client-ip'];
  if (typeof ip !== 'string' || !isIP(ip) || ip.includes('%')) return;
  // 统一 IPv6 表示，IPv4 映射地址与原 IPv4 共用限流桶。
  if (isIP(ip) === IP_VERSION.v4) return ip;
  const normalized = new URL('http://[' + ip + ']').hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const hi = parseInt(mapped[1], 16),
    lo = parseInt(mapped[2], 16);
  return [hi >> BYTE.bits, hi & BYTE.mask, lo >> BYTE.bits, lo & BYTE.mask].join('.');
}

/**
 * 限频和申请记录按访客网段算：IPv4 就是地址本身；IPv6 取前 64 位（写成 2001:db8:1:2::/64），
 * 一条宽带至少分到一个 /64，按单个地址算的话换个地址就绕过了。
 */
export function clientNetwork(ip: string) {
  if (isIP(ip) !== IP_VERSION.v6) return ip;
  const [head, tail] = new URL('http://[' + ip + ']').hostname.slice(1, -1).split('::');
  const left = head ? head.split(':') : [],
    right = tail ? tail.split(':') : [];
  const zeros = Array.from({ length: IPV6_GROUPS - left.length - right.length }, () => '0');
  const groups = tail === undefined ? left : [...left, ...zeros, ...right];
  return groups.slice(0, NETWORK_GROUPS).join(':') + '::/64';
}

export function hasProxyHeaders(req: IncomingMessage) {
  return Object.keys(req.headers).some(
    (name) => name === 'forwarded' || name === 'x-erp-client-ip' || name.startsWith('x-forwarded-'),
  );
}
