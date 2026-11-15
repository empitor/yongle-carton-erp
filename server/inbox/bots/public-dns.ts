import https from 'node:https';
import { z } from 'zod';
import { BotFailure, HTTPS_PORT } from './protocol.js';

/** 公网 DNS 的回答最多收多少字节、等多久 */
const DNS_MAX_BYTES = 32_768;
const DNS_TIMEOUT_MS = 12_000;
/** 别名（CNAME）最多顺着找几层 */
const MAX_CNAME_HOPS = 16;
/** DNS 记录类型：A（IPv4 地址）、CNAME（别名） */
const TYPE_A = 1;
const TYPE_CNAME = 5;

/** 公网 DNS 兜底出的错：原因写在 message 里，调用方原样报出来。 */
export class DnsError extends BotFailure {}
// 只查询域名的 A 记录，不接收 URL、密钥、业务内容或用户指定的 DNS 服务地址。
export async function publicDns(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '1.1.1.1',
        port: HTTPS_PORT,
        servername: 'cloudflare-dns.com',
        path: '/dns-query?name=' + encodeURIComponent(hostname) + '&type=A',
        method: 'GET',
        agent: false,
        headers: { Host: 'cloudflare-dns.com', Accept: 'application/dns-json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > DNS_MAX_BYTES)
            req.destroy(new DnsError('公网 DNS 返回内容过大。'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw new Error();
            resolve(parsePublicDns(JSON.parse(Buffer.concat(chunks).toString('utf8')), hostname));
          } catch (error) {
            reject(
              error instanceof DnsError
                ? error
                : new DnsError('代理虚拟地址需要真实公网解析，但固定安全 DNS 暂不可用，请检查本机网络后重试。'),
            );
          }
        });
      },
    );
    const timer = setTimeout(
      () =>
        req.destroy(new DnsError('公网 DNS 查询超时，请检查本机代理网络。')),
      DNS_TIMEOUT_MS,
    );
    // 返回过大、超时是自己带着原因断开的（destroy 会触发 error），原因要原样报出来
    req.on('error', (error) =>
      reject(
        error instanceof DnsError
          ? error
          : new DnsError('检测到代理虚拟地址，但公网 DNS 查询失败。请检查本机代理连接或稍后重试。'),
      ),
    );
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}
/** 公网 DNS（DoH 的 JSON）的回答：外来数据，用 zod 认；只问了一个域名的 A 记录，回答要对得上 */
const dnsRecord = z.object({ name: z.unknown().optional(), type: z.unknown().optional(), data: z.unknown().optional() });
const dnsReply = z.object({
  Status: z.literal(0),
  TC: z.unknown().optional(),
  Question: z.tuple([z.object({ name: z.unknown().optional(), type: z.literal(TYPE_A) })]),
  Answer: z.array(dnsRecord),
});
type DnsRecord = z.infer<typeof dnsRecord>;
const normalize = (name: unknown) => (typeof name === 'string' ? name.toLowerCase().replace(/\.$/, '') : '');

/** 顺着别名记录找出这个域名的全部名字（自己和一层层的别名） */
function aliasesOf(hostname: string, answers: DnsRecord[]) {
  const names = new Set([hostname]);
  for (let i = 0; i < MAX_CNAME_HOPS; i++) {
    let changed = false;
    for (const a of answers) {
      if (a.type === TYPE_CNAME && names.has(normalize(a.name)) && !names.has(normalize(a.data))) {
        names.add(normalize(a.data));
        changed = true;
      }
    }
    if (!changed) break;
  }
  return names;
}

export function parsePublicDns(raw: unknown, hostname: string): string[] {
  const reply = dnsReply.safeParse(raw);
  if (!reply.success || reply.data.TC === true || normalize(reply.data.Question[0].name) !== hostname.toLowerCase())
    throw new DnsError('公网 DNS 未返回当前 API 域名的有效 IPv4 记录。');
  const answers = reply.data.Answer,
    names = aliasesOf(hostname.toLowerCase(), answers);
  const addresses = answers.flatMap((a) =>
    a.type === TYPE_A && names.has(normalize(a.name)) && typeof a.data === 'string' ? [a.data] : [],
  );
  if (!addresses.length)
    throw new DnsError('公网 DNS 没有返回可连接的 IPv4 地址。');
  return addresses;
}
