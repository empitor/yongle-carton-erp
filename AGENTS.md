# 甬勒纸箱厂 ERP

宁波甬勒包装制品有限公司的纸箱厂 ERP。对用户始终用简体中文。这里是目录，按“做什么读哪份”去读具体那份。没读过的模块不动手改；只关系到代码怎么写的自己定、汇报里说明；业务事实（税率、账期、流程）和不可逆的动作问用户，不猜。

## 常用命令

- 点名跑测试：`npm test -- <文件>`；全部体检：`npm run check`。
- 类型检查：`npx tsc --noEmit`；构建检查：`npx vite build --outDir <临时目录> --emptyOutDir`。
- 改了建表（含注释）、配置库规格、`tests/checks/module-map.ts`：`npm run docs:gen` 重新生成 `docs/生成/`。

注意：

- 搜代码只在 `server/ shared/ src/ tests/ scripts/ docs/` 里搜；找文档引用用 `git grep`（可以全仓库）。不以项目根目录（或没写明的当前目录）为来源复制、移动、同步，要副本只拷点名的目录，带变量的复制命令先打印来源和去向。
- 自己写脚本加载 `server/` 之前，先把 `LOCALAPPDATA`、`ERP_CONFIG_DIR`、`DB_PATH`、`ERP_BACKUP_DIR` 都指到新建的临时目录。
- 不用 prettier：照现有写法（单引号、行宽约 100），只排自己改的几行。换行有 CRLF 有 LF，改文件用文件工具，用脚本时照原换行写回。
- Git Bash 会吃反斜杠：带正则、反斜杠、反引号、`$(…)` 的文字写成草稿目录里的文件再 `node <文件>` 跑。`npx` 只在项目根目录或两个外壳的工程目录里跑（别处会下载网上同名包）。

## 碰不得的

- 真实数据、正式实例、密钥文件、不许改的快照和检查配置：钩子会拦或先问，被拦就照提示换做法，不绕过。Codex、Antigravity 的钩子只拦不问：连正式实例、启停正式服务（含停本机的正式实例）、连真实模型、改检查配置会被直接拦下，要做先问用户，由用户自己做或换到 Claude Code 里做。
- 提交、推送、发布、装依赖、停止或重启正式实例、放宽或关掉检查、改本文件（随文档增删改地图那一行除外）：用户说了才做；不主动催提交，子智能体一律不提交。改完不用重启正式实例：改动留在项目文件里，下次启动自动生效。
- 密钥、Secret 和三家机器人的应用编号（企业微信 Bot ID、飞书 App ID、钉钉 Client ID）不写进代码、日志、审计、文档和聊天。
- 测试只用 `:memory:` 或临时目录配虚构数据，不用真实数据、真实客户文件和真实模型接口；真实客户文件不进仓库；发给真实模型前先问（外发文件、花钱）。
- 助手只守六条界限（`docs/功能/助手卡片和界限.md`），不加按字眼放行或拦截、改写模型回答的规则；加新界限先问用户。
- 不破解或读取微信、企业微信的本地聊天数据，不做 Hook 或规避检测。

## 做什么读哪份

