// 人工看界面用的预览实例：和 npm run test:ui 同一套隔离实例（临时目录、虚构数据、模型替身），
// 构建到临时目录并监听源码变化自动重建，刷新页面就能看到改动。不碰真实数据和项目的 dist。
// 用法：
//   node scripts/ui-check/preview.mjs            本机管理员模式，http://127.0.0.1:3199
//   node scripts/ui-check/preview.mjs --remote   模拟从域名访问（关掉本机管理员），http://127.0.0.1:3198
//   --port 端口  换端口
//   node scripts/ui-check/preview.mjs --real-model   真实模型模式，http://127.0.0.1:3197：不装模型替身，会调用 DeepSeek、产生费用；
//                                                     密钥在设置页填，加密存在测试专用的固定目录里（和正式实例的配置目录分开，脚本自己拼路径），以后接着用
//   再加 --fake-deepseek  只给冒烟脚本自测：真实模型模式的接线，但连假 DeepSeek、配置目录用临时目录，不碰固定目录
// 账号见 server.mts 里的 add(...)，都是虚构的。只改了服务端代码时要重启预览。
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const here = fileURLToPath(new URL('./', import.meta.url));
const remote = process.argv.includes('--remote');
const realModel = process.argv.includes('--real-model');
const fakeDeepSeek = realModel && process.argv.includes('--fake-deepseek');
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? process.argv[portArg + 1] : realModel ? '3197' : remote ? '3198' : '3199';
const dir = mkdtempSync(join(tmpdir(), 'erp-ui-preview-'));
// 真实模型模式的配置目录：固定、在项目外，和正式实例的配置目录是并排的两个目录、不在它里面。路径在这里拼，命令行里不出现；
// 里面只有加密后的 DeepSeek 密钥，任何脚本和子智能体都不读、不打印、不复制这个目录里的文件。
const realConfig = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'erp-real-model-test', 'config');
if (realModel && !fakeDeepSeek) mkdirSync(realConfig, { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  UI_CHECK_DIR: dir.replaceAll('\\', '/'),
  UI_CHECK_PORT: port,
  UI_CHECK_REMOTE: remote ? '1' : '',
  UI_CHECK_REAL_MODEL: realModel ? '1' : '',
  UI_CHECK_FAKE_DEEPSEEK: fakeDeepSeek ? '1' : '',
  LOCALAPPDATA: join(dir, 'localappdata'),
  ERP_CONFIG_DIR: realModel && !fakeDeepSeek ? realConfig : join(dir, 'config'),
  DB_PATH: join(dir, 'never-used.sqlite'),
};
if (await fetch(`http://127.0.0.1:${port}/api/auth/state`).then(() => true, () => false))
  throw new Error(`端口 ${port} 已被占用，先关掉上一个实例，或用 --port 换一个。`);
const vite = join(root, 'node_modules/vite/bin/vite.js');
console.log('构建到 ' + dir);
const built = spawnSync(process.execPath, [vite, 'build', '--outDir', join(dir, 'dist'), '--emptyOutDir'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
if (built.status !== 0) throw new Error('构建失败');
const watcher = spawn(process.execPath, [vite, 'build', '--watch', '--outDir', join(dir, 'dist')], {
  cwd: root,
  env,
  stdio: 'inherit',
});
const server = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(here, 'server.mts')], {
  cwd: dir,
  env,
  stdio: 'inherit',
});
const stop = () => {
  watcher.kill();
  server.kill();
};
server.on('exit', (code) => {
  watcher.kill();
  process.exit(code ?? 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
