// 公网 DNS 兜底（server/inbox/bots/public-dns.ts 的 publicDns）：只问固定的 1.1.1.1、只问 A 记录；
// 不通、超时、回答过大、回答不对都报中文原因。https.request 换成本地替身（tests/https-request-fake.ts），不连网。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { DnsError, publicDns } from '../../server/inbox/bots/public-dns.js';
import { fakeHttpsRequest, type FakeReply } from './https-request-fake.js';

const HOST = 'files.example.com';
const answer = (address: string) =>
  Buffer.from(
    JSON.stringify({
      Status: 0,
      TC: false,
      Question: [{ name: HOST + '.', type: 1 }],
      Answer: [{ name: HOST + '.', type: 1, data: address }],
    }),
  );
/** 这次测试里 https.request 换成替身，按 replies 回答 */
function serveDns(t: TestContext, replies: FakeReply[]) {
  const fake = fakeHttpsRequest(replies);
  t.mock.method(https, 'request', fake.request);
  return fake;
}
/** 报的是带这句原因的 DnsError */
const dnsFailure = (reason: RegExp) => (e: unknown) => e instanceof DnsError && reason.test(e.message);

test('只连 1.1.1.1 问 cloudflare-dns.com，域名编码进地址、只问 A 记录，回答里的地址原样交回', async (t) => {
  const fake = serveDns(t, [{ body: answer('93.184.216.34') }]);
  assert.deepEqual(await publicDns(HOST), ['93.184.216.34']);
  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.equal(call.hostname, '1.1.1.1');
  assert.equal(call.servername, 'cloudflare-dns.com');
  assert.equal(call.path, '/dns-query?name=files.example.com&type=A');
  assert.deepEqual(call.headers, { Host: 'cloudflare-dns.com', Accept: 'application/dns-json' });
  assert.equal(call.agent, false);
});

test('回答不是 200、不是 JSON：报“固定安全 DNS 暂不可用”；回答对不上这个域名的：报解析那一步的原因', async (t) => {
  serveDns(t, [{ status: 503 }, { body: Buffer.from('不是 JSON') }, { body: Buffer.from('{"Status":0,"Question":[],"Answer":[]}') }]);
  await assert.rejects(publicDns(HOST), dnsFailure(/固定安全 DNS 暂不可用/));
  await assert.rejects(publicDns(HOST), dnsFailure(/固定安全 DNS 暂不可用/));
  await assert.rejects(publicDns(HOST), dnsFailure(/有效 IPv4/));
});

test('回答超过 32KB 就断开，报“返回内容过大”', async (t) => {
  serveDns(t, [{ body: Buffer.alloc(32_769, 0x20), lateEnd: true }]);
  await assert.rejects(publicDns(HOST), dnsFailure(/返回内容过大/));
});

test('连不上报“公网 DNS 查询失败”，不带英文原文', async (t) => {
  serveDns(t, [{ error: new Error('connect ECONNREFUSED 1.1.1.1:443') }]);
  await assert.rejects(publicDns(HOST), (e: unknown) => dnsFailure(/公网 DNS 查询失败/)(e) && e instanceof Error && !/ECONNREFUSED/.test(e.message));
});

test('12 秒没回答就断开，报“查询超时”（假计时器，不真等）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  serveDns(t, [{ hang: true }]);
  const pending = publicDns(HOST);
  t.mock.timers.tick(11_999);
  t.mock.timers.tick(1);
  await assert.rejects(pending, dnsFailure(/查询超时/));
});
