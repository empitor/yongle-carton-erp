// 模块表和取引用的解析器：每个文件属于哪个模块、能用哪些模块，一个文件引用了哪些项目文件。
// docs/生成/模块表.md 由 npm run docs:gen 从这里生成（模块的 what、layerNote 和 moduleChecks 是写给它的说明），改了这里重新生成。
// 守规则的检查和各拦什么登记在下面的 moduleChecks。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { posix } from 'node:path';
import ts from 'typescript';

/** 模块里的一层：paths 写法和模块的一样（目录带末尾斜杠，单个文件写全名） */
export type Layer = { name: string; paths: string[] };
/** layers：模块内部从下往上分层，同一模块里只能引同层或下层（module-boundaries 查）；模块的每个文件都要落在某一层，入口 index.ts、pages.ts 可以不登记 */
export type Rule = { name: string; paths: string[]; allow: string[]; layers?: Layer[] };
/** 模块表里的一项：what 是这个模块管什么，layerNote 是分层的说明（分了层的要写），都写进生成的模块表；Markdown 写法，代码名字带反引号 */
export type ModuleRule = Rule & { what: string; layerNote?: string };

// 越往下越基础。paths 按最长前缀匹配；目录写到末尾的斜杠，单个文件写全名。
// allow 和实际用到的一致（module-boundaries 有测试查）：新用到一个模块就在这里加上，不再用了就删掉，生成的模块表跟着重新生成。
export const modules: ModuleRule[] = [
  // 服务端
  {
    name: '基础',
    paths: ['server/core/'],
    allow: ['共用-基础'],
    what: '业务库建表和升级、配置库版本、业务库连接和归档标记（`Store`）、取号、防重复提交、请求身份接口和权限规则、审计、统一报错、归档恢复、流式写出、备份和快照、每日清理、出错记录（`diagnostics/`）；给上层登记用的接口',
    layerNote: '建表、升级和备份共用 SQLite 的只读连接和一致副本。`Store` 使用下层的记录种类登记，归档、审计和删除规则使用 `Store`。其他模块引 `server/core/index.ts`',
    layers: [
      { name: '请求和报错', paths: ['server/core/http/'] },
      { name: '文件校验', paths: ['server/core/files/'] },
      { name: 'SQLite 基础', paths: ['server/core/storage/sqlite/'] },
      { name: '业务库结构', paths: ['server/core/schema/'] },
      { name: '记录种类登记', paths: ['server/core/records/kinds/'] },
      { name: '业务库存储', paths: ['server/core/storage/'] },
      { name: '记录维护', paths: ['server/core/records/'] },
      { name: '备份和配置库', paths: ['server/core/backup/'] },
      { name: '出错记录', paths: ['server/core/diagnostics/'] },
    ],
  },
  { name: '账号', paths: ['server/accounts/'], allow: ['基础', '共用-基础'],
    what: '登录、会话、账号管理、账号申请和登录记录；地址 `/api/auth`。账号规则和接口表在 `shared/core/`；登录页和账号菜单在前端-装配，账号管理页在前端-管理' },
  { name: 'AI接入', paths: ['server/ai/'], allow: ['基础', '共用-基础', '共用-AI'],
    what: '发给 DeepSeek 的唯一出口：地址 `https://api.deepseek.com`、模型 `deepseek-flash` 写死在 `shared/ai/deepseek.ts`，界面不能改。对话和识别用 `/chat/completions`（流式、工具调用，思考档位关、低、高、最高），联网 `/v1/tools/search`、`/v1/tools/fetch`，语音 `/v1/tools/asr`、`/v1/tools/tts`，另有文件接口。回来的 JSON 都经 `transport.ts` 的 `readShaped` 按结构核对，不合报“格式不对”。另管密钥设置、提示词库（`createPromptManagers`；默认内容由用它的模块给：识别的在 `server/import/default-prompts/`，助手的在 `server/assistant/default-prompt.ts`）。没有页面，设置页在前端-管理' },
  { name: '系统资料', paths: ['server/system/'], allow: ['基础', '共用-基础', '共用-系统资料'],
    what: '给助手和管理员查的只读资料：运行日志、读程序代码、使用手册（`GET /api/guide`）；只有助手和装配在用（出错记录是请求关卡和页面上报写的，留在基础）' },
  // 业务主线只能往下：客户产品订单 ← 采购库存 ← 单据流转 ← 删除归档 ← 订单服务 ← 业务总览
  { name: '客户产品订单', paths: ['server/sales/'], allow: ['基础', '共用-基础', '共用-业务'],
    what: '客户和收货厂区、产品和普通订单读写（`sales(store)`）、查重、唛头资料；地址 `/marks`、`/products/:id/marks`' },
  {
    name: '采购库存',
    paths: ['server/operations/'],
    allow: ['基础', '客户产品订单', '共用-基础', '共用-业务'],
    what: '供应商、采购单、库存品和流水、订货单的表、写入规则、基本视图和订料进度（只有自己的数据）；轻量只读 `lookups.ts`（版本号和余额、一笔流水的范围、负库存等）；地址只有 `/suppliers`',
    layerNote: '`ledger/` 放写流水、采购明细和版本号的 `ledger.ts`，三类记录都要用的读取 `repository.ts`，库存品规格，写入共用的权限和版本核对；根目录放服务、路由和删除登记',
    // 层名不用模块名，免得被当成跨模块的层
    layers: [
      { name: '账和读', paths: ['server/operations/ledger/'] },
      { name: '库存品和订货单', paths: ['server/operations/stock/', 'server/operations/batches/'] },
      { name: '采购单', paths: ['server/operations/purchases/'] },
      { name: '服务和路由', paths: ['server/operations/router.ts', 'server/operations/deletion.ts', 'server/operations/service.ts'] },
    ],
  },
  {
    name: '单据流转',
    paths: ['server/flow/'],
    allow: ['基础', '客户产品订单', '采购库存', '共用-基础', '共用-业务'],
    what: '到货、生产任务、完工、送货、采购退货、排程、成品批次、订单状态和已发数量的派生、管理员改数据的连带；采购单、库存品、流水、订货单的完整视图（`FlowService.views`）和保存入口（`FlowService.stock`）；地址 `/flow`、`/purchases`、`/warehouse`、`/order-batches`；单据轻量只读 `document-lookups.ts`',
    layerNote: '`documents/` 放单据的存取、读、关联，财务只读窗口 `finance-facts/` 也在这层。`rules/` 放核对、预览、确认、撤销、订单进度、管理员连带和 `FlowService`；按种类的核对 `FlowService` 要用，也放这里。`stock/` 放采购单、库存品、流水、订货单的完整视图、保存入口、成品批次。`correction/` 放三种更正和编辑说明。根目录放路由、删除登记和跨种类的仓库台账 `daily.ts`',
    layers: [
      { name: '单据存取', paths: ['server/flow/documents/', 'server/flow/finance-facts/'] },
      { name: '规则和服务', paths: ['server/flow/rules/', 'server/flow/stock/'] },
      { name: '按种类', paths: ['server/flow/arrival/', 'server/flow/production/', 'server/flow/delivery/'] },
      { name: '更正', paths: ['server/flow/correction/'] },
      { name: '路由和台账', paths: ['server/flow/daily.ts', 'server/flow/deletion.ts', 'server/flow/router.ts', 'server/flow/stock-router.ts'] },
    ],
  },
  { name: '删除归档', paths: ['server/lifecycle/'], allow: ['基础', '客户产品订单', '采购库存', '单据流转', '共用-基础', '共用-业务'],
    what: '删除引擎（`/deletions`）、六类档案的归档恢复和什么时候不能归档（`/<档案>/batch`）、按类型读六类档案（`records.ts`）；没有自己的表' },
  { name: '订单服务', paths: ['server/orders/'], allow: ['基础', '客户产品订单', '采购库存', '单据流转', '删除归档', '共用-基础', '共用-业务'],
    what: '客户、产品、订单的保存入口和列表筛选，厂区移除与送货单解除引用、带进度的订单视图、订单状态动作和改单连带协调；地址 `/customers`、`/products`、`/orders`' },
  { name: '业务总览', paths: ['server/overview/'], allow: ['基础', '客户产品订单', '采购库存', '单据流转', '删除归档', '订单服务', '共用-基础', '共用-业务'],
    what: '今日和经营概况、关联记录和修改历史、按模块读记录（`module-records.ts`，数据管理和助手共用）' },
  { name: '财务', paths: ['server/finance/'], allow: ['基础', '单据流转', '共用-基础', '共用-业务', '共用-财务'],
    what: '财务事件、凭证账簿、往来、资金发票、费用资产工资、成本、结账报表。用单据流转只许经只读窗口 `financeFacts`（`module-narrow-refs.test.ts` 查），不调业务服务、不读业务的表；业务不调财务' },
  {
    name: '单据导出',
    paths: ['server/documents/'],
    allow: ['基础', '客户产品订单', '采购库存', '单据流转', '共用-基础', '共用-业务', '共用-单据'],
    what: '采购单、订货单、送货单的 Word/Excel，导出记录，模板设置。送货单材质楞型优先取已出库或留下的明细，待送货取产品档案；导出前核对在 `export-checks.ts`',
  },
  {
    name: '识别导入',
    paths: ['server/import/', 'server/inbox/'],
    allow: ['基础', '客户产品订单', 'AI接入', '单据流转', '共用-基础', '共用-AI', '共用-识别'],
    what: 'AI 导入工作区、订单和到货单识别、正式导入、收件箱和三家机器人',
  },
  {
    name: '数据管理',
    paths: ['server/admin/'],
    allow: ['基础', '采购库存', '单据流转', '删除归档', '订单服务', '业务总览', '识别导入', '共用-基础', '共用-业务', '共用-管理'],
    what: '初始化、本机管理员改业务数据、工作区管理；没有自己的表。命令入口 `DataManagementService.execute`；读记录在 `managed-records.ts`（录入结构 `inputSchemas`），保存在 `managed-save.ts`：补丁里录入结构不收的栏目拒收（明细、纸板资料也逐层查），照读出来原样带回的算出值（已发数量、金额）放过；已生效的单据只走说明编辑和更正。用识别导入只引类型：识别导入的管理对象由装配传进来',
  },
  {
    name: '助手',
    paths: ['server/assistant/'],
    allow: ['基础', '客户产品订单', 'AI接入', '系统资料', '采购库存', '单据流转', '删除归档', '订单服务', '业务总览', '财务', '单据导出', '识别导入', '数据管理', '*共用'],
    what: '对话内核、工具注册表和命令目录、确认卡片、长期记忆、看页面、语音',
  },
  { name: '装配', paths: ['server/'], allow: ['*'],
    what: '启动、挂路由、请求关卡、命令行入口，可以引用全部；只算服务端根目录的文件，新建的子目录要登记进别的模块' },
  { name: '共用-基础', paths: ['shared/core/'], allow: [],
    what: '前后端共用的基础代码，和服务端同一套分法；账号规则和接口表、全站页面地址册子 `shared/core/pages.ts` 也在这里' },
  {
    name: '共用-业务',
    paths: ['shared/business/'],
    allow: ['共用-基础'],
    what: '业务主线（客户产品订单到业务总览）的共用代码',
    layerNote: '和服务端业务主线的层对应：文件所在的子目录决定它的层。每层对应一个服务端模块，对应模块只能用同层和下层的文件。经 `shared/business/index.ts` 引的名字按来源文件算层，看不出名字的引用（`import * as`、不带名字的 `import(…)`）直接报。删除归档层放删除的请求和叫法（`deletion-*.ts`）、批量归档接口表 `lifecycle-api.ts`、能删能管的记录种类 `data-management-modules.ts`',
    layers: [
      { name: '客户产品订单', paths: ['shared/business/sales/'] },
      { name: '采购库存', paths: ['shared/business/operations/'] },
      { name: '单据流转', paths: ['shared/business/flow/'] },
      { name: '删除归档', paths: ['shared/business/lifecycle/'] },
      { name: '订单服务', paths: ['shared/business/orders/'] },
      { name: '业务总览', paths: ['shared/business/overview/'] },
    ],
  },
  { name: '共用-财务', paths: ['shared/finance/'], allow: ['共用-基础'], what: '财务的共用代码' },
  { name: '共用-单据', paths: ['shared/documents/'], allow: ['共用-基础', '共用-业务'], what: '单据导出的共用代码' },
  { name: '共用-AI', paths: ['shared/ai/'], allow: [], what: 'AI 接入的共用代码' },
  { name: '共用-系统资料', paths: ['shared/system/'], allow: [], what: '系统资料的共用代码' },
  { name: '共用-识别', paths: ['shared/import/'], allow: ['共用-基础', '共用-AI'], what: '识别导入的共用代码' },
  { name: '共用-管理', paths: ['shared/admin/'], allow: ['共用-基础', '共用-业务'], what: '数据管理的共用代码' },
  { name: '共用-助手', paths: ['shared/assistant/'], allow: ['共用-基础', '共用-业务', '共用-AI'], what: '助手的共用代码' },
  // 前端：和服务端同样分模块，能用的共用代码不超过服务端对应的模块；都不能引用服务端代码。
  { name: '前端-基础', paths: ['src/ui/'], allow: ['共用-基础'],
    what: '通用组件、请求、插槽、事件、样式变量；可请求账号接口，用 `/auth/state` 读取登录状态和更新页面凭证' },
  { name: '前端-系统资料', paths: ['src/system/'], allow: ['前端-基础', '共用-基础', '共用-系统资料'], what: '使用说明页' },
  { name: '前端-单据导出', paths: ['src/documents/'], allow: ['前端-基础', '共用-基础', '共用-单据'],
    what: '单据导出的前端：导出窗、模板设置、文件交付。排在业务下面（业务页面嵌它的导出窗），业务页面和助手经它的 `index.ts`、`pages.ts` 用；能用的共用代码不超过服务端单据导出' },
  {
    name: '前端-业务',
    paths: ['src/records/', 'src/recordkit/', 'src/flow/', 'src/warehouse/', 'src/operations/', 'src/editors/', 'src/marks/'],
    allow: ['前端-基础', '前端-单据导出', '共用-基础', '共用-业务', '共用-单据'],
    what: '业务主线（客户产品订单到业务总览）的页面合成的一个模块',
    layerNote: '按界面角色分层，只往下用：上层嵌下层的窗口，下层要打开上层的页面用页面地址，不引上层的代码。单据在采购仓储下面（采购、仓储页面要显示到货单、送货单，单据窗口用不着采购窗口），和服务端业务主线的顺序不同',
    layers: [
      { name: '业务公共件', paths: ['src/recordkit/', 'src/marks/', 'src/editors/'] },
      { name: '单据', paths: ['src/flow/'] },
      { name: '采购仓储', paths: ['src/operations/', 'src/warehouse/'] },
      { name: '页面', paths: ['src/records/'] },
    ],
  },
  { name: '前端-财务', paths: ['src/finance/'], allow: ['前端-基础', '共用-基础', '共用-财务'], what: '财务页面（单独打包）' },
  {
    name: '前端-识别',
    paths: ['src/import/'],
    allow: ['前端-基础', '前端-业务', '共用-基础', '共用-业务', '共用-AI', '共用-识别'],
    what: '识别导入的页面',
  },
  {
    name: '前端-管理',
    paths: ['src/admin/'],
    allow: ['前端-基础', '前端-业务', '共用-基础', '共用-业务', '共用-管理', '共用-AI', '共用-识别'],
    what: '数据管理页面，也放账号管理页、AI 接入的模型和提示词设置页、识别导入的消息接入设置页，所以还能用共用-AI、共用-识别；可请求账号接口',
  },
  {
    name: '前端-助手',
    paths: ['src/assistant/'],
    allow: ['前端-基础', '前端-业务', '前端-单据导出', '共用-基础', '共用-业务', '共用-AI', '共用-助手'],
    what: '助手的前端，直接用前端-单据导出；可请求账号接口',
  },
  { name: '前端-装配', paths: ['src/', 'src/mobile/'], allow: ['前端-*', '*共用'],
    what: '`src/` 根目录和手机导航：入口、导航、登录、账号菜单、设置总页、插槽装配，把各模块的页面装起来' },
];

