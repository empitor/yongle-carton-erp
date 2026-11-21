// 变异测试（npm run mutation）：把下面 mutate 里的文件逐处改坏，看点名的测试能不能发现。
// 项目用 node:test，没有专门的运行器，用 command 运行器跑点名的测试；结果和沙箱都放在 .cache/（已忽略）。
// 沙箱只拷 server、shared、src、scripts、tests 和根目录几份配置，业务数据和备份目录不进沙箱。
// 一次只跑一组（每组是几份规则文件和守它们的测试）：环境变量 MUTATION_SET 选组，不给就是 core。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 测试进程的本机数据、配置、业务库和备份目录都指进新建的临时目录（和 npm test 一样碰不到真实数据）
const sandbox = mkdtempSync(join(tmpdir(), 'erp-mutation-env-'));
Object.assign(process.env, {
  LOCALAPPDATA: sandbox,
  ERP_CONFIG_DIR: sandbox,
  XDG_CONFIG_HOME: sandbox,
  DB_PATH: join(sandbox, 'never-used.sqlite'),
  ERP_BACKUP_DIR: sandbox,
});

const sets = {
  core: {
    mutate: ['shared/core/precision.ts', 'shared/core/quantity.ts', 'shared/core/units.ts', 'server/finance/amounts.ts'],
    tests: [
      'tests/precision.test.ts',
      'tests/price-storage.test.ts',
      'tests/property-money.test.ts',
      'tests/property-quantity.test.ts',
      'tests/constraints-business.test.ts',
      'tests/finance-money.test.ts',
      'tests/finance-tax-terms.test.ts',
      'tests/price-rules-boundaries.test.ts',
      'tests/quantity-units-boundaries.test.ts',
    ],
  },
  // 库存：写流水前的“不能负、不超上限、0 只有盘点能记”和按流水重算结余
  stock: {
    mutate: ['server/operations/ledger.ts:40-86'],
    tests: ['tests/stock-items.test.ts', 'tests/delivery-flow.test.ts', 'tests/data-management.test.ts', 'tests/stock-ledger-boundaries.test.ts'],
  },
  // 财务凭证：借贷平衡、已记账不可改、红字冲销只做一次
  voucher: {
    mutate: ['server/finance/ledger.ts:86-109', 'server/finance/ledger.ts:237-321'],
    tests: ['tests/finance-ledger.test.ts', 'tests/voucher-rules-boundaries.test.ts'],
  },
  // 税额：增值税留抵按月滚动、附加税、按百分比算税
  tax: {
    mutate: ['server/finance/vat.ts:42-119', 'server/finance/terms.ts:22-33'],
    tests: ['tests/finance-invoice-vat.test.ts', 'tests/finance-closing-tax.test.ts', 'tests/finance-tax-terms.test.ts', 'tests/vat-worksheet-boundaries.test.ts'],
  },
  // 权限：按账号判断能不能做、超级管理员模式、纯财务账号能用的地址和工具
  // （起整套服务的 super-admin、auth 测试一组要跑近 10 分钟，规则本身由纯函数测试守）
  permission: {
    mutate: ['server/core/permissions.ts', 'shared/core/account-scope.ts'],
    tests: ['tests/permission-rules.test.ts', 'tests/assistant-account-scope.test.ts'],
  },
  // 单位和数量的校验入口：单据输入归一单位、拒收别的单位、到货行的 0
  units: {
    mutate: ['server/flow/validate.ts:16-57', 'shared/business/physical-flow.ts:233-251'],
    tests: ['tests/flow-core.test.ts', 'tests/arrival-register.test.ts', 'tests/task-edit.test.ts', 'tests/stock-items.test.ts', 'tests/flow-input-units.test.ts'],
  },
};

const name = process.env.MUTATION_SET || 'core';
const set = sets[name];
if (!set) throw new Error('没有这一组变异测试：' + name + '（可选：' + Object.keys(sets).join('、') + '）');

export default {
  mutate: set.mutate,
  testRunner: 'command',
  commandRunner: { command: 'node --import tsx --test --test-isolation=none ' + set.tests.join(' ') },
  // 先全部排除，再只放行源码目录和要用的配置：data、backups、dist 都不进沙箱
  ignorePatterns: ['/*', '!/server', '!/shared', '!/src', '!/scripts', '!/tests', '!/package.json', '!/tsconfig.json'],
  tempDirName: '.cache/stryker-tmp',
  reporters: ['clear-text', 'progress', 'json', 'html'],
  jsonReporter: { fileName: '.cache/stryker/' + name + '.json' },
  htmlReporter: { fileName: '.cache/stryker/' + name + '.html' },
  concurrency: 6,
  timeoutMS: 20000,
  cleanTempDir: true,
};
