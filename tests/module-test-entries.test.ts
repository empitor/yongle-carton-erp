/**
 * 测试也只走模块的入口：tests/ 下的文件引用登记了的模块，只许引它的 index.ts；
 * 只有测模块内部件（入口不导出的类、常量）的“本模块测试”登记进 moduleTests 并写明原因，才能直接引内部文件。
 * 这样模块内部怎么拆、怎么改名，只牵动它自己的测试；别的测试按入口测，换了实现也不用跟着改。
 * 认的引用：import、export ... from、import()、require（tests/module-map.ts 的 refsOf）；字符串里写的路径不算。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { files, isCode, refsOf } from './module-map.js';

type ModuleTests = { module: string; dir: string; own: { file: string; why: string }[] };

const moduleTests: ModuleTests[] = [
  {
    module: '基础',
    dir: 'server/core/',
    own: [
      { file: 'tests/assistant-attachments.test.ts', why: '核对附件跨重启后，业务库版本仍等于结构登记的 SCHEMA_LATEST' },
      { file: 'tests/assistant-memory.test.ts', why: '用 pragmaInteger 读虚构记忆库迁移后的 user_version' },
      { file: 'tests/assistant-registry.test.ts', why: '用 pragmaInteger 核对升级前后工具设置库的 user_version' },
      { file: 'tests/backup-create.test.ts', why: '直接测自动备份复制、版本分类和备份清单的支持版本信息' },
      { file: 'tests/backup-restore.test.ts', why: '按恢复器的 supportedDatabaseVersions 核对传回的版本支持范围' },
      { file: 'tests/bot-wecom.test.ts', why: '核对机器人回复和基础约束错误共用 CONSTRAINT_MESSAGE' },
      { file: 'tests/config-db-evolution.test.ts', why: '直接核对配置库步骤、当前版本及从基线升级和新建的结构' },
      { file: 'tests/config-db-fixture.ts', why: '配置库升级夹具用 UpgradeStep 构造步骤，并按 SNAPSHOT_DIRECTORY 查备份' },
      { file: 'tests/diagnostics-records.test.ts', why: '直接测出错记录的分类、调用栈清理和操作名称提取' },
      { file: 'tests/finance-backup-reset.test.ts', why: '将完整备份恢复后的业务库版本和结构登记的 SCHEMA_LATEST 比对' },
      { file: 'tests/finance-closing.test.ts', why: '从 SNAPSHOT_DIRECTORY 核对替换工资时生成的快照数' },
      { file: 'tests/finance-event-columns.test.ts', why: '用真实 upgradeSteps 升至指定旧版，验证财务事件列后续升级' },
      { file: 'tests/finance-settings.test.ts', why: '核对带预置科目的新库有结构登记的 SCHEMA_LATEST 迁移记录' },
      { file: 'tests/module-names.test.ts', why: '直接比对规则登记用的 serverModuleNames 和模块表' },
      { file: 'tests/operation-requests.test.ts', why: '用 runCleanup 实跑清理，按内部保留期、冲突提示和 PRAGMA 读数核对结果' },
      { file: 'tests/preview-digest.test.ts', why: '直接核对预览陈旧错误的 PREVIEW_CHANGED 提示' },
      { file: 'tests/record-kinds.test.ts', why: '直接测基础登记对未知归档和墓碑种类的拒绝 assertRecordKind' },
      { file: 'tests/release/maintenance.test.ts', why: '调用 snapshotForUpgrade 用真实命名和版本范围造升级前快照，验证维护命令' },
      { file: 'tests/release/patch-and-package.test.ts', why: '用 supportedDatabaseVersions 核对补丁和整包所支持的数据库版本' },
      { file: 'tests/savepoint.test.ts', why: '直接核对保存点回滚异步作业时的 ASYNC_JOB 提示' },
      { file: 'tests/schema-constraints.test.ts', why: '直接测建表用的 CHECK 表达式，并核对各入口共用的约束错误提示' },
      { file: 'tests/schema-create.test.ts', why: '直接测业务库建表、连接拒绝和结构指纹' },
      { file: 'tests/schema-evolution.test.ts', why: '从基线直接运行编号步骤，比对升级后的结构、版本和自增行为' },
      { file: 'tests/schema-fixture.ts', why: '业务库测试准备代码用 openBusinessDatabase 传入自定义 UpgradeStep 制造旧版和异常库' },
      { file: 'tests/schema-refusals.test.ts', why: '直接测拒绝打开的库、结构检测及升级前快照失败' },
      { file: 'tests/schema-upgrade.test.ts', why: '直接测升级执行器、快照、事务回滚和提交前结构检测' },
      { file: 'tests/snapshots.test.ts', why: '直接验证快照时间解析和 pruneSnapshots 的保留规则' },
      { file: 'tests/sql-read.test.ts', why: '直接核对脏行读失败时的 STORED_DATA_MESSAGE' },
      { file: 'tests/stream-reply.test.ts', why: '用 stream 内部心跳和推送间隔驱动虚构时钟' },
      { file: 'tests/upgrade-step-samples.test.ts', why: '直接运行真实 upgradeSteps 核对升级前后的数据样例' },
      { file: 'tests/versioned-sqlite-upgrade.test.ts', why: '按 SNAPSHOT_DIRECTORY 检查配置库失败升级留下的快照' },
      { file: 'tests/versioned-sqlite.test.ts', why: '直接测版本分类 checkVersionedSqlite 和配置库位置解析 resolveHomes' },
    ],
  },
  {
    module: '账号',
    dir: 'server/accounts/',
    own: [
      { file: 'tests/auth.test.ts', why: '核对各级别的权限发放表，并用可控的密码队列验证登录时的并发变化' },
      { file: 'tests/auth-throttle.test.ts', why: '用账号内部的构造选项和可控密码队列测试登录限频和密码核对' },
      { file: 'tests/hash-gate.ts', why: '账号测试的准备代码，用真实哈希函数验证密码队列的调度时序' },
      { file: 'tests/hash-queue.test.ts', why: '直接测密码队列的优先级、并发上限和正忙错误' },
      { file: 'tests/permission-rules.test.ts', why: '直接测账号库把存储的角色和权限还原成实际权限' },
      { file: 'tests/super-admin.test.ts', why: '用可控的密码队列验证进入超级管理员模式时会话变化的处理' },
      { file: 'tests/versioned-sqlite-backup.test.ts', why: '用账号库内部规格的清理规则验证升级和换回副本都没有会话' },
    ],
  },
  {
    module: '客户产品订单',
    dir: 'server/sales/',
    own: [
      { file: 'tests/duplicate-records.test.ts', why: '直接验证查重怎么归入料号相同、同一产品和同名的另一产品三组，入口只提供写入检查和显示函数' },
    ],
  },
  {
    module: '采购库存',
    dir: 'server/operations/',
    own: [
      {
        file: 'tests/operations-core.test.ts',
        why: '测采购库存的内部件：写入共用的 priorRecord、库存品规则 StockItems、流水查询 MovementQueries 和 OperationsRepository，入口不导出',
      },
      { file: 'tests/purchase-save.test.ts', why: '直接测保存采购单的 PurchaseWriter（入口只导出 OperationsService）' },
      { file: 'tests/stock-identity.test.ts', why: '要按类判断查重冲突 StockConflictError，只有测试用，入口不导出' },
      {
        file: 'tests/schema-constraints.test.ts',
        why: '比对建表的枚举和流水动作常量 stockMovementActions，这个常量只有测试用，进不了入口',
      },
    ],
  },
  {
    module: '单据流转',
    dir: 'server/flow/',
    own: [
      {
        file: 'tests/arrival-ledger-reads.test.ts',
        why: '测到货事件的按范围读（receiptEvents、arrivalPurchaseIds）和已到货缓存重算 syncReceivedUnits 本身，这几个是单据流转内部的读法，入口不导出',
      },
      {
        file: 'tests/arrival-records.test.ts',
        why: '测给采购库存的单据事实（stock-facts 的已到货、被引用、已安排）和到货事件本身，入口只导出用它们的 FlowService',
      },
      {
        file: 'tests/arrival-register.test.ts',
        why: '要把已到货缓存弄乱后直接调 syncReceivedUnits 核对重算，这个函数入口不导出',
      },
      {
        file: 'tests/batch-completion.test.ts',
        why: '和页面单条登记完工 ManualProductionCompletion 对照；它只挂在单据流转自己的路由上，入口只导出整批的 ProductionCompletion',
      },
      {
        file: 'tests/business-changes-fixture.ts',
        why: '准备代码：财务测试“假装业务变了”要按表主人的写法直接写单据表（writeFlowDocument、flowColumns）、读库里存的原始内容（storedDocument、documentOf），入口不给写单据表的函数',
      },
      {
        file: 'tests/completion-fixture.ts',
        why: '准备代码：登记单张完工走页面用的 ManualProductionCompletion（只挂在单据流转自己的路由上，入口不导出）',
      },
      {
        file: 'tests/completion-plan.test.ts',
        why: '直接测整批完工的纯计算（allocate、pickTasks、checkFacts），不写库，入口只导出用它的 ProductionCompletion',
      },
      {
        file: 'tests/delivery-material-flute.test.ts',
        why: '要看出库核对后库里存下的送货明细原文（storedDocument），视图会按产品补显示，看不出存没存',
      },
      {
        file: 'tests/flow-core.test.ts',
        why: '单据流转核心规则的直接调用：校验、读单据、关联表、预览、确认、取消撤销的内部函数，入口只导出 FlowService',
      },
      {
        file: 'tests/flow-document-store.test.ts',
        why: '直接测 document-store 的插入、写入、镜像列、存下的原文和 maintenance-writes 的整份替换校验，入口不导出这些单据写法',
      },
      {
        file: 'tests/flow-input-units.test.ts',
        why: '直接测单据输入的单位和数量校验 documentInput（纯校验、不读库），入口不导出',
      },
      {
        file: 'tests/flow-maintenance.test.ts',
        why: '直接测管理员连带（alignStock、detachPurchaseLines），用内部的 replaceFlowDocument 模拟另一次编辑，入口不导出这些内部件',
      },
      {
        file: 'tests/flow-totals.test.ts',
        why: '直接测订单明细已发的合计 shippedUnits，入口不导出',
      },
      {
        file: 'tests/read-counts.test.ts',
        why: '数读语句条数要盯住内部的 StockViews 方法和单条登记完工 ManualProductionCompletion，入口不导出',
      },
      {
        file: 'tests/receive-fixture.ts',
        why: '准备代码：更正到货单要按原单的到货事件（receiptEvents）编行号，入口没有这个读法',
      },
      {
        file: 'tests/schema-constraints.test.ts',
        why: '比对建表的原件种类枚举和 flowSourceKinds，这个常量只有测试要，进不了入口',
      },
      {
        file: 'tests/snapshot-fixture.ts',
        why: '准备代码：把一张单据的快照字段填成标记值要读库里存的原文（storedDocument），入口只给视图',
      },
      {
        file: 'tests/snapshot-resave-cascades.test.ts',
        why: '直接调管理员连带（alignStock、detachPurchaseLines）后核对库里存的原文（storedDocument），入口都不导出',
      },
      {
        file: 'tests/snapshot-resave-corrections.test.ts',
        why: '更正后核对库里存的原文里的快照字段（storedDocument），视图看不出原样保留没有',
      },
      {
        file: 'tests/workbench.test.ts',
        why: '造当日完工实绩走页面单条登记完工 ManualProductionCompletion（只挂在单据流转自己的路由上，入口不导出）',
      },
    ],
  },
  {
    module: '订单服务',
    dir: 'server/orders/',
    own: [
      { file: 'tests/business-base-fixture.ts', why: '准备代码复用页面路由的 manualWrite，保留真实的快照和审计；其它测试经夹具调用' },
      { file: 'tests/list-filters.test.ts', why: '直接测客户、产品和订单三个列表的筛选和统计，列表函数由模块自己的路由调用' },
      { file: 'tests/order-filter.test.ts', why: '直接对照订单列表与助手的筛选结果，订单列表函数由模块自己的路由调用' },
      { file: 'tests/record-status.test.ts', why: '直接验证整张保存拦住越过状态动作的变更，assertOrderStatusKept 只由模块自己的路由调用' },
    ],
  },
  {
    module: '共用-业务',
    dir: 'shared/business/',
    own: [
      { file: 'tests/arrival-recognition.test.ts', why: '直接测 matchArrivalBatch 遇到不匹配的识别明细时不选订货单' },
      { file: 'tests/assistant-bulk-planning.test.ts', why: '用内部 planStockDelivery 的分组结果核对助手送货计划的明细' },
      { file: 'tests/delete-impact.test.ts', why: '直接核对删除清单的内部表名和字段词表' },
      { file: 'tests/delivery-flow.test.ts', why: '用内部 flowStatusLabel 核对编辑后单独显示的送达状态' },
      { file: 'tests/delivery-matching.test.ts', why: '直接测内部 planStockDelivery 按客户分配现货的结果' },
      { file: 'tests/delivery-shipping.test.ts', why: '用内部 flowStatusLabel 核对待送货、送货中、已送达和已撤销的叫法' },
      { file: 'tests/finance-fingerprint-rename.test.ts', why: '直接用 fingerprintOf 和 fingerprintRules 模拟字段改名，核对指纹' },
      { file: 'tests/finance-money.test.ts', why: '直接测 deliveryLineExact 的金额精度及数量校验' },
      { file: 'tests/finance-source-contract.test.ts', why: '对照内部财务归类表、指纹规则和单据内容结构，核对字段一一对应' },
      { file: 'tests/history-fixture.ts', why: '历史测试夹具用 HistoryView 和 historyFieldLabel 断言视图的栏目中文名' },
      { file: 'tests/movement-types.test.ts', why: '用内部 MovementType 约束各类流水期望值，确保每种分类都有断言' },
      { file: 'tests/order-batch-rules.test.ts', why: '直接测 scheduleView 对当日、逾期和排程剩余量的计算' },
      { file: 'tests/order-edit-cascade.test.ts', why: '用内部 flowStatusLabel 核对改单拆分前后的送达状态' },
      { file: 'tests/production-flow.test.ts', why: '直接核对 flowStatusLabel 对生产进度和单据状态的叫法' },
      { file: 'tests/record-history-audit.test.ts', why: '用内部历史视图类型、动作名表及未知提示核对审计动作的显示' },
      { file: 'tests/record-history-view.test.ts', why: '直接核对内部历史动作名表和未知、无变化时的提示' },
      { file: 'tests/snapshot-fixture.ts', why: '从内部单据内容和到货明细结构派生快照测试数据' },
      { file: 'tests/stock-batches.test.ts', why: '按内部 BatchMovement 类型构造计算成品批次用的库存流水' },
    ],
  },
];

/** 引用方式里算“用代码”的：静态引用、import()、require */
const codeRef = new Set(['import', 'import()', 'require']);