/** 守模块规则的检查和各拦什么（写进生成的模块表）；tests/checks/ 下 module- 开头的检查都要登记在这里 */
export const moduleChecks: { file: string; blocks: string }[] = [
  { file: 'tests/checks/module-boundaries.test.ts', blocks: '只往下用、只走 `index.ts`、没有循环、模块内的层' },
  { file: 'tests/checks/module-api-owners.test.ts', blocks: '前端只请求能用的模块的地址；地址前缀归属 `apiOwners`' },
  { file: 'tests/checks/module-table-owners.test.ts', blocks: '表只由主人写，表的主人 `tableOwnerList`' },
  { file: 'tests/checks/css-modules.test.ts', blocks: '样式只用本模块和能用的模块的类名、本层和下层的' },
  { file: 'tests/checks/module-narrow-refs.test.ts', blocks: '财务经 `financeFacts` 读业务；订单服务调用 `updateProduct`，同一保存点同步成品库存' },
  { file: 'tests/checks/module-test-entries.test.ts', blocks: '测试只经入口引模块' },
  { file: 'tests/checks/module-names.test.ts', blocks: '登记用的模块名和模块表一致' },
];

/** 目录下的全部文件（跳过 node_modules），路径用正斜杠、从项目根目录写起 */
export const files = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? (e.name === 'node_modules' ? [] : files(dir + '/' + e.name)) : [dir + '/' + e.name],
      )
    : [];
