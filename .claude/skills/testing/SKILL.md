---
name: testing
description: 写测试、跑测试和交之前自查时照着做：点名跑哪些、怎么写、用哪份准备代码、外壳实测的界限、交之前要另外起的检查。写或改测试、跑检查、收尾交活之前使用。
---

# 测试

测试的通用做法（守什么、在哪一层测、不靠真实时间、互不影响、为了能测动产品代码、测试数据、怎么跑、慢的和测不到的）见技能 test-writing，这里只写本项目的。相关的见 `docs/架构/代码检查.md`（全部体检 `npm run check` 跑哪几步、各项检查管什么、例外怎么登记、两个外壳的检查）。每个检查文件开头写清它拦什么。

## 测试怎么跑

- **改的过程中：** 点名跑：`npm test -- tests/<大类>/<a>.test.ts tests/<大类>/<b>.test.ts`，带超时如 `timeout 180 npm test -- …`。想快就对单个目录跑 `npx eslint <目录>`。
- **按改动挑测试：** `npm run test:related`。
- **界面：** 改了界面跑相关的浏览器流程（如 `npm run test:ui -- production`，`--list` 看有哪些组，`a11y` 组查无障碍），全部流程发布前跑。几路同时跑时要错开端口（写法见技能 ui-check）。
- **外壳：** 改了 `apps/` 跑 `npm run check:apps`。
- **收尾：** 跑一次 `npm run check`。类型检查 `npx tsc --noEmit`，构建检查 `npx vite build --outDir <临时目录> --emptyOutDir`。
- **分组并行：** `npm test` 由 `scripts/run-tests.mjs` 分组跑（默认按 CPU 数、最多 8 组，`TEST_JOBS` 可改），按上次记下的每份文件用时装箱，所以同一份文件不一定每次在同一组。怀疑互相影响用 `npm run test:isolated` 对照。测试进程的 `LOCALAPPDATA`、`ERP_CONFIG_DIR`、`XDG_CONFIG_HOME`、`DB_PATH`、`ERP_BACKUP_DIR` 都指向新建的临时目录。
- **慢测试：** 单条上限 1 秒，单独重跑计时用 `scripts/test-slow.mjs`（串行、一轮最多 6 份、最慢的先判）；服务器上跑 Linux 测试时设 `CI=1`，只报不拦。
- **覆盖：** `npm run test:coverage` 按文件报 `server/`、`shared/` 的行覆盖，低于 80% 的拦下。
- **例外登记：** 快不了、测不到的登记在 `scripts/test-exemptions.mjs` 写原因。
- **套件与目录：** `tests/release/` 发布检查（含要起构建、打包进程的，`npm run test:release`），`tests/serial/` 串行组（启动器验收），`tests/fixtures/` 只放数据（结构快照、配置库基线快照、公开格式样例、升级样例）。主套件按 12 个家族分子目录：`tests/support/`（跨家族准备代码和替身）、`tests/checks/`（结构检查和它们的辅助）、`tests/core/`（基础、账号、系统资料）、`tests/ai/`（AI 接入）、`tests/business/`（业务主线六层）、`tests/finance/`（财务与财务专用夹具）、`tests/documents/`（单据导出）、`tests/import/`（识别导入、收件箱、机器人）、`tests/admin/`（数据管理、系统维护、初始化）、`tests/assistant/`（助手）、`tests/app/`（装配与前端基础）、`tests/flows/`（跨家族整条链路）。运行器只认 `.test.ts`、`.test.mjs`。
- **在哪台机器上跑：** 自己的检查不放在 GitHub 上跑（那边的机器慢，靠时间的测试会误报；GitHub 自带的代码扫描照常）。Windows 在开发机上跑 `npm run check`；Linux 在服务器的打包目录里、打包之前跑测试（相关的见 `docs/运维/打包和客户端更新.md`）。界面流程 `npm run test:ui` 只在开发机上跑，各组的流程登记在 `scripts/ui-check/run.mjs`。红了先修，不接着发布。
- **模块的入口：** 管到服务端的基础、账号、客户产品订单、采购库存、单据流转、订单服务、财务，以及共用业务；要测内部件的在 `tests/checks/module-test-entries.test.ts` 的 `moduleTests` 登记原因。单据视图按种类收窄用 `tests/support/read-result.ts` 的 `viewAs`。测跨模块登记规则要加载负责登记的模块（如测删订单先 `import '../../server/import/index.js'`）。普通订单读写直接测 `sales(store)`；测订单进度和改单、改产品的业务连带从订单服务入口走。`tests/business/read-counts.test.ts` 核对一批订单的进度查询条数。

## 测试怎么写

通用写法见技能 test-writing；本项目另有：

- **全覆盖的口径：** 助手的六条界限每条都有测试守着。
- **不往共用登记表里加条目：** 不用 `registerVersionedSqlite` 加条目，真的规格也不行（生成行结构、基线快照检查、换回配置库都看这张表）；测位置规则用 `resolveHomes`，测换回把位置当参数传给 `revertConfigUpgrades`。

## 测试的准备代码

写测试要起服务、借账号、建档、造虚构数据或让财务“假装业务变了”时，读 `.claude/skills/testing/references/准备代码.md`（要什么用哪个、常用写法）。

## 外壳实测的界限

- **手机：** 只装、只操作测试版（包名 `cn.nbyongle.erp.test`），连电脑上虚构数据的预览实例；不碰手机上别的应用（微信、相册、文件管理器、系统设置），不改手机的任何设置；系统弹出的权限、安装确认不替用户点；手机锁屏了就停下报告。测试文件只放“下载”、名字以 `yongle-test-` 开头、测完删掉；查文件只按确切的文件名，不列出整个目录。
- **Windows：** 不运行安装包，不动 `%LOCALAPPDATA%\甬勒ERP测试`（钩子会拦），不改这台电脑的开机启动项；端到端测试会弹窗口、动鼠标、开一次默认浏览器，跑之前由主智能体问过用户。

