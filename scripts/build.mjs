import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本机系统 Temp 目录上，esbuild 0.28 为超过 1MB 的输入写出的中转临时文件
// 删除时会返回 Access is denied（文件句柄未及时释放，疑似安全软件/索引服务占用），
// 导致 vite build 在 [vite:esbuild-transpile] 阶段失败。构建统一改在项目内临时目录执行。
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cleanup = (path) => {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
};
// 上次构建可能因 Node 编译缓存句柄未释放而留下 .build-tmp-*；本轮构建前先统一清理，
// 避免项目目录里不断累积空目录。删不掉时留给下一次构建再试。
for (const name of readdirSync(root)) {
  if (name.startsWith('.build-tmp-')) cleanup(join(root, name));
}
const tmp = mkdtempSync(join(root, '.build-tmp-'));
const run = (entry, args, label) => {
  const result = spawnSync(process.execPath, [join(root, 'node_modules', entry), ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, TMP: tmp, TEMP: tmp },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error('\n构建步骤失败：' + label);
    const error = new Error('构建步骤失败：' + label);
    error.exitCode = result.status ?? 1;
    throw error;
  }
};
try {
  run('typescript/bin/tsc', ['--noEmit'], 'typecheck（npm run build 内含）');
  run('vite/bin/vite.js', ['build'], 'vite build');
} catch (error) {
  process.exitCode = error.exitCode || 1;
  console.error(error.message);
} finally {
  // Node 24 的编译缓存偶尔会短暂占用目录，允许重试；仍失败则下次构建前清理。
  if (!cleanup(tmp)) console.warn('临时构建目录将在下次构建前自动清理：' + tmp);
}