/** 源码：TypeScript 和 JavaScript 都算（server/import/parse-worker.mjs 这类 .mjs 也是模块代码），类型声明不算 */
export const isCode = (f: string) => /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(f) && !/\.d\.[cm]?ts$/.test(f);
/** 模块代码：server、shared、src 下的全部源码 */
export const all = ['server', 'shared', 'src'].flatMap(files).filter(isCode);
/** 工具：scripts/ 下的脚本和根目录的配置文件，不属于模块，但引用模块时也查 */
export const tools = [...files('scripts'), ...readdirSync('.').filter((f) => /\.config\.[cm]?[jt]s$/.test(f))].filter(isCode);
/** 能被引用到的项目文件（含样式、数据等非代码文件），解析引用时用 */
const projectFiles = new Set([
  ...['server', 'shared', 'src', 'scripts', 'tests'].flatMap(files),
  ...readdirSync('.', { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name),
]);
/** 模块表、层表里的一项路径管不管这个文件：目录按前缀，单个文件要全名相同 */
export const covers = (p: string, f: string) => (p.endsWith('/') ? f.startsWith(p) : f === p);
/** 文件按最长前缀落到的那一项：模块和它登记的路径；不在任何模块的路径下（tests、根目录的配置）是 undefined */
export const matchOf = (f: string): { m: Rule; p: string } | undefined =>
  modules
    .flatMap((m) => m.paths.map((p) => ({ m, p })))
    .filter(({ p }) => covers(p, f))
    .sort((a, b) => b.p.length - a.p.length)[0];
/** 文件属于哪个模块；不在任何模块的路径下（tests、根目录的配置）是 undefined */
export const moduleOf = (f: string): Rule | undefined => matchOf(f)?.m;
/** 模块 from 能不能用模块 to（* 是全部，前端-* 是前端的全部，*共用 是共用的全部） */
export const canUse = (from: Rule, to: Rule) =>
  from.allow.includes('*') ||
  (from.allow.includes('前端-*') && to.name.startsWith('前端-')) ||
  from.allow.includes(to.name) ||
  (from.allow.includes('*共用') && to.name.startsWith('共用'));
/** 文件在模块的第几层（0 是最下层）；模块没分层、或文件没登记进任何一层是 undefined */
export const layerOf = (f: string, rule: Rule | undefined = moduleOf(f)): number | undefined => {
  const i = rule?.layers?.findIndex((l) => l.paths.some((p) => covers(p, f))) ?? -1;
  return i < 0 ? undefined : i;
};
/** server、shared、src 下的文件属于哪个模块；没登记进模块表就让测试失败 */
export const ownerModule = (f: string): Rule => {
  const m = moduleOf(f);
  if (!m) throw new Error(f + ' 没有登记进 tests/checks/module-map.ts 的模块表');
  return m;
};
export const inModules = (f: string) => /^(server|shared|src)\//.test(f);
/**
 * pages.ts 之外另立的按需加载入口：别的模块只用页面里的一小段、不该连带下载整套页面时才登记，写明理由。
 * 和 pages.ts 一样只许 import()、只列自己模块的东西。
 */
export const lazyEntries: { file: string; why: string }[] = [
  {
    file: 'src/finance/related-pages.ts',
    why:
      '订单、送货、到货详情里的财务段：业务页面用，走 pages.ts 会把整套财务页面一起下载；' +
      '在 pages.ts 里给整套页面再套一层 lazy 会让页面变成两层按需加载、入口名不对应实际组件，' +
      '新开一个顶层目录放一个组件又要把财务模块拆到两个目录，都比登记一个入口更绕',
  },
];
/** 按需加载的入口：各模块的 pages.ts 和上面登记的 */
export const isLazyEntry = (t: string) => /^src\/[a-z]+\/pages\.ts$/.test(t) || lazyEntries.some((e) => e.file === t);
/** 模块的对外接口文件：index.ts，按需加载的入口 */
export const isEntry = (t: string) => /^(server|shared|src)\/[a-z]+\/(index|pages)\.ts$/.test(t) || isLazyEntry(t);
/** 引用写法里 ? 和后面的部分（Vite 的 ?no-inline、?url 这类）不是文件名，解析时去掉；引用里照原样记 */
const withoutQuery = (spec: string) => spec.replace(/\?.*$/, '');
/** 相对路径 → 项目里的文件（.js 写法对应 .ts 源文件，目录对应 index.ts）；找不到返回 null */
export const resolve = (from: string, spec: string) => {
  const raw = posix.normalize(posix.join(posix.dirname(from), withoutQuery(spec))).replace(/\/$/, '');
  const stem = raw.replace(/\.(js|mjs|cjs|jsx)$/, '');
  return (
    [raw, stem + '.ts', stem + '.tsx', stem + '.mts', stem + '.cts', raw + '.ts', raw + '.tsx', raw + '/index.ts', raw + '/index.tsx'].find((c) =>
      projectFiles.has(c),
    ) ?? null
  );
};
export const scriptKind = (f: string) =>
  f.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.(js|mjs|cjs|jsx)$/.test(f) ? ts.ScriptKind.JS : ts.ScriptKind.TS;

/**
 * 一处引用。how：
 * - import：import、export ... from、import('x').类型（静态）
 * - import()、require：加载目标是能算出来的字符串（字面量、模板、拼接、同文件的 const）
 * - url：new URL('相对路径', import.meta.url) 指向代码文件（比如起 worker）
 * - path：脚本里写的项目路径 'server/xxx.ts'（起子进程、拼路径）
 * target：解析到的项目文件；null 是相对路径找不到文件。unresolved：加载目标算不出来，记下原文。
 * names：import { a, b } 引进来的名字、export { a, b } from 转出去的名字（都按对方导出的名字），import('x').A 的 A。
 */
export type Ref = {
  spec: string;
  target: string | null;
  how: 'import' | 'import()' | 'require' | 'url' | 'path';
  typeOnly: boolean;
  line: number;
  unresolved?: string;
  names?: string[];
};
const parsed = new Map<string, Ref[]>();

/**
 * 同一文件里只声明过一次、也没有同名参数或解构变量遮住的 const（算加载目标时可以代进去），
 * 和 createRequire 造出来的 require（换了名字也认）
 */
function declarations(source: ts.SourceFile) {
  const consts = new Map<string, ts.Expression | null>();
  const requireNames = new Set(['require']);
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const init = n.initializer;
      const isConst = !!(ts.getCombinedNodeFlags(n) & ts.NodeFlags.Const);
      consts.set(n.name.text, consts.has(n.name.text) || !isConst || !init ? null : init);
      if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'createRequire')
        requireNames.add(n.name.text);
    } else if ((ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) consts.set(n.name.text, null);
    ts.forEachChild(n, collect);
  };
  collect(source);
  return { consts, requireNames };
}

