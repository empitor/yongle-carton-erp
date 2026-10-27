import { isIP, BlockList } from 'node:net';
import { lookup } from 'node:dns/promises';
import { aiProviders, type AiProfile } from '../../shared/ai-settings.js';
import { AiConnectionError } from './connection-error.js';
import { publicDns } from './public-dns.js';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
export function isPublicIPv4(address: string) {
  return isIP(address) === 4 && !blocked.check(address, 'ipv4');
}

export function normalizeProfile(profile: AiProfile): AiProfile {
  let url: URL;
  try {
    url = new URL(profile.endpoint);
  } catch {
    throw new AiConnectionError('endpoint', 'API 地址格式错误，请填写完整地址。');
  }
  if (url.username || url.password || url.search || url.hash || /[%\\]/.test(profile.endpoint))
    throw new AiConnectionError(
      'endpoint',
      'API 地址不能包含账号、密码、查询参数、片段或编码路径。密钥请填写在专用密码框。',
    );
  let endpoint = url.origin + url.pathname.replace(/\/+$/, '');
  if (profile.provider === 'compatible') {
    for (const [suffix, apiStyle] of [
      ['/chat/completions', 'chat-completions'],
      ['/responses', 'responses'],
    ] as const) {
      if (endpoint.endsWith(suffix)) {
        endpoint = endpoint.slice(0, -suffix.length);
        profile = { ...profile, apiStyle };
        break;
      }
    }
  }
  const preset = aiProviders.find((p) => p.id === profile.provider)!;
  if (profile.provider === 'ollama') {
    if (!['http://127.0.0.1:11434', 'http://localhost:11434'].includes(endpoint))
      throw new AiConnectionError(
        'endpoint',
        'Ollama 目前仅允许本机 http://127.0.0.1:11434，不能连接其他内网地址。',
      );
    return { ...profile, endpoint: 'http://127.0.0.1:11434' };
  }
  if (profile.provider !== 'compatible') {
    if (endpoint !== preset.endpoint)
      throw new AiConnectionError(
        'endpoint',
        '此服务商仅使用官方 API 地址；第三方代理请选择“自定义兼容 API”。',
      );
  } else if (
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname) ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname) ||
    !/^\/(?:[a-zA-Z0-9._~-]+\/?)*$/.test(url.pathname)
  ) {
    throw new AiConnectionError(
      'endpoint',
      '兼容服务仅允许 HTTPS 公网域名、443 端口和普通路径；不支持 IP 地址、内网或 URL 参数。请填写 API 根地址，例如 https://服务商域名/v1。',
    );
  }
  if (profile.provider === 'gemini' && !/^(?:models\/)?[a-zA-Z0-9._-]+$/.test(profile.model))
    throw new AiConnectionError('validation', 'Gemini 请填写模型 ID，例如 gemini-2.5-flash。');
  return { ...profile, endpoint };
}

export async function resolvePublicAddress(
  hostname: string,
  resolver = lookup,
  fallback: (hostname: string) => Promise<string[]> = publicDns,
): Promise<string> {
  let addresses = await resolver(hostname, { all: true, family: 4 });
  // Clash 等代理可能返回 198.18/15 虚拟地址：不直连该保留地址，而是独立查询
  // 真正公网 A 记录，随后仍检查每个地址并固定 TLS 连接 IP。
  if (addresses.length && addresses.every((a) => /^198\.(18|19)\./.test(a.address))) {
    addresses = (await fallback(hostname)).map((address) => ({ address, family: 4 }));
  }
  // 拒绝混合公网/内网解析，且传输层固定使用这一批验证过的 IP，避免 DNS 重绑定。
  if (!addresses.length || addresses.some((a) => !isPublicIPv4(a.address)))
    throw new AiConnectionError(
      'endpoint',
      '服务域名解析到内网、保留地址或不支持的地址，已阻止请求。当前远程连接需要公网 IPv4。',
    );
  return addresses[0].address;
}
