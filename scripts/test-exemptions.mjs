// 测试检查的登记表：登记了原因的不报。一条一句为什么，改快了、补上测试了就删掉那条。
//   slowTests：单独跑也超过 1 秒的测试（npm test 跑完查，并行时越线的会单独重跑再判，见 test-slow.mjs），{ 测试文件: { 测试名: 原因 } }
//   lowCoverage：server/、shared/ 里行覆盖低于 80% 的文件（npm run test:coverage 查），{ 文件: 原因 }

export const slowTests = {
  'tests/feature-links-senders.test.ts': {
    '一个动作一个提交处：同一个写地址在前端只有一个文件发':
      '需为前端 src/ 与 shared/ 全部源码建立 TypeScript 类型程序并做全量请求分析，快不了',
  },
  'tests/module-api-owners.test.ts': {
    '前端每个模块只请求自己和能用的后端模块的接口，别的模块的数据走插槽里的服务接口':
      '需为前端 src/ 与 shared/ 全部源码建立 TypeScript 类型程序并扫描全部前端接口引用，快不了',
    '前端请求地址的取法：该拦的拦住，外部地址、页面跳转、静态资源、注释不算':
      '需在公共类型程序上叠加 20 余条回归样例重建 overlay TypeScript 程序并逐条分析，快不了',
  },
  'tests/module-boundaries.test.ts': {
    模块之间只按规定的方向引用: '首次扫描并解析 server/、shared/、src/ 全部源码的语法树并建立引用缓存，快不了',
  },
  'tests/backup-restore.test.ts': {
    '版本记录不完整、结构被改过的备份，即使清单哈希正确也拒绝恢复，不改目标目录；备份时不比结构':
      '3 种被改过的库每种做 3 次完整校验（直接校验、恢复前校验、备份口径校验）共 9 次，每次都对整库比对标准结构，单独跑 1.4 秒左右',
    '备份里的配置库损坏、比程序新、是 0.9.0 以前的旧格式：恢复在复制和切换之前拒绝并写明是哪个文件，现有数据不变':
      '需循环 9 种损坏/版本异常场景，每次复制整套 SQLite 备份并打开多个配置库校验，快不了',
  },
  'tests/platform-credentials.test.ts': {
    'Windows DPAPI：密文带 dpapi:v1 标记、能解回；不带标记的不认':
      '要起 PowerShell 调 Windows 原生 DPAPI 加密接口（ProtectedData）加解密，时间几乎都花在起 PowerShell 进程上，单独跑 0.7–1.1 秒',
  },
};

export const lowCoverage = {
  'server/index.ts': '正式启动入口，测试不许加载（AGENTS.md“绝对不能做”）；装配在 server/app.ts 测',
  'server/maintenance.ts': '一加载就执行的命令行入口，测试不许加载',
  'server/stop.ts': '一加载就执行的命令行入口（会去连正式实例的 3001 端口），测试不许加载',
};
