// 生成可下载的 Windows 发布包：解压后双击“启动系统.cmd”即可使用。
// 用法：npm run package [-- --out 输出目录]。默认输出到系统临时目录。
// 只复制白名单里的文件，绝不把 data/、backups/、密钥和语音模型打进去。
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `yongle-carton-erp-v${pkg.version}-win-x64`;
const outFlag = process.argv.indexOf('--out');
const out = outFlag > 0 ? resolve(process.argv[outFlag + 1]) : mkdtempSync(join(tmpdir(), 'erp-release-'));
const stage = join(mkdtempSync(join(tmpdir(), 'erp-stage-')), name);
mkdirSync(stage, { recursive: true });
mkdirSync(out, { recursive: true });

const step = (text) => console.log('\n== ' + text);
const copy = (from, to = from) => {
  const source = join(root, from);
  if (!existsSync(source)) throw new Error('缺少发布文件：' + from);
  cpSync(source, join(stage, to), { recursive: true });
};

step('检查环境');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 15) throw new Error('打包要用 Node.js 24.15 或更高的 24.x。');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('发布包只支持在 Windows x64 上生成。');
const nodeDir = dirname(process.execPath);
for (const item of ['node.exe', 'npm.cmd', 'node_modules/npm'])
  if (!existsSync(join(nodeDir, item))) throw new Error('Node 安装目录不完整：' + item);

step('复制程序文件');
for (const item of [
  'server',
  'shared',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.env.example',
  '启动系统.cmd',
  '停止系统.cmd',
  'README.md',
  'LICENSE',
  'vendor/xlsx-0.20.3.tgz',
  'vendor/models/README.md',
  'docs/使用手册.md',
  'docs/部署与运维.md',
  'docs/CHANGELOG.md',
  `docs/releases/发布说明-v${pkg.version}.md`,
  // 服务端和部署用到的脚本，开发脚本不进包。
  'scripts/start-system.mjs',
  'scripts/runtime-control.mjs',
  'scripts/run-deployment.mjs',
  'scripts/install-deployment-task.ps1',
  'scripts/diagnose-startup-zone.ps1',
  'scripts/ocr-image.ps1',
])
  copy(item);

step('构建页面');
const built = spawnSync(
  process.execPath,
  [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', join(stage, 'dist'), '--emptyOutDir'],
  { cwd: root, stdio: 'inherit' },
);
if (built.status !== 0) throw new Error('页面构建失败');

step('安装生产依赖');
execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --omit=dev --no-audit --no-fund'], {
  cwd: stage,
  stdio: 'inherit',
});
rmSync(join(stage, 'vendor/xlsx-0.20.3.tgz'));

step('内置 Node.js ' + process.version);
const runtime = join(stage, 'runtime/node');
mkdirSync(runtime, { recursive: true });
for (const item of ['node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'node_modules/npm'])
  cpSync(join(nodeDir, item), join(runtime, item), { recursive: true });
if (existsSync(join(nodeDir, 'LICENSE'))) cpSync(join(nodeDir, 'LICENSE'), join(runtime, 'LICENSE'));

step('写入发布标记');
let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
  /* 没有 git 时不影响打包 */
}
// 有这个文件，启动器就直接用构建好的页面，不再安装依赖和构建。
writeFileSync(
  join(stage, '.release-package'),
  JSON.stringify({ version: pkg.version, node: process.version, commit }, null, 2) + '\n',
);
writeFileSync(
  join(stage, '维护命令行.cmd'),
  [
    '@echo off',
    'cd /d "%~dp0"',
    'set "PATH=%~dp0runtime\\node;%PATH%"',
    'echo Backup:         npm.cmd run backup',
    'echo Restore:        npm.cmd run restore -- "backup folder"',
    'echo Reset password: npm.cmd run reset-password -- "user name"',
    'cmd /k',
    '',
  ].join('\r\n'),
);

step('检查发布包内容');
const problems = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name),
      rel = relative(stage, full).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      if (/^(data|backups|tests|work|outputs?|src|docs\/history|\.git|\.github|\.claude)(\/|$)/.test(rel))
        problems.push('不该打包的目录：' + rel);
      walk(full);
      continue;
    }
    if (/\.(sqlite(-\w+)?|running|control|onnx|pem|key|pfx|p12)$/i.test(entry.name) || /^\.env$/.test(entry.name))
      problems.push('不该打包的文件：' + rel);
    if (!rel.startsWith('node_modules/') && !rel.startsWith('runtime/') && statSync(full).size < 5_000_000) {
      const text = readFileSync(full, 'latin1');
      if (/\bsk-(?!fictional|test|fake|mock|example|dummy)[A-Za-z0-9_-]{24,}\b|gh[pousr]_[A-Za-z0-9]{30,}|BEGIN [A-Z ]*PRIVATE KEY/.test(text))
        problems.push('疑似密钥：' + rel);
    }
  }
};
walk(stage);
if (problems.length) throw new Error('发布包内容不合格：\n' + problems.join('\n'));

step('压缩');
const zip = join(out, name + '.zip');
rmSync(zip, { force: true });
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:ERP_STAGE, $env:ERP_ZIP, 'Optimal', $true)`,
  ],
  { stdio: 'inherit', env: { ...process.env, ERP_STAGE: stage, ERP_ZIP: zip } },
);
const hash = createHash('sha256');
for await (const chunk of createReadStream(zip)) hash.update(chunk);
const digest = hash.digest('hex');
writeFileSync(zip + '.sha256', `${digest}  ${basename(zip)}\n`);
rmSync(dirname(stage), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

console.log('\n发布包：' + zip);
console.log('大小：' + (statSync(zip).size / 1048576).toFixed(1) + ' MB');
console.log('SHA-256：' + digest);
