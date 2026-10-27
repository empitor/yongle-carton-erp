import https from 'node:https';
import { AiConnectionError } from './connection-error.js';

// 只查询域名的 A 记录，不接收 URL、密钥、业务内容或用户指定的 DNS 服务地址。
export async function publicDns(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '1.1.1.1',
        port: 443,
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
          if (bytes > 32768)
            req.destroy(new AiConnectionError('dns', '公网 DNS 返回内容过大。', 502));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw new Error();
            resolve(parsePublicDns(JSON.parse(Buffer.concat(chunks).toString('utf8')), hostname));
          } catch (error) {
            reject(
              error instanceof AiConnectionError
                ? error
                : new AiConnectionError(
                    'dns',
                    '代理虚拟地址需要真实公网解析，但固定安全 DNS 暂不可用，请检查本机网络后重试。',
                    502,
                  ),
            );
          }
        });
      },
    );
    const timer = setTimeout(
      () =>
        req.destroy(new AiConnectionError('dns', '公网 DNS 查询超时，请检查本机代理网络。', 502)),
      12000,
    );
    req.on('error', () =>
      reject(
        new AiConnectionError(
          'dns',
          '检测到代理虚拟地址，但公网 DNS 查询失败。请检查本机代理连接或稍后重试。',
          502,
        ),
      ),
    );
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}
export function parsePublicDns(raw: unknown, hostname: string): string[] {
  const b = raw as any;
  const normalize = (name: unknown) =>
    typeof name === 'string' ? name.toLowerCase().replace(/\.$/, '') : '';
  if (
    b?.Status !== 0 ||
    b?.TC === true ||
    !Array.isArray(b?.Question) ||
    b.Question.length !== 1 ||
    normalize(b.Question[0].name) !== hostname.toLowerCase() ||
    b.Question[0].type !== 1 ||
    !Array.isArray(b.Answer)
  )
    throw new AiConnectionError('dns', '公网 DNS 未返回当前 API 域名的有效 IPv4 记录。', 502);
  const names = new Set([hostname.toLowerCase()]);
  for (let i = 0; i < 16; i++) {
    let changed = false;
    for (const a of b.Answer) {
      if (a.type === 5 && names.has(normalize(a.name)) && !names.has(normalize(a.data))) {
        names.add(normalize(a.data));
        changed = true;
      }
    }
    if (!changed) break;
  }
  const addresses = b.Answer.filter(
    (a: any) => a.type === 1 && names.has(normalize(a.name)) && typeof a.data === 'string',
  ).map((a: any) => a.data as string);
  if (!addresses.length)
    throw new AiConnectionError('dns', '公网 DNS 没有返回可连接的 IPv4 地址。', 502);
  return addresses;
}