/** 算加载目标的字符串：字面量、模板、拼接、同文件的 const；算不出来是 null */
const evaluator = (consts: Map<string, ts.Expression | null>) => {
  const evaluate = (n: ts.Expression, depth = 0): string | null => {
    if (depth > 8) return null;
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) return evaluate(n.expression, depth + 1);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = evaluate(n.left, depth + 1);
      const b = a === null ? null : evaluate(n.right, depth + 1);
      return a === null || b === null ? null : a + b;
    }
    if (ts.isTemplateExpression(n)) {
      let s = n.head.text;
      for (const span of n.templateSpans) {
        const v = evaluate(span.expression, depth + 1);
        if (v === null) return null;
        s += v + span.literal.text;
      }
      return s;
    }
    if (ts.isIdentifier(n)) {
      const init = consts.get(n.text);
      return init ? evaluate(init, depth + 1) : null;
    }
    return null;
  };
  return evaluate;
};

const isImportMetaUrl = (n: ts.Node | undefined) =>
  !!n && ts.isPropertyAccessExpression(n) && ts.isMetaProperty(n.expression) && n.name.text === 'url';

/** 记一处引用要的东西；fromRoot：spec 是从项目根目录写的路径 */
type Found = { spec: string; how: Ref['how']; typeOnly: boolean; at: ts.Node; fromRoot?: boolean; names?: string[] };
/** 一个文件的取引用过程：记引用、记算不出来的加载目标、算字符串 */
type Collector = {
  source: ts.SourceFile;
  requireNames: Set<string>;
  evaluate: (n: ts.Expression) => string | null;
  add: (found: Found) => void;
  unresolved: (how: Ref['how'], at: ts.Node, expr: ts.Node) => void;
};

