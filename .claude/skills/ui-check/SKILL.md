---
name: ui-check
description: 改完界面后在真实浏览器里看效果：起虚构数据的预览实例（本机管理员模式或模拟从域名访问），用无头 Chrome 截图或走流程，必要时用内置浏览器给用户看。界面改动、删除和权限相关改动要“在真实浏览器里看过才算完成”时使用。
---

# 界面实测

AGENTS.md 要求界面改动在真实浏览器里看过才算完成。用下面这套隔离实例，不要连用户的正式实例（127.0.0.1:3001，那里是真实数据，只能在用户要求时只读查看）。

## 起预览实例

| 场景 | 命令 | 地址 |
|---|---|---|
| 一般界面（本机管理员） | `node scripts/ui-check/preview.mjs` | http://127.0.0.1:3199 |
| 模拟服务器上从域名访问（没有本机管理员，删除要超级管理员模式再输密码等） | `node scripts/ui-check/preview.mjs --remote` | http://127.0.0.1:3198 |
| 再起一个 | 上面任一条加 `--port <端口>` | 自定 |

- 在后台起（Claude Code 用 Bash 工具的 `run_in_background`，别的工具用各自跑后台命令的办法），等输出 `READY` 那一行或接口 `/api/auth/state` 能连上再继续。
- 数据是 `scripts/ui-check/server.mts` 造的虚构数据，账号也在那里（虚构管理员、虚构业务员、虚构出纳、只读的虚构只读），每次启动都是全新的。
- 前端源码改了会自动重建，刷新页面即可；**改了 server/、shared/ 要重启预览**，否则会报“接口不存在”或看到旧行为。
- 做过的操作会改掉预览里的数据（比如库存被送货用掉），要干净数据就重启。
- 同一端口不能起两个。3201 以下留给预览（3199、3198、3197）和样式比对（3195）；`npm run test:ui` 的各组用 3201 起的端口，几路同时跑时用 `npm run test:ui -- --port 4201 <组>` 指定起始端口错开。
- 预览的 AI 是模型替身：要让助手提出某个方案（比如删除），先往 `POST /__ui-check/replies` 发 `[{ message, toolCalls: [{ name, args }] }]` 排好下一次回复，再在页面上发消息（只有这种实例有这个入口，写法见 `scripts/ui-check/flow-operations.mjs`）。发 `{ recognition: { chunkDelayMs } }` 能让下一次识别的回复按块慢慢吐，用来看流式识别的进度（`scripts/ui-check/flow-intake.mjs`）。
- 自动流程：`npm run test:ui -- --list` 看有哪些组和各组走什么，改了哪块就跑哪组（写组名或组里任一流程名，如 `npm run test:ui -- production`）；不带组名跑全部，默认同时 6 组（`UI_CHECK_JOBS` 改），约三分钟。组表在 `scripts/ui-check/run.mjs` 的 `groups`，其中 `a11y` 组用 axe 查无障碍，登记（`scripts/ui-check/a11y-known.json`）之外的违规会失败。新界面要把检查写进对应组的 `flow-*.mjs`，别只留临时脚本。
- 流程中途出错时截图目录里留 `FAIL-<流程>-N.png` 和 trace（`npx playwright show-trace` 回放），每组的日志是 `group-<组名>.log`。

## 真实模型模式（会调用 DeepSeek、产生费用）

| 场景 | 命令 | 地址 |
|---|---|---|
| 连真实 DeepSeek | `node scripts/ui-check/preview.mjs --real-model` | http://127.0.0.1:3197 |
| 冒烟脚本自测（连假 DeepSeek，配置目录用临时目录） | `node scripts/ui-check/preview.mjs --real-model --fake-deepseek` | http://127.0.0.1:3197 |

- 业务数据照旧是每次新建的虚构种子；不装模型替身，`/__ui-check/replies` 不可用。
- 密钥由用户在这个实例的“设置 → API 配置”里填一次，加密存在测试专用的固定目录（和正式实例的配置目录分开、不在它里面，`preview.mjs` 自己拼路径），重启接着用。不读、不打印那个目录里的文件；启动日志只说“已保存密钥：是/否”。
- 全量场景测试：`node scripts/ui-check/real-suite.mjs`（用法写在文件开头：`--list` 只列场景，`--start --fake` 连假 DeepSeek 自测，`--start --yes` 连真实接口，`--approaches high,low` 选思考档位，`--repeat k` 跑几轮看稳不稳，`--rejudge <结果目录>` 不发请求按现在的判定重判）。连真实接口一遍几百上千次请求，跑之前由主智能体估好费用问用户。
- 冒烟：`node scripts/ui-check/real-smoke.mjs --yes [--port 3197] [--only chat,image]`。只走 HTTP、登录虚构管理员，测查余额、最短对话、虚构表格和 PDF 上传引用再删除、图片内联、录音识别、朗读、搜索、读网页；虚构文件当场现造。每项打印通过或失败和耗时，结尾打印一共发了几次请求。连真实 DeepSeek 前先问用户（预计不到 0.1 元）；连假 DeepSeek 自测不用 `--yes`。

## 截图看页面

```bash
node scripts/ui-check/shot.mjs "#warehouse?kind=finished" "#orders" --user 虚构业务员
```

- 默认连 3199、用虚构管理员；加 `--remote` 连 3198，`--port <端口>` 连别的实例，`--mobile` 用手机尺寸，`--full` 截整页，`--out 目录` 指定保存位置。
- 它打印截图路径、页面上的报错和控制台错误；打开截图亲眼看（Claude Code 用 Read 工具，别的工具用各自看图片的办法）。
- 要点按钮、填表、走完一条流程，就在草稿目录写个小脚本，复用 `scripts/ui-check/lib.mjs` 的 `openChrome`、`login`、`go`（先设 `UI_CHECK_PORT`，再动态 import lib.mjs）。按钮用 `getByRole('button', { name })` 找，弹窗用 `[role="dialog"][aria-modal="true"]`。打开助手用 `openAssistant`（等助手代码挂上页面再按，直接按 Ctrl+J 可能被吞）；等页面提示用 `notice(page, 文字)`（只认新出现的）；控制台报错用 `checkConsole` 记成问题，不只打印。
- 看深色：主题跟随系统只在打开页面时定一次，换了深浅要**重新载入页面**再截，不然截到的还是浅色。
- 从域名访问的实例（`--remote`）上，管理员改账号、AI 设置、提示词、消息接入、工具开关前要先进超级管理员模式（页面顶上的按钮或账号菜单“系统维护”，密码是虚构管理员的）。

## 给用户看

用户要亲眼看时，用工具自带的浏览器：Claude Code 的内置浏览器用 `preview_start`，选 `.claude/launch.json` 里的 `ui-preview`、`ui-preview-remote` 或 `ui-preview-real-model`（它自己起实例）；别的工具先照上面起好实例，用自带的浏览器打开上表的地址，没有内置浏览器的把地址告诉用户自己打开。浏览器面板被隐藏或卡住时，回到无头截图。

## 收尾

- 汇报时如实说明看了哪些页面、哪些步骤，哪些没看。
- 用完关掉预览实例（停掉后台任务）。
- 截图和临时脚本留在临时目录，不进仓库。