/** 模块目录的最后一段（如 operations）：文字里出现它才可能引到这个模块 */
const dirName = (dir: string) => dir.split('/').filter(Boolean).pop() ?? dir;

/**
 * 测试文件 f（内容 text，不给就读文件）里绕过入口直接引模块内部的地方。
 * 加载目标看不出来的动态加载（import(变量)、带变量的模板字符串、require(变量)）：加载的文字或整个文件里出现模块目录
 * （如 server/operations/）就算可能绕过入口，也报，改成写明路径的字面量走 index.ts。
 */
function violations(f: string, text: string = readFileSync(f, 'utf8')) {
  const refs = refsOf(f, text).filter((r) => codeRef.has(r.how));
  return moduleTests.flatMap(({ module, dir, own }) => {
    if (own.some((o) => o.file === f)) return [];
    const inner = refs
      .filter((r) => r.target?.startsWith(dir) && r.target !== dir + 'index.ts')
      .map((r) => f + ':' + r.line + ' 引了 ' + r.target + '：测试引' + module + '只走 ' + dir + 'index.ts；是本模块自己的测试登记进 moduleTests 并写明原因');
    const hidden = refs
      .filter((r) => r.unresolved !== undefined && (r.unresolved.includes(dirName(dir)) || text.includes(dir)))
      .map((r) => f + ':' + r.line + ' 的 ' + r.how + '（' + r.unresolved + '）看不出加载哪个文件，可能绕过' + module + '的入口：改成写明路径的字面量，只引 ' + dir + 'index.ts');
    return [...inner, ...hidden];
  });
}

