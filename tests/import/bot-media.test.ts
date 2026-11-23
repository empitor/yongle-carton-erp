import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from 'node:dns';
import { downloadMedia, fileNameFromDisposition, safeFileName } from '../../server/inbox/bots/media.js';
import { postJson } from '../../server/inbox/bots/http.js';
import { BotFailure } from '../../server/inbox/bots/protocol.js';
import { resolvePublicAddress } from '../../server/inbox/bots/public-address.js';
import { parsePublicDns } from '../../server/inbox/bots/public-dns.js';
import { INBOX_MAX_FILE } from '../../shared/import/inbox.js';
import { fakeHttpsRequest as transport } from './https-request-fake.js';

/** 系统解析的替身：只答“全部地址”的查询，给的就是 addresses */
function lookupOf(...addresses: string[]) {
  function lookup(hostname: string, family?: number): Promise<LookupAddress>;
  function lookup(hostname: string, options: LookupOneOptions): Promise<LookupAddress>;
  function lookup(hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>;
  function lookup(hostname: string, options: LookupOptions): Promise<LookupAddress | LookupAddress[]>;
  async function lookup(_hostname: string, options?: number | LookupOptions): Promise<LookupAddress | LookupAddress[]> {
    if (typeof options !== 'object' || !options.all) throw new Error('替身只答 all: true 的查询');
    return addresses.map((address) => ({ address, family: 4 }));
  }
  return lookup;
}

test('下载只连接第一次校验的公网 IP，保留 Host、SNI、路径和证书校验', async () => {
  let resolutions = 0;
  const fake = transport([]);
  const file = await downloadMedia('https://media.example.invalid/file?token=fictional', {
    checkHost: async () => ++resolutions === 1 ? '203.0.114.1' : '10.0.0.1', requestImpl: fake.request,
  });
  assert.equal(resolutions, 1, '不能在连接时再次解析域名');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].hostname, '203.0.114.1');
  assert.deepEqual(fake.calls[0].headers, { Host: 'media.example.invalid' });
  assert.equal(fake.calls[0].servername, 'media.example.invalid');
  assert.equal(fake.calls[0].rejectUnauthorized, true);
  assert.equal(fake.calls[0].agent, false);
  assert.equal(fake.calls[0].path, '/file?token=fictional');
  assert.equal(file.name, 'fictional.bin');
  assert.equal(file.data.toString(), '虚构文件');
});

test('每次跳转独立校验并固定新 IP，禁止跳转到内网或明文地址', async () => {
  const fake = transport([{ status: 302, location: 'https://next.example.invalid:8443/next' }, {}]);
  const hosts: string[] = [];
  await downloadMedia('https://first.example.invalid/start', {
    checkHost: async (host) => { hosts.push(host); return hosts.length === 1 ? '203.0.114.1' : '203.0.114.2'; }, requestImpl: fake.request,
  });
  assert.deepEqual(hosts, ['first.example.invalid', 'next.example.invalid']);
  assert.deepEqual(fake.calls.map((c) => c.hostname), ['203.0.114.1', '203.0.114.2']);
  assert.equal(fake.calls[1].servername, 'next.example.invalid');
  assert.deepEqual(fake.calls[1].headers, { Host: 'next.example.invalid:8443' });
  assert.equal(fake.calls[1].port, '8443');
  for (const location of ['http://next.example.invalid/file', 'https://127.0.0.1/file', 'https://[::1]/file', 'https://private.example.invalid/file']) {
    const blocked = transport([{ status: 302, location }]);
    await assert.rejects(downloadMedia('https://first.example.invalid/start', {
      checkHost: async (host) => host === 'private.example.invalid' ? '10.0.0.1' : '203.0.114.1', requestImpl: blocked.request,
    }), /不是 https|不是公网/);
    assert.equal(blocked.calls.length, 1);
  }
});

test('私网、保留地址和非 HTTPS 在连接前拒绝，公网 IP 字面值不再做 DNS', async () => {
  for (const url of ['http://public.example.invalid/f', 'https://10.0.0.1/f', 'https://192.168.0.1/f', 'https://203.0.113.1/f', 'https://private.example.invalid/f']) {
    const fake = transport([]);
    await assert.rejects(downloadMedia(url, { checkHost: async () => '10.0.0.1', requestImpl: fake.request }), /不是 https|不是公网/);
    assert.equal(fake.calls.length, 0);
  }
  const fake = transport([]);
  await downloadMedia('https://203.0.114.1/f', { checkHost: async () => assert.fail('IP 不应解析'), requestImpl: fake.request });
  assert.equal(fake.calls[0].hostname, '203.0.114.1');
  assert.equal(fake.calls[0].servername, undefined);
});

test('固定 IP 传输继续执行文件大小限制；TLS/连接错误、域名解析失败、坏的跳转地址都拒绝，说法是中文', async () => {
  const large = transport([{ length: String(INBOX_MAX_FILE + 33) }]);
  await assert.rejects(downloadMedia('https://media.example.invalid/f', { checkHost: async () => '203.0.114.1', requestImpl: large.request }));
  const { request } = transport([{ error: new Error('虚构证书校验失败') }]);
  const chinese = (message: string) => (e: unknown) => e instanceof BotFailure && e.message === message;
  await assert.rejects(downloadMedia('https://media.example.invalid/f', { checkHost: async () => '203.0.114.1', requestImpl: request }), chinese('下载失败，网络不通或超时'));
  await assert.rejects(
    downloadMedia('https://media.example.invalid/f', { checkHost: async () => { throw new Error('getaddrinfo ENOTFOUND media.example.invalid'); } }),
    chinese('下载地址的域名解析不了'),
  );
  const jump = transport([{ status: 302, location: 'https://[bad' }]);
  await assert.rejects(downloadMedia('https://media.example.invalid/f', { checkHost: async () => '203.0.114.1', requestImpl: jump.request }), chinese('下载地址跳转无效'));
  await assert.rejects(downloadMedia('not a url', { checkHost: async () => '203.0.114.1' }), chinese('下载地址不对'));
});