## 交之前自查

1. 改了什么就点名跑哪几条（除界面流程和外壳检查，都在 `npm run check` 里；每条拦什么写在检查文件开头，守模块规则的几条相关的见 `docs/架构/模块规则.md`）：

   | 改了什么 | 点名跑 |
   |---|---|
   | 文件变长 | `tests/checks/file-size.test.ts` |
   | 加文件、目录、跨模块引用、地址、表、测试 | `tests/checks/module-boundaries.test.ts` 等模块检查 |
   | 改样式 | `tests/checks/css-modules.test.ts`、`tests/checks/css-order.test.ts` |
   | 改 `stylelint.config.mjs` 的断点规则 | `tests/checks/css-breakpoints.test.mjs` |
   | 改建表、加升级步骤 | `tests/checks/schema-constraints.test.ts`、`tests/core/schema-evolution.test.ts` |
   | 改升级步骤、配置库规格 | `tests/core/upgrade-step-samples.test.ts`、`tests/core/config-db-evolution.test.ts`、`tests/core/versioned-sqlite*.test.ts` |
   | 加页面、写地址、助手工具、按钮 | `tests/checks/feature-links.test.ts`、`tests/checks/feature-links-actions.test.ts`、`tests/checks/feature-links-senders.test.ts`、`tests/checks/feature-links-status.test.ts`、`tests/checks/feature-links-labels.test.ts` |
   | 改 `docs/功能/功能链路-*.md`，加改页面、地址、助手工具 | `tests/checks/feature-links-doc.test.ts` |
   | 改页面地址、导航或新增页面链接 | `tests/checks/page-hrefs.test.ts` |
   | 改助手工具、对话层 | `tests/assistant/command-directory.test.ts`、`tests/assistant/assistant-boundaries.test.ts` |
   | 改前端 | `tests/app/frontend-request.test.ts`、`tests/checks/ui-kit.test.ts`、`tests/checks/back-layers-registered.test.ts` |
   | 改给人看的文字 | `tests/checks/field-names.test.ts`、`tests/business/display-text.test.ts`、`tests/business/flow-words.test.ts`、`tests/admin/data-management-form.test.ts` |
   | 改单据字段、财务事件 | `tests/finance/finance-source-contract.test.ts`、`tests/finance/source-fingerprint-pinned.test.ts`、`tests/finance/finance-event-columns.test.ts` |
   | 改只读窗口、业务模块 | `tests/finance/finance-facts-<组>.test.ts`、`tests/finance/finance-read-counts-sources.test.ts`、`tests/finance/finance-read-counts-costing.test.ts`、`tests/finance/finance-unsynced-reversal.test.ts` |
   | 改数据管理模板、单据导出 | `tests/admin/data-management-template-fields.test.ts`、`tests/documents/document-field-names.test.ts` |
   | 改文档 | `tests/checks/doc-paths.test.ts`、`tests/checks/docs-structure.test.ts` |
   | 改文档、改标题 | `tests/checks/doc-section-refs.test.ts` |
   | 改建表（含注释）、配置库规格、`tests/checks/module-map.ts` | 先 `npm run docs:gen`，再跑 `tests/checks/docs-generated.test.ts` |
   | 改 `AGENTS.md`、`CLAUDE.md` | `tests/checks/rule-files-length.test.ts` |
   | 改钩子或命令审批配置 | `tests/checks/claude-hooks.test.mjs`、`tests/checks/claude-hooks-rules.test.mjs`、`tests/checks/claude-hooks-gaps.test.mjs`、`tests/checks/claude-hooks-fallback.test.mjs` |
   | 加测试、界面流程，改例外登记 | `tests/checks/test-suites.test.mjs`、`tests/checks/ui-check-groups.test.mjs`、`tests/checks/test-exemptions-current.test.mjs` |
   | 改 `scripts/linux/` | `tests/core/patch-rollback.test.ts`、`tests/release/patch-and-package.test.ts`、`tests/release/maintenance.test.ts`（命令见下一步） |
   | 改 `src/` 的引用关系 | `tests/release/first-screen-size.test.ts`（命令见下一步） |
   | 收尾 | `npm run lint:ratchet`、`npm run lint:css`、`npm run knip`、`npm run dup`（都在 `npm run check` 里） |
   | 改界面 | `npm run test:ui -- a11y`（不在 `npm run check` 里） |

2. 两条要另外起的：
   - 改 `scripts/linux/` 的补丁脚本、恢复备份的检查：`tests/core/patch-rollback.test.ts` 之外另跑 `node scripts/run-tests.mjs --release tests/release/patch-and-package.test.ts tests/release/maintenance.test.ts`。
   - 改了 `src/` 的引用关系（尤其把点了才用的窗口静态引进来）：`node scripts/run-tests.mjs --release tests/release/first-screen-size.test.ts`（要构建，几秒）；改名、新加这类窗口要更新测试里的 `NOT_IN_FIRST_SCREEN` 名单。
3. 检查该例外的、要自己写检查或工具的，在交接单单独列出，由主智能体定。
4. 给人看的文字对照 `docs/界面/叫法词表.md`。
5. 没有扫描所有给人看的文字的自动检查，也没有预置场景的测试数据（和一次截完指定页面的脚本）：靠上面的测试加人工对词表，场景自己在测试实例里造。
