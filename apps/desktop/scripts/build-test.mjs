// 打 Windows 测试版：打开的网址由命令行给，写进测试版自己的 config\app.json（正式版的在 config/app.json，不动）。
// 默认只出程序（src-tauri/target/release/ 下的启动器，按 tauri.test.conf.json 的 mainBinaryName 改名为 甬勒ERP测试.exe；
// 核心 yongle_erp_core.dll，资源复制在旁边）；
// 加 --installer 再出安装包（target/release/bundle/nsis/）。
// 测试版换了应用标识和名字（tauri.test.conf.json），和正式版的登录数据、托盘实例、安装位置互不影响。
// 应用内更新的测试（见 scripts/update-test.mjs）另加：--version 0.2.0 换版本号；--updater 出更新包和签名
//   （要先在环境变量里给 TAURI_SIGNING_PRIVATE_KEY；清单地址 ERP_UPDATE_URL、公钥 ERP_UPDATE_PUBKEY 写进测试版的
//    config\app.json，公钥也写进配置的 plugins.updater.pubkey，Tauri 签名时要核对它）。
// 用法：node scripts/build-test.mjs http://127.0.0.1:8788/ [--installer] [--version 0.2.0] [--updater]
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const url = args[0];
if (!url || !/^https?:\/\/[^/]+\/?/.test(url)) {
  console.error('用法：node scripts/build-test.mjs <测试网址> [--installer] [--version x.y.z] [--updater]，例如 http://127.0.0.1:8788/');
  process.exit(2);
}
const versionAt = args.indexOf('--version');
const version = versionAt > 0 ? args[versionAt + 1] : null;
if (versionAt > 0 && !/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('--version 要写成 x.y.z');
  process.exit(2);
}
const updater = args.includes('--updater');
if (updater && !process.env.TAURI_SIGNING_PRIVATE_KEY) {
  console.error('--updater 要先在环境变量 TAURI_SIGNING_PRIVATE_KEY 里给测试签名私钥');
  process.exit(2);
}
const project = fileURLToPath(new URL('..', import.meta.url));
// 测试版的 config\app.json：放在构建输出目录里，不进仓库
const testConfig = 'target/test-config/app.json';
mkdirSync(fileURLToPath(new URL('../src-tauri/target/test-config/', import.meta.url)), { recursive: true });
const pubkey = process.env.ERP_UPDATE_PUBKEY ?? '';
writeFileSync(
  fileURLToPath(new URL('../src-tauri/' + testConfig, import.meta.url)),
  JSON.stringify({ erpUrl: url, updateUrl: process.env.ERP_UPDATE_URL ?? '', updatePubkey: pubkey }, null, 2),
);
const overrides = {
  ...(version ? { version } : {}),
  // 资源表按 JSON 合并：正式版那份置空删掉，换成测试版这份
  bundle: { resources: { '../config/app.json': null, [testConfig]: 'config/app.json' }, ...(updater ? { createUpdaterArtifacts: true } : {}) },
  ...(pubkey ? { plugins: { updater: { pubkey } } } : {}),
};
const bundle = args.includes('--installer') || updater ? [] : ['--no-bundle'];
const result = spawnSync(
  'npx',
  [
    'tauri',
    'build',
    ...bundle,
    // 主程序（启动器）里没有 Tauri，写不进安装包类型标记；更新插件没有标记时按清单的 windows-x86_64 条目找包
    '--no-binary-patching',
    '--config',
    'src-tauri/tauri.test.conf.json',
    '--config',
    JSON.stringify(JSON.stringify(overrides)),
    // Tauri 只编程序；核心 dll 是库，要在同一次 cargo 编译里一起编（这样也用上同一份合并后的配置）
    '--',
    '--lib',
  ],
  { cwd: project, shell: true, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
