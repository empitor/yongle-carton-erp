---
name: docs-writing
description: 写文档时照着做：每次改动更新哪份文档、现状待办和更新日志各写在哪、怎么写、新文档的格式和字数、谁在什么时候改、收尾前核对。写或改 docs/、AGENTS.md、CLAUDE.md、技能和审查员、更新日志、路线图之前使用；docs-updater 照这份改文档。
---

# 写文档

文档的通用做法（每次改动后改文档、门类、每份怎么写、开头格式、字数、能生成的就生成、地图怎么维护）见技能 docs-as-map，这里只写本项目的。

## 0. 谁在什么时候改

- 收尾的先后照 AGENTS.md 地图里收尾那一行；文档由 docs-updater（`.claude/agents/docs-updater.md`）照这份统一核对补齐。
- 几路并行时由 docs-updater 统一写，各路只在交接单里写“文档要改什么”。

## 1. 找出要改的文档

- **找法：** 照技能 docs-as-map“每次改动后改文档”；`apps/*/docs/` 只在外壳改了时看。
- **功能链路：** 功能、页面、地址、工具的对照手写在六份 `docs/功能/功能链路-*.md`（写法见技能 add-feature“功能链路表”）：`tests/checks/feature-links-doc.test.ts` 只核对页面、地址、工具还在、没漏写，说明文字对不对改了功能自己对一遍，docs-updater 收尾时核对。
- **生成的** `docs/生成/` 下的表结构、模块表：表和列的说明写在建表代码的注释里，模块写在 `tests/checks/module-map.ts`，改完跑 `npm run docs:gen`。这些说明属于代码，docs-updater 不改，写进汇报交给调用方。
- **怎么用** 写进 `docs/使用手册.md`（“使用说明”页和助手读的都是它）：用户看得见的用法变了就改。
- **待办** 分三份：`docs/计划/路线图.md`（1.0 前要做的）、`docs/计划/技术债.md`、`docs/计划/已知问题.md`；只留智能体要做的、代码层面没做的，要用户本人去做、去验的不写。
- **做完没发布的** 写进 `docs/CHANGELOG.md`，只有“未发布”一节；发布时整理成发布说明贴到 GitHub 发布页、同一次提交里清空（技能 release 做）。

## 2. 怎么写

照技能 docs-as-map“每份文档怎么写”。本项目有检查守两样：

- 指到的小节必须真有（`tests/checks/doc-section-refs.test.ts` 查）。
- 反引号里的 `server/`、`shared/`、`src/`、`tests/`、`scripts/`、`.claude/` 路径和 `docs/` 下的文档，还有 Markdown 相对链接指的文档，必须真实存在（`tests/checks/doc-paths.test.ts` 查）。

## 3. 加一份或删一份文档

- 门类只有 `架构`、`功能`、`界面`、`运维`、`计划`、`生成`（另有放商标原图的 `docs/brand/`）；`docs/` 根目录只留 `业务规则.md`、`CHANGELOG.md`、`使用手册.md`。
- 手写的每份 1500 到 5000 字（按字符算，换行按 LF），超过的在 `tests/checks/docs-structure.test.ts` 的 `overLimit` 登记字数和原因；往已登记的里加内容要同时删掉至少一样多的字，调高登记的字数算放宽检查。数字数：`node -e "const s=require('fs').readFileSync(process.argv[1],'utf8').replace(/\r\n/g,'\n');console.log([...s].length)" <文件>`。
- 加删文档时 AGENTS.md 地图跟着改，动了在汇报里写明；加了这一行超过 `tests/checks/rule-files-length.test.ts` 的上限，就停下交用户定，不调上限、不压别的条。

## 4. 收尾前核对

跑文档的检查：`npm test -- tests/checks/doc-paths.test.ts tests/checks/doc-section-refs.test.ts tests/checks/rule-files-length.test.ts tests/checks/docs-generated.test.ts tests/checks/docs-structure.test.ts`。
