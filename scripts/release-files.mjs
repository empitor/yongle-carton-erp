// 安装包和服务器补丁共用的程序文件清单。只列程序本身，不含 data/、backups/、密钥和语音模型。
// 改这里会同时影响整包和补丁，两边的服务器文件就不会不一致。
export const releaseFiles = (version) => [
  'server',
  'shared',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.env.example',
  '启动系统.cmd',
  '停止系统.cmd',
  'scripts/linux',
  'README.md',
  'LICENSE',
  'vendor/models/README.md',
  'docs/使用手册.md',
  'docs/部署与运维.md',
  'docs/CHANGELOG.md',
  `docs/releases/发布说明-v${version}.md`,
  // 服务端和部署用到的脚本，开发脚本不进包。
  'scripts/start-system.mjs',
  'scripts/runtime-control.mjs',
  'scripts/run-deployment.mjs',
  'scripts/install-deployment-task.ps1',
  'scripts/diagnose-startup-zone.ps1',
  'scripts/ocr-image.ps1',
];
