---
name: add-feature
description: 加功能时照着一步步做：加页面、写地址（post、put、patch、delete）、加助手工具，以及要一起改、一起登记的地方。加改页面、后端写地址、助手命令之前使用；只加表和字段用 schema-change。
---

# 加功能

加页面、写地址、助手工具时，照下面的清单一起改、一起登记；漏了的多数会被检查拦下。加表或字段照技能 schema-change。

相关的见通用技能 code-discipline（先找现成的、一件事一条路）和 `docs/架构/模块规则.md`“写代码的本项目补充”、`docs/架构/服务端写法.md`（接口表、地址怎么注册）、`docs/架构/前端约定.md`、`docs/功能/助手卡片和界限.md`（六条界限、确认卡片）。

## 1. 先找现成的

功能、页面、地址、工具的对应登记在 `shared/assistant/ui-capabilities.ts`；写地址的业务动作在 `shared/assistant/ui-actions.ts`、`shared/assistant/ui-actions-system.ts`；工具目录在 `server/assistant/tool-catalog.ts`。先在这几处查有没有现成的，现有的能办到就改它，不另开相近的一条。

## 2. 页面

页面地址与导航只从 `shared/core/pages.ts` 出（检查守着）。一起改：

- `shared/core/pages.ts`：页面编号、中文名、分组、查询参数。
- `shared/assistant/assistant-navigation.ts`：助手页面说明，少一页编译不过。
- `src/Navigation.tsx`：图标和权限条件。
- `docs/使用手册.md`：“使用说明”页和助手的 `guide.read` 读的都是它。

## 3. 写地址（post、put、patch、delete）

- 每个写地址登记成一条业务动作、只属于一条：在 `shared/assistant/ui-actions.ts`（账号、助手、设置、数据管理在 `ui-actions-system.ts`）写明哪种记录、什么动词、按钮文字、写地址和预览地址、服务函数、助手命令。
- 前端只由一个 `*-api.ts` 发；同一种记录的同一个动词已有动作就用它，不另开地址。
- 新地址前缀登记在 `tests/checks/module-api-owners.test.ts` 的 `apiOwners`。

## 4. 助手工具

人能在界面上做的业务功能，助手同一轮也要能做。

1. 在 `server/assistant/tools/` 对应的领域文件里定义一次；名字加到 `server/assistant/tool-catalog.ts` 顺序表末尾；在 `server/assistant/plugins.ts` 的分组表补一行（查不到会报错）；在 `shared/assistant/ui-capabilities.ts` 登记（每个工具只出现一次）。
2. 写说明，不超过 200 字：第一句写成“短名字：什么时候用”，后面一两句说办什么、参数各一句；命令怎么用只写在说明里，不写进提示词，权限和实现细节不写。短名字怎么用相关的见 `docs/功能/助手命令.md`。
3. 登记写入方式：写入一律出确认卡片，写明动的是哪条记录、每个变了的字段；业务类有方案生成器就自动出，流程类在 `server/assistant/chat/workflow-cards.ts` 或 `server/assistant/chat/workflow-direct.ts` 登记一处。哪些算写入、卡片写什么相关的见 `docs/功能/助手卡片和界限.md`。
4. 放在哪：新命令默认进命令目录；要常驻成原生工具的才加进 `server/assistant/command-directory.ts` 的 `commonCommands`（少加，每加一条每次请求多发它的参数结构）。只给超级管理员的加进 `server/assistant/tool-registry.ts` 的 `superAdminTools`。
5. 不给 `server/assistant/chat/` 加猜用户意思、按字眼放行或拦截、改写模型回答的规则。
6. 要在和人一样的前提下真能跑通（比如普通账号、订单已关联生产任务），不能只看文档或工具名；拿不准就在临时目录写探针、用 `:memory:` 加虚构数据试。

## 5. 功能链路表

每个功能走哪个页面、哪些后端地址、哪个服务函数、助手用哪些工具，手写在 `docs/功能/` 的六份 `功能链路-*.md`（档案和订单、库存和单据、识别导入、财务、账号设置系统、助手）；改了功能跟着改那一行。机制相关的见 `docs/架构/总览.md`，表相关的见 `docs/生成/表结构.md`，怎么操作相关的见 `docs/使用手册.md`。表的写法：

- **地址**都在 `/api` 下，表头写了“后端地址（`/finance` 下）”的再接上它；只列主要的。参数和回答看接口表 `shared/<模块>/*-api.ts`（财务是 `shared/finance/finance-api-*.ts`）；回文件、收原始字节、边算边推的地址不在接口表，直接用 express 注册。
- **地址缩写：** `a|b` 是同一前缀下的几个（`/x/a|b` 即 `/x/a`、`/x/b`）；`{a|b}` 换中间一段；紧跟在地址后面括号里以 `/` 开头的接在这个地址后面（`/inbox`（带 `/:id`））；`/purchases/:id/` 同四个，是照搬前一个地址的那几个结尾；`<模块>` 是一段换着写的名字。前面写了 `GET`、`POST` 的就是那个请求方法。
- **页面**写 `#页面`、带参数写 `#页面?参数=值`；**助手工具**列只写工具目录里的名字，`order_import.list|get` 同样缩写。
- **助手写入**一律出确认卡片，表里不再注明；直接执行的几类相关的见 `docs/功能/助手卡片和界限.md`“确认卡片”。
- 每张表都要有“后端地址”“助手工具”两列（按表头文字找列，不按第几列；表头下一行是 `|---|`）。
- `tests/checks/feature-links-doc.test.ts` 核对表和代码：页面、工具、地址（连同写了的方法）都还在，每个登记页面、每个工具至少写进一份。

## 6. 做完

- `tests/checks/feature-links.test.ts` 查登记和代码一致；功能链路表照上一节改，`tests/checks/feature-links-doc.test.ts` 核对。
- 界面改动在真实浏览器里看过才算完成（技能 ui-check）；测试和交之前自查照技能 testing；收尾照 AGENTS.md 地图里收尾那一行。
