// 安装包和服务器补丁共用的程序文件清单。只列程序本身，不含 data/、backups/ 和密钥。
// 改这里会同时影响整包和补丁，两边的服务器文件就不会不一致。
export const releaseFiles = [
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
  'THIRD_PARTY_NOTICES.md',
  'docs/使用手册.md',
  'docs/运维',
  'docs/CHANGELOG.md',
  // 服务端和部署用到的脚本，开发脚本不进包。
  'scripts/start-system.mjs',
  'scripts/runtime-control.mjs',
];