/** import(…)、require(…) 里不是一个写死的字符串（拼接、模板、变量）：目标可能看不出来 */
const dynamicLoad = /\b(?:import|require)\s*\(\s*(?!(['"])[^'"`]*\1\s*\))/;
/**
 * 要解析的文件（全量解析 tests/ 太慢）：文字里出现模块路径且指向非入口文件（如 server/core/storage），
 * 或者有看不出目标的动态加载并出现模块目录名。只引 index.js 或 shared/core/ 的文件跳过。
 */
const moduleMatchers = moduleTests.map(({ dir }) => ({ dir, name: dirName(dir), inner: new RegExp(dir + '(?!index\\.)') }));
const mayRefer = (text: string) => {
  const hasDynamic = dynamicLoad.test(text);
  return moduleMatchers.some(({ dir, name, inner }) => (text.includes(dir) && inner.test(text)) || (hasDynamic && text.includes(name)));
};

test('测试引登记了的模块只走 index.ts，本模块测试登记过才能引内部', () => {
  const found = files('tests')
    .filter(isCode)
    .flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return mayRefer(text) ? violations(f, text) : [];
    });
  assert.deepEqual(found, []);
});

test('本模块测试名单不留过期登记：文件还在，确实直接引了模块内部，原因写了', () => {
  for (const { module, dir, own } of moduleTests)
    for (const { file, why } of own) {
      assert.ok(existsSync(file), module + '的本模块测试 ' + file + ' 已经没有了，删掉这条登记');
      assert.ok(why.trim(), file + ' 没写原因');
      const inner = refsOf(file).filter((r) => codeRef.has(r.how) && r.target?.startsWith(dir) && r.target !== dir + 'index.ts');
      assert.ok(inner.length, file + ' 已经只走 ' + dir + 'index.ts，删掉这条登记');
    }
});

test('回归样例：引内部文件、export from、require、import() 内部文件、看不出目标的加载各报一条；引 index.js、登记过的本模块测试不报', () => {
  const sample = 'tests/虚构样例.test.ts';
  assert.equal(violations(sample, "import { stockLedger } from '../server/operations/ledger/ledger.js';").length, 1);
  assert.equal(violations(sample, "export { insertMovement } from '../server/operations/ledger/ledger.js';").length, 1, 'export from 也算');
  assert.equal(violations(sample, "const ledger = require('../server/operations/ledger/ledger.js');").length, 1, 'require 也算');
  assert.equal(violations(sample, "const m = await import('../server/operations/batches/batches.js');").length, 1);
  assert.equal(violations(sample, "export async function load(n: string) { return import('../server/operations/' + n); }").length, 1, '拼出来的目标看不出来');
  assert.equal(violations(sample, 'export async function load(n: string) { return import(`../server/operations/${n}.js`); }').length, 1, '模板字符串也一样');
  assert.equal(violations(sample, "export async function load(n: string) { return import('../server/finance/' + n); }").length, 0, '和这个模块无关的不报');
  assert.equal(violations(sample, "import { stockLedger } from '../server/operations/index.js';").length, 0);
  assert.equal(violations(sample, "import type { RecordIds } from '../server/operations/ledger/record-scope.js';").length, 1, '只引类型也算');
  assert.equal(violations(sample, "import { HashQueue } from '../server/accounts/hash-queue.js';").length, 1);
  assert.equal(violations(sample, "import { AuthManager } from '../server/accounts/index.js';").length, 0);
  assert.equal(violations(sample, "import { MarkService } from '../server/sales/product-marks.js';").length, 1);
  assert.equal(violations(sample, "import { MarkService } from '../server/sales/index.js';").length, 0);
  assert.equal(violations('tests/operations-core.test.ts', "import { MovementQueries } from '../server/operations/ledger/movements.js';").length, 0);
  const sharedInternal = "import { scheduleView } from '../shared/business/operations/order-batch.js';";
  const sharedEntry = "import { batchRows } from '../shared/business/index.js';";
  assert.equal(mayRefer(sharedInternal), true);
  assert.equal(violations(sample, sharedInternal).length, 1);
  assert.equal(violations('tests/order-batch-rules.test.ts', sharedInternal).length, 0);
  assert.equal(mayRefer(sharedEntry), false);
  assert.equal(violations(sample, sharedEntry).length, 0);
});

test('基础模块的 Store 走入口，登记的结构测试可以直接验证升级实现', () => {
  const sample = 'tests/虚构样例.test.ts';
  assert.equal(violations(sample, "import { Store } from '../server/core/storage/db.js';").length, 1);
  assert.equal(violations(sample, "import { Store } from '../server/core/index.js';").length, 0);
  assert.equal(violations(sample, "import { upgradeSteps } from '../server/core/schema/index.js';").length, 1);
  assert.equal(violations('tests/schema-upgrade.test.ts', "import { upgradeSteps } from '../server/core/schema/index.js';").length, 0);
});
