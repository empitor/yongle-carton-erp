---
name: schema-change
description: 改数据库结构时照着一步步做：业务库加表、加字段、改约束或枚举，单据内容加字段或引用，配置库改表、新加配置库。动 server/core/schema/、配置库规格、单据结构之前使用。
---

# 改结构

0.9.0 已发布：第 20 版结构快照 `tests/fixtures/schema-v20.sql`、配置库基线快照（`tests/fixtures/config-db/` 下已有的）和已发布的升级步骤都不许改（检查和钩子会拦）；改结构只在末尾加编号的升级步骤并带数据样例。照下面的清单逐项做，漏了的多数会被检查拦下。

相关的见 `docs/架构/数据库升级.md`（怎么认版本、怎么升级、编号和每日清理）、`docs/架构/数据库约定.md`（STRICT、金额、编号、JSON 列、派生关系、表归哪个模块）。表和列的说明写在建表代码的注释里，`docs/生成/表结构.md` 从代码生成，不手改。表的说明写在建表语句前面的 `--` 注释，不进库结构，随时能改；列的说明写在括号里那一列前面，会存进库结构（结构比对连注释一起比），改已有表的列说明等于改结构，要带升级步骤（`scripts/docs-gen/sql-parts.ts` 开头）。

## 业务库加表或改字段

1. 在 `server/core/schema/steps.ts` 末尾加编号的步骤，照文件开头的规矩写：STRICT、枚举 CHECK、日期和 JSON 用 `server/core/schema/tables/checks.ts` 的片段、带 `version` 列的表有 `CHECK(version>=1)`。
2. 同一步把 `server/core/schema/tables/` 改成改完后的完整结构，`server/core/schema/version.ts` 的 `SCHEMA_LATEST` 加一。
   - 建表顺序：新库按 `server/core/schema/create.ts` 的分组顺序建表。客户及厂区、产品、订单及明细与唛头同归 `server/core/schema/tables/sales.ts`，按各自的分组建。
3. 带一份升级前后的数据样例 `tests/fixtures/upgrade-samples/v<版本号>.json`（写法见 `tests/core/upgrade-step-samples.test.ts` 开头，没有样例就失败）。自增表改名、删除另在 `tests/core/schema-evolution.test.ts` 的 `autoIncrementTableChanges` 登记。
4. 跑 `npm run schema:dump` 重新生成读库用的行结构（`server/core/schema/rows/business-db.ts` 等）；它最后导出第 20 版快照那步会报错退出，这是有意的。再跑 `npm run docs:gen` 重新生成 `docs/生成/表结构.md`（表和列的说明写在建表代码的注释里）。
5. 同步直接写 SQL 的地方：预览实例的种子 `scripts/ui-check/server.mts` 和测试里的插入语句（插入一律写列名）。
6. 业务库从 0.9.0 起不兼容更早的数据，不要新加“兼容老数据”的读取分支。读取规则改了、而库里可能留着现行程序不再写出的记录时，对应功能的测试里加直接改库造出老样子的用例。

## 新表另做

- 在 `tests/checks/module-table-owners.test.ts` 登记归哪个模块；新的后端地址前缀登记在 `tests/checks/module-api-owners.test.ts`。
- 在所属模块的 `deletion.ts` 登记删除和初始化规则：不登记的表删除时被拒、初始化测试会拦。新表的外键在删除引擎里要有处理。

## 枚举列

- 在 `tests/checks/schema-constraints.test.ts` 登记，所属模块要有同一份常量。

## 单据里的引用和字段

- 只在单据 JSON 里记的引用外键查不到，要登记规划规则。
- 加镜像外键列时，三处一起加：`server/flow/documents/document-store.ts` 的 `flowColumns`、建表的 CHECK、`server/flow/deletion.ts` 的镜像登记。
- 服务端往单据内容里加字段：
  1. 加进 `shared/business/flow/flow-document.ts` 的结构（没登记的字段写读都报错）。
  2. 在 `shared/business/flow/finance-source.ts` 的 `financeFieldClasses` 归类（算、说明、不算；漏了编译报错），财务要读的再加进 `financeSourceSchemas`。
  3. 新字段在各改写路径都要原样保留，相关的见 `docs/业务规则.md`。

## 配置库改表或字段

1. 在那个库规格的 `steps` 末尾加一步，同一步把 `create` 改成改完后的完整结构；已发布的步骤不许改。
2. 带数据样例 `tests/fixtures/upgrade-samples/<短名>/v<版本号>.json`。
3. 跑 `npm run schema:dump` 重新生成行结构 `server/core/schema/rows/config-db.ts`（经 `server/core/schema/rows.ts` 汇总），再跑 `npm run docs:gen`。

## 新加配置库

1. 登记短名、导出基线快照（新加配置库的新快照可以写，已有的不许改）、登记位置。
2. 确认 `server/maintenance.ts` 的 `loadConfigOwners` 加载了主人模块。
3. 在 `tests/core/backup-create.test.ts` 的登记测试补一行。

## 做完

- 测试和交之前自查照技能 testing；收尾照 AGENTS.md 地图里收尾那一行。
