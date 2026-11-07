import assert from 'node:assert/strict';
import { test } from 'node:test';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { downloadMedia, WECOM_MAX_FILE } from '../server/inbox/wecom-bot.js';

function transport(replies: { status?: number; location?: string; body?: Buffer; length?: string }[]) {
  const calls: https.RequestOptions[] = [];
  const request = ((options: https.RequestOptions, done: (res: IncomingMessage) => void) => {
    calls.push(options);
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const reply = replies.shift() || {};
      const res = Readable.from([reply.body || Buffer.from('虚构文件')]) as IncomingMessage;
      res.statusCode = reply.status || 200;
      res.headers = { ...(reply.location ? { location: reply.location } : {}),
        ...(reply.length ? { 'content-length': reply.length } : {}), 'content-disposition': 'attachment; filename="fictional.bin"' };
      done(res);
    };
    return req;
  }) as unknown as typeof https.request;
  return { calls, request };
}

test('企微下载只连接第一次校验的公网 IP，保留 Host、SNI、路径和证书校验', async () => {
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

test('固定 IP 传输继续执行文件大小限制，TLS/连接错误原样拒绝', async () => {
  const large = transport([{ length: String(WECOM_MAX_FILE + 33) }]);
  await assert.rejects(downloadMedia('https://media.example.invalid/f', { checkHost: async () => '203.0.114.1', requestImpl: large.request }));
  const error = new Error('虚构证书校验失败');
  const request = (() => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => { req.emit('error', error); };
    return req;
  }) as unknown as typeof https.request;
  await assert.rejects(downloadMedia('https://media.example.invalid/f', { checkHost: async () => '203.0.114.1', requestImpl: request }), (e) => e === error);
});