function collector(f: string, source: ts.SourceFile, out: Ref[]): Collector {
  const { consts, requireNames } = declarations(source);
  const lineOf = (at: ts.Node) => source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1;
  return {
    source,
    requireNames,
    evaluate: evaluator(consts),
    add: ({ spec, how, typeOnly, at, fromRoot = false, names }) =>
      void out.push({
        spec,
        target: fromRoot ? (projectFiles.has(spec) ? spec : null) : resolve(f, spec),
        how,
        typeOnly,
        line: lineOf(at),
        ...(names ? { names } : {}),
      }),
    unresolved: (how, at, expr) =>
      void out.push({ spec: '', target: null, how, typeOnly: false, line: lineOf(at), unresolved: expr.getText(source) }),
  };
}

/** import 语句：只引类型（import type，或者引的名字全是 type）算类型引用；记下引进来的名字 */
function importRef(n: ts.ImportDeclaration, spec: string, c: Collector) {
  const clause = n.importClause;
  const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
  const typeOnly =
    !!clause &&
    (clause.phaseModifier === ts.SyntaxKind.TypeKeyword || (!clause.name && !!named && named.length > 0 && named.every((e) => e.isTypeOnly)));
  const names = named?.map((e) => (e.propertyName || e.name).text);
  if (spec.startsWith('.')) c.add({ spec, how: 'import', typeOnly, at: n, names });
}
/** import、export ... from、import('x').类型：静态引用；认出来返回 true */
function staticRef(n: ts.Node, c: Collector) {
  if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
    importRef(n, n.moduleSpecifier.text, c);
    return true;
  }
  if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
    // export { a, b as c } from：记下按对方导出的名字（a、b）；export * 不记
    const clause = n.exportClause;
    const names = clause && ts.isNamedExports(clause) ? clause.elements.map((e) => (e.propertyName || e.name).text) : undefined;
    if (n.moduleSpecifier.text.startsWith('.')) c.add({ spec: n.moduleSpecifier.text, how: 'import', typeOnly: n.isTypeOnly, at: n, names });
    return true;
  }
  if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
    const names = n.qualifier ? [n.qualifier.getText(c.source).split('.')[0]] : undefined;
    if (n.argument.literal.text.startsWith('.')) c.add({ spec: n.argument.literal.text, how: 'import', typeOnly: true, at: n, names });
    return true;
  }
  return false;
}

