import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';

test('静态带哈希资源长缓存，HTML 重新验证，其余静态文件和 API 保持原策略', async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'erp-export-static-'));
  const dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>虚构测试</title>');
  for (const file of ['app-M4qP1_kz.js', 'app.js'])
    writeFileSync(join(dist, 'assets', file), '/* test */');
  writeFileSync(join(dist, 'manual-M4qP1_kz.js'), '/* test */');
  const store = new Store(':memory:');
  process.chdir(dir);
  const server = createServer(createApp(store));
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const get = (path: string, headers?: HeadersInit) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, { headers });
    for (const path of ['/', '/index.html', '/some/client/route']) {
      const html = await get(path);
      assert.equal(html.status, 200);
      assert.equal(html.headers.get('cache-control'), 'no-cache');
      const revalidated = await get(path, {
        'if-none-match': html.headers.get('etag')!,
        'cache-control': 'max-age=0',
      });
      assert.equal(revalidated.status, 304);
      assert.equal(revalidated.headers.get('cache-control'), 'no-cache');
    }
    const asset = await get('/assets/app-M4qP1_kz.js', { 'accept-encoding': 'gzip' });
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(asset.headers.get('content-encoding'), null);
    for (const path of ['/assets/app.js', '/manual-M4qP1_kz.js']) {
      const file = await get(path);
      assert.equal(file.headers.get('cache-control'), 'public, max-age=0');
    }
    for (const path of ['/api/health', '/api/missing']) {
      const api = await get(path);
      assert.doesNotMatch(api.headers.get('cache-control') ?? '', /immutable|31536000/);
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    process.chdir(cwd);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
