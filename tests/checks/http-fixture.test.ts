import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { test } from 'node:test';
import { listen } from '../support/http-fixture.js';

test('测试 HTTP 服务读完响应后保留连接直到夹具关闭', async () => {
  const sockets: Socket[] = [];
  const h = await listen((req, res) => {
    sockets.push(req.socket);
    res.end('ok');
  });
  try {
    const response = await fetch(h.origin, { method: 'POST' });
    assert.equal(await response.text(), 'ok');
    assert.equal(response.headers.get('connection'), 'keep-alive');
    const [socket] = sockets;
    assert.ok(socket);
    assert.ok(!socket.timeout, '响应结束后没有空闲计时器');
  } finally {
    await h.close();
  }
  assert.ok(sockets.every((socket) => socket.destroyed));
});
