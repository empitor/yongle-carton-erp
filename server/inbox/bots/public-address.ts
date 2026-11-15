import { isIP, BlockList } from 'node:net';
import { lookup } from 'node:dns/promises';
import { publicDns } from './public-dns.js';
import { BotFailure } from './protocol.js';

/** 机器人收文件的下载地址（企业微信、钉钉下发，飞书固定）：只连公网 IPv4，连接时固定用这里核过的地址，防 DNS 重绑定。 */
const reservedIPv4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
const blocked = new BlockList();
for (const cidr of reservedIPv4) {
  const [address, prefix] = cidr.split('/');
  blocked.addSubnet(address, Number(prefix), 'ipv4');
}
/** isIP 认出 IPv4 时给的数 */
const IPV4 = 4;
export function isPublicIPv4(address: string) {
  return isIP(address) === IPV4 && !blocked.check(address, 'ipv4');
}

export async function resolvePublicAddress(
  hostname: string,
  resolver = lookup,
  fallback: (hostname: string) => Promise<string[]> = publicDns,
): Promise<string> {
  let addresses = await resolver(hostname, { all: true, family: IPV4 });
  // Clash 等代理可能返回 198.18/15 虚拟地址：不直连该保留地址，而是独立查询
  // 真正公网 A 记录，随后仍检查每个地址并固定 TLS 连接 IP。
  if (addresses.length && addresses.every((a) => /^198\.(18|19)\./.test(a.address))) {
    addresses = (await fallback(hostname)).map((address) => ({ address, family: IPV4 }));
  }
  // 拒绝混合公网/内网解析，且传输层固定使用这一批验证过的 IP，避免 DNS 重绑定。
  if (!addresses.length || addresses.some((a) => !isPublicIPv4(a.address)))
    throw new BotFailure('域名解析到内网、保留地址或不支持的地址，已阻止下载。');
  return addresses[0].address;
}
