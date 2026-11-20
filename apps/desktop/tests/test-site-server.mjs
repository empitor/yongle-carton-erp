// 测试用的虚构网页服务：test-site/ 下的静态文件，加一个带 Content-Disposition 的下载地址；记下每个请求的主机和路径。
// 端到端测试里引用；也能单独跑起来手动看：node tests/test-site-server.mjs（http://127.0.0.1:8788/）
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SITE_PORT = 8788;
const root = fileURLToPath(new URL('../test-site/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function sendDownload(res, run) {
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="yongle-shell-http-${run}.bin"`,
    'Cache-Control': 'no-store',
  });
  res.end('YONGLE-SHELL-HTTP-TEST\n');
}

async function sendFile(res, pathname) {
  const file = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  const body = await readFile(file).catch(() => null);
  if (!body) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** 起服务；返回请求记录和关服务的函数 */
export async function startSite(port = SITE_PORT) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://site');
    requests.push({ host: req.headers.host ?? '', path: url.pathname });
    if (url.pathname === '/download') sendDownload(res, (url.searchParams.get('run') ?? 'manual').replace(/\W/g, ''));
    else void sendFile(res, url.pathname);
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', done);
  });
  const close = () =>
    new Promise((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  return { requests, close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await startSite();
  console.log(`测试页：http://127.0.0.1:${SITE_PORT}/（Ctrl+C 结束）`);
}