test('共用请求：不跟跳转（请求体里有 Secret，不往别处再发一遍）；连不上、超时都换成中文', async () => {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/start') res.writeHead(307, { Location: '/elsewhere' }).end();
    else res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地服务没有端口');
  const base = 'http://127.0.0.1:' + address.port;
  try {
    await assert.rejects(postJson(base + '/start', { secret: 'fictional-secret' }, {}), (e) => e instanceof BotFailure && e.message === '网络不通或对方没有回应');
    assert.deepEqual(hits, ['/start'], '没有跟着跳到别处再发一遍');
    assert.deepEqual(await postJson(base + '/ok', {}, {}), { status: 200, data: { ok: true } });
    const offline: typeof fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(postJson(base + '/ok', {}, { fetchImpl: offline }), (e) => e instanceof BotFailure && !/fetch failed/.test(e.message));
  } finally {
    server.close();
  }
});

test('文件名：解析响应头，去掉路径和控制字符，过长的截到 180 字以内', () => {
  assert.equal(
    fileNameFromDisposition(`attachment; filename*=UTF-8''%E8%99%9A%E6%9E%84.pdf`),
    '虚构.pdf',
  );
  assert.equal(fileNameFromDisposition('attachment; filename="a b.xlsx"'), 'a b.xlsx');
  assert.equal(fileNameFromDisposition(null), '');
  assert.equal(safeFileName('../../etc/passwd', 'x'), '_.._etc_passwd');
  assert.equal(safeFileName('   ', '备用名'), '备用名');
  // 不超过下游（附件校验）的 180 字，扩展名留着
  const long = safeFileName('虚'.repeat(300) + '.pdf', 'x');
  assert.ok(long.length <= 180 && long.endsWith('.pdf'));
});

test('带令牌的请求头只发给第一跳，跳到别的主机就不带；限额可以另给', async () => {
  const fake = transport([{ status: 302, location: 'https://cdn.example.invalid/f' }, {}]);
  await downloadMedia('https://api.example.invalid/f', { checkHost: async () => '203.0.114.1', requestImpl: fake.request }, {
    headers: { Authorization: 'Bearer fictional-token' },
  });
  assert.deepEqual(fake.calls[0].headers, { Authorization: 'Bearer fictional-token', Host: 'api.example.invalid' });
  assert.deepEqual(fake.calls[1].headers, { Host: 'cdn.example.invalid' });
  const small = transport([{ body: Buffer.from('12345') }]);
  await assert.rejects(
    downloadMedia('https://media.example.invalid/f', { checkHost: async () => '203.0.114.1', requestImpl: small.request }, { limit: 4 }),
  );
});

test('下载前解析域名：混着内网的整批拒绝；全是代理虚拟地址时改用公网 DNS 的结果再查', async () => {
  const noFallback = async () => assert.fail('不该查公网 DNS');
  assert.equal(await resolvePublicAddress('files.example.com', lookupOf('93.184.216.34', '93.184.216.35'), noFallback), '93.184.216.34');
  await assert.rejects(resolvePublicAddress('files.example.com', lookupOf('93.184.216.34', '10.0.0.8'), noFallback), /内网/);
  await assert.rejects(resolvePublicAddress('files.example.com', lookupOf(), noFallback), /内网/);
  // 代理（如 Clash）给的 198.18/15 虚拟地址：不直连，改用公网 DNS，结果照样逐个核对
  assert.equal(await resolvePublicAddress('files.example.com', lookupOf('198.18.0.7'), async () => ['93.184.216.34']), '93.184.216.34');
  await assert.rejects(resolvePublicAddress('files.example.com', lookupOf('198.18.0.7', '198.19.0.1'), async () => ['192.168.1.2']), /内网/);
});

test('公网 DNS 的回答：顺着 CNAME 链取 A 记录；问的不是这个域名、被截断、没有 A 记录都拒收', () => {
  const answer = (over: Record<string, unknown> = {}) => ({
    Status: 0,
    TC: false,
    Question: [{ name: 'files.example.com.', type: 1 }],
    Answer: [
      { name: 'files.example.com.', type: 5, data: 'cdn.example.net.' },
      { name: 'cdn.example.net.', type: 1, data: '93.184.216.34' },
      { name: 'other.example.org.', type: 1, data: '93.184.216.99' },
    ],
    ...over,
  });
  assert.deepEqual(parsePublicDns(answer(), 'files.example.com'), ['93.184.216.34'], '不相干的记录不算');
  assert.throws(() => parsePublicDns(answer({ Question: [{ name: 'evil.example.com.', type: 1 }] }), 'files.example.com'), /有效 IPv4/);
  assert.throws(() => parsePublicDns(answer({ TC: true }), 'files.example.com'), /有效 IPv4/);
  assert.throws(() => parsePublicDns(answer({ Status: 2 }), 'files.example.com'), /有效 IPv4/);
  assert.throws(() => parsePublicDns(answer({ Answer: [{ name: 'files.example.com.', type: 5, data: 'cdn.example.net.' }] }), 'files.example.com'), /没有返回可连接/);
});
