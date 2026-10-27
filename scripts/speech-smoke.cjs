// Compatibility command; the canonical smoke test shares the production model loader.
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const result = spawnSync(
  process.execPath,
  [require.resolve('tsx/cli'), join(__dirname, 'speech', 'smoke.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit', windowsHide: true },
);
if (result.error) {
  console.error('本机语音自检启动失败，请检查Node与依赖。');
  process.exitCode = 1;
} else process.exitCode = result.status ?? 1;