/** 加载目标：相对路径算项目文件；包名、node: 内置是外部依赖，不管；绝对路径、file: 地址看不出是项目里的哪个文件，算看不出来 */
function load(c: Collector, how: Ref['how'], at: ts.Node, arg: ts.Expression | undefined) {
  if (!arg) return;
  const spec = c.evaluate(arg);
  if (spec === null || /^(\/|file:|[a-zA-Z]:[\\/])/.test(spec)) c.unresolved(how, at, arg);
  else if (spec.startsWith('.')) c.add({ spec, how, typeOnly: false, at });
}
const isRequireCall = (n: ts.CallExpression, requireNames: Set<string>) =>
  (ts.isIdentifier(n.expression) && requireNames.has(n.expression.text)) ||
  (ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) &&
    requireNames.has(n.expression.expression.text) &&
    n.expression.name.text === 'resolve');

/** import()、require、new URL(…, import.meta.url)：运行时加载；认出来返回 true */
function dynamicRef(n: ts.Node, c: Collector) {
  if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
    load(c, 'import()', n, n.arguments[0]);
    return true;
  }
  if (ts.isCallExpression(n) && isRequireCall(n, c.requireNames)) {
    load(c, 'require', n, n.arguments[0]);
    return true;
  }
  const target = ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'URL' ? n.arguments : undefined;
  if (!target || !isImportMetaUrl(target[1])) return false;
  // 文件地址：指向代码文件的算引用（比如起 worker），指向目录、模型、数据等资源的不算
  const spec = c.evaluate(target[0]);
  if (spec === null) c.unresolved('url', n, target[0]);
  else if (isCode(withoutQuery(spec))) c.add({ spec, how: 'url', typeOnly: false, at: n });
  return true;
}

