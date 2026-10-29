// Vite与后台使用同一生命周期；只管理本进程创建的后台，正常停止不使用Windows强杀。
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { checkHealth } from './start-system.mjs';
import { requestRuntimeStop } from './runtime-control.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const database = resolve(process.env.DB_PATH || 'data/erp.sqlite');
const port = process.env.PORT || '3001';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  throw new Error('PORT 必须是1至65535。');
const url = `http://127.0.0.1:${Number(port)}`;
let backend,
  web,
  closing = false,
  reloading = false,
  timer,
  shutdownPromise;
const watchers = [];
function startApi() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  const item = {
    child,
    done: new Promise((done) => {
      child.once('exit', (code) => done(code));
      child.once('error', () => done(1));
    }),
  };
  child.on('message', (message) => {
    if (message?.type === 'erp-shutdown' && !reloading) void shutdown(0, true);
  });
  void item.done.then((code) => {
    if (!closing && !reloading) void shutdown(code || 0);
  });
  return item;
}
async function ready(item) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (item.child.exitCode !== null) throw new Error('开发后台在就绪前退出。');
    if (await checkHealth(url, database + '.running', 300)) return;
    await delay(200);
  }
  throw new Error('开发后台启动超时。');
}
async function stopApi() {
  if (!backend || backend.child.exitCode !== null) return;
  // 退出通知可能先到达；仍让同一个后台通过控制通道完成资源关闭。
  try {
    await requestRuntimeStop(database, backend.child.pid);
  } catch (error) {
    const exited = await Promise.race([
      backend.done.then(() => true),
      delay(1500).then(() => false),
    ]);
    if (!exited) throw error;
  }
  await backend.done;
}
function shutdown(code, apiStopping = false) {
  return (shutdownPromise ||= (async () => {
    closing = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    try {
      if (apiStopping && backend) await backend.done;
      else await stopApi();
      await web?.close();
      process.exitCode = code;
      console.log('开发服务已关闭，前后端端口均已释放。');
    } catch (error) {
      await web?.close().catch(() => {});
      console.error('开发服务关闭失败：' + error.message);
      process.exitCode = 1;
    }
  })());
}
async function reload() {
  if (closing || reloading) return;
  reloading = true;
  try {
    await stopApi();
    if (closing) return;
    backend = startApi();
    await ready(backend);
    console.log('后台源码已更新，开发接口已重新就绪。');
  } catch (error) {
    console.error(error.message);
    void shutdown(1);
  } finally {
    reloading = false;
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void shutdown(0);
  });
try {
  // 先验证端口，不能连接或关闭当前目录以外的已有实例。
  if (await checkHealth(url, database + '.running'))
    throw new Error('此数据库服务已在运行，请先停止再进入开发模式。');
  web = await createServer({ root, server: { host: '127.0.0.1' } });
  await web.listen();
  backend = startApi();
  await ready(backend);
  web.printUrls();
  for (const directory of ['server', 'shared', 'scripts'])
    watchers.push(
      watch(resolve(root, directory), { recursive: true }, (_event, name) => {
        if (!name || !/\.(ts|mjs)$/.test(name)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          void reload();
        }, 250);
      }),
    );
} catch (error) {
  console.error('开发服务启动失败：' + error.message);
  await shutdown(1);
}