| 要做的事 | 读 |
|---|---|
| 第一次接触这个项目 | `docs/架构/总览.md` |
| 改业务代码（server/、shared/、src/） | `docs/业务规则.md`，再加下面对应那块 |
| 写任何代码 / 加文件、目录、跨模块引用 | 通用技能 code-discipline 和 `docs/架构/模块规则.md`“写代码的本项目补充” / 通用技能 module-boundaries、模块规则整份、`docs/生成/模块表.md` |
| 写服务端代码 / 前端代码 | `docs/架构/服务端写法.md` / `docs/架构/前端约定.md` |
| 加表、字段、约束、配置库；写读写业务库的代码、改每日清理或取号；库打不开、升级报错 | `docs/架构/数据库约定.md`、`docs/架构/数据库升级.md`；改结构另照技能 `.claude/skills/schema-change/`、查 `docs/生成/表结构.md` |
| 加页面、写地址、助手工具；查一个功能走哪些页面、地址、服务函数、工具 | 技能 `.claude/skills/add-feature/`，接口另照通用技能 api-contract；按块查 `docs/功能/功能链路-档案和订单.md`、`docs/功能/功能链路-库存和单据.md`、`docs/功能/功能链路-识别导入.md`、`docs/功能/功能链路-财务.md`、`docs/功能/功能链路-账号设置系统.md`、`docs/功能/功能链路-助手.md` |
| 改客户、产品、订单和唛头 / 库存和采购 | `docs/功能/客户产品订单.md` / `docs/功能/库存.md` |
| 改到货、生产、完工、送货单据和订单进度 / 已生效单据的更正 | `docs/功能/单据流转.md` / `docs/功能/单据更正.md` |
| 改物理删除或初始化业务数据 | `docs/功能/删除和初始化.md` |
| 改财务怎么拿业务数据和补扫 / 记账、成本、结账和报表 | `docs/功能/财务取数和补扫.md` / `docs/功能/财务记账和结账.md` |
| 改识别导入（机器人、收件箱、识别、导入） | `docs/功能/识别导入.md` |
| 改助手怎么建和一轮怎么走、提示词 / 安全界限和确认卡片 / 助手命令 | `docs/功能/助手结构.md` / `docs/功能/助手卡片和界限.md` / `docs/功能/助手命令.md` |
| 改权限、账号、登录 | `docs/架构/账号和权限.md` |
| 改界面（含单据导出的版式、导出窗） | `docs/界面/总规矩.md`；写给人看的文字、用公共件、动样式和主题再读 `docs/界面/叫法词表.md`、`docs/界面/公共件.md`、`docs/界面/样式和主题.md`；看效果用技能 `.claude/skills/ui-check/` |
| 写测试、跑检查、交之前自查 | 技能 `.claude/skills/testing/`、`docs/架构/代码检查.md`，通用技能 test-writing、checks-as-firewall |
| 写文档、更新日志、路线图 | 技能 `.claude/skills/docs-writing/`、通用技能 docs-as-map；更新日志 `docs/CHANGELOG.md` |
| 用户看得见的用法 | `docs/使用手册.md` |
| 部署（含 AI 凭据和主密钥） / 升级 / 打包和客户端更新 / 备份恢复 / 排查（含账号密码、消息机器人、哪些不能删） | `docs/运维/部署.md` / `docs/运维/升级.md` / `docs/运维/打包和客户端更新.md` / `docs/运维/备份恢复.md` / `docs/运维/排查.md` |
| 发布 | 技能 `.claude/skills/release/`（只在用户说要发布时） |
| 改外壳（安卓、Windows）和网页之间的接点 | `docs/架构/外壳和网页.md`；外壳自己的见 `apps/android/docs/`、`apps/desktop/docs/` |
| 收尾 | 改完跑 `npm run check` → 改了业务代码（server/、shared/、src/）的派审查员 `.claude/agents/erp-rules-reviewer.md` 审 → 修完重跑 → `.claude/agents/docs-updater.md` 更新文档 → 收尾汇报；只改文档、测试、脚本的不派审查员。Codex、Antigravity 照这两份定义派 |
| 看还剩什么没做 | `docs/计划/路线图.md`、`docs/计划/技术债.md`、`docs/计划/已知问题.md`、`docs/计划/小改进.md` |

技能在 `.claude/skills/<名字>/SKILL.md`：Claude Code 自动发现，Antigravity 经 `.agents/skills.json`，Codex 照上表路径读。通用技能在用户目录：Claude Code、Antigravity 读 `~/.claude/skills/<名字>/SKILL.md`，Codex 读 `~/.agents/skills/<名字>/SKILL.md`；项目写得更具体的以项目为准。三家怎么接钩子见 `.claude/hooks/protect-real-data.mjs` 开头。