/** 脚本里按项目路径写的文件（起子进程、拼路径），从项目根目录算 */
function projectPathRef(n: ts.Node, c: Collector) {
  if (!ts.isStringLiteralLike(n) || !/^(server|shared|src)\/[\w./-]+\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(n.text)) return;
  const parent = n.parent;
  const isSpecifier = (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === n;
  if (!isSpecifier) c.add({ spec: n.text, how: 'path', typeOnly: false, at: n, fromRoot: true });
}

/** 入口文件 export { a, b as c } from './x' 转出去的名字 → 来源文件（c 对应 x）；别的模块经入口引的名字按来源文件算层 */
export function exportSources(entry: string, text?: string): Map<string, string> {
  const source = ts.createSourceFile(entry, text ?? readFileSync(entry, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(entry));
  const out = new Map<string, string>();
  for (const n of source.statements) {
    if (!ts.isExportDeclaration(n) || !n.moduleSpecifier || !ts.isStringLiteral(n.moduleSpecifier)) continue;
    const target = resolve(entry, n.moduleSpecifier.text);
    if (target && n.exportClause && ts.isNamedExports(n.exportClause))
      for (const e of n.exportClause.elements) out.set(e.name.text, target);
  }
  return out;
}

/** 用 TypeScript 自己的解析器取一个文件的全部引用（text 不给就读文件并记住结果；回归测试直接喂样例） */
export function refsOf(f: string, text?: string): Ref[] {
  const cached = text === undefined ? parsed.get(f) : undefined;
  if (cached) return cached;
  const source = ts.createSourceFile(f, text ?? readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(f));
  const out: Ref[] = [];
  const c = collector(f, source, out);
  const visit = (n: ts.Node) => {
    if (!staticRef(n, c) && !dynamicRef(n, c)) projectPathRef(n, c);
    ts.forEachChild(n, visit);
  };
  visit(source);
  if (text === undefined) parsed.set(f, out);
  return out;
}
