// 界面实测：构建到临时目录，起隔离实例，用无头 Chrome 走财务主要流程。
// 用法：npm run test:ui。截图留在输出的临时目录里。需要本机装了 Chrome，或设置 CHROME_PATH。
// 不碰 data/、backups/ 和正式实例，也不覆盖项目的 dist。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const here = fileURLToPath(new URL('./', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'erp-ui-check-'));
const env = {
  ...process.env,
  UI_CHECK_DIR: dir.replaceAll('\\', '/'),
  LOCALAPPDATA: join(dir, 'localappdata'),
  DB_PATH: join(dir, 'never-used.sqlite'),
};
const vite = join(root, 'node_modules/vite/bin/vite.js');
const built = spawnSync(process.execPath, [vite, 'build', '--outDir', join(dir, 'dist'), '--emptyOutDir'], {
  cwd: root,
  env,
  stdio: 'ignore',
});
if (built.status !== 0) throw new Error('构建失败');
const startServer = async () => {
  // 端口上已有别的实例时，连上去会测到旧数据，直接报错。
  if (await fetch('http://127.0.0.1:3199/api/auth/state').then(() => true, () => false))
    throw new Error('端口 3199 已被占用，请先关掉上一个实测实例。');
  const child = spawn(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), join(here, 'server.mts')],
    { cwd: dir, env, stdio: 'ignore' },
  );
  for (let i = 0; i < 60; i++) {
    const up = await fetch('http://127.0.0.1:3199/api/auth/state').then(() => true, () => false);
    if (up) return child;
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill();
  throw new Error('隔离实例没有启动');
};
const runFlow = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { env });
    let text = '';
    const collect = (b) => {
      text += b;
      process.stdout.write(b);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (code) => resolve({ code, text }));
  });
const problems = [];
const check = ({ code, text }, file) => {
  if (code) problems.push(file + ' 中途失败');
  for (const line of text.split('\n'))
    if (/ERR: |dialog error|still open|costing err/.test(line)) problems.push(file + '：' + line);
};
// 同一批流程共用状态；flow-other 自己启用财务，要全新的实例。
for (const batch of [
  ['flow-basics.mjs', 'flow-ledger.mjs', 'flow-closing.mjs'],
  ['flow-other.mjs'],
  ['flow-permission.mjs'],
]) {
  const server = await startServer();
  try {
    for (const file of batch) check(await runFlow(file), file);
  } finally {
    server.kill();
    await new Promise((r) => server.once('close', r));
  }
}
console.log('\n截图目录：' + dir);
if (problems.length) {
  console.error('有 ' + problems.length + ' 处问题：\n' + problems.join('\n'));
  process.exitCode = 1;
} else console.log('界面实测通过');
