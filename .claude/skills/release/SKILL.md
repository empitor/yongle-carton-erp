---
name: release
description: 发布新版本：检查、改版本号、整理更新记录和发布说明、提交、给根目录各项标备注、打标签推送、Linux 上测试和打包、GitHub 发布、上服务器并核对。只在用户说要发布时由用户手动调用。
argument-hint: <版本号，如 0.9.6>
disable-model-invocation: true
---

# 发布 $ARGUMENTS

用户手动调用这个技能，就是授权这一次的提交、打标签、推送、GitHub 发布和上服务器。推送、打标签、GitHub 发布、打补丁、打包时会弹出确认（本机提交不弹），属于正常现象。补丁和整包的原理见 `docs/部署与运维.md`“升级”。

## 0. 先定版本和走哪条路

- 没给版本号时先问用户。修 bug 加最后一位，加功能加中间一位。
- **补丁还是整包：** 依赖没变的小版本走补丁；大版本或 `package-lock.json` 里的依赖变了，补丁装不了依赖，走整包。拿不准时 `npm run patch-server -- --dry-run` 会直接说。
- 用 `git log --oneline v上一版..` 和 `git status` 看清这一版包含什么。

## 1. 检查（任何一项失败就停，修好再来）

- 开发机上 `npm run check`（类型、代码检查、完整测试、覆盖、发布检查、构建到临时目录）。串行组 `tests/serial/start-system.test.mjs` 偶尔有时序抖动，单独重跑通过才算。
- 这一版改了界面就跑全部的 `npm run test:ui`（不带组名）。
- 不要跑 `npm run build`，正式实例可能在用 `dist`。
- 自己的检查不放在 GitHub 上跑；Linux 上的测试在第 4 步、服务器上做。

## 2. 改版本号和更新记录

- `npm version $ARGUMENTS --no-git-tag-version`（改 `package.json` 和 `package-lock.json`，不提交、不打标签），再把 `shared/core/version.ts` 的 `APP_VERSION` 改成同一个（`tests/app-version.test.ts` 核对三处一致）。
- `docs/CHANGELOG.md` 只有一节，这一节就是这次的发布说明（规矩见 AGENTS.md“文档怎么维护”）。把标题“## 未发布”改成 `## $ARGUMENTS · 今天日期`，内容整理成用户看得懂的发布说明：一段概述、各项改动；写清怎么升级：补丁以哪个安装包为基线，或这一版只能整包；末尾固定一句“升级办法见 `docs/部署与运维.md`”。下载、部署、已知限制不写进来（已知问题在 `docs/路线图.md`）。
- 跟着版本走的文档一起改：`README.md` 的当前版本和下载的版本、`docs/路线图.md` 开头的现状、`docs/部署与运维.md`“当前服务器”和安装包版本。
- `docs/` 只放行根目录的文档、`docs/架构/` 和商标，用 `git status --ignored docs/` 看有没有漏掉要进仓库的文档。
- 改完再跑一次 `npm run check`。

## 3. 提交、标备注、打标签、推送

- 提交说明：第一行 `发布 $ARGUMENTS：一句话概括`，下面每行一个用户看得懂的改动点（以 `- ` 开头）。**不加 `Co-Authored-By` 之类的合作者行。** `git add` 只加这一版的文件，不用 `git add -A`。
- 给 GitHub 文件列表标备注：`node scripts/root-notes.mjs --commit $ARGUMENTS`。它先用一次提交把根目录每一项都动一下，再一项一次提交恢复原样，提交说明就是这一项的作用（清单在脚本里，根目录加了新东西要先补清单，`tests/root-notes.test.mjs` 会拦）。做完内容和之前一字不差。
- `git tag -a v$ARGUMENTS -m "发布 $ARGUMENTS"`（标签打在标完备注的最后一次提交上），`git push origin main v$ARGUMENTS`。

## 4. Linux 上测试；整包时打 Linux 包

在服务器的打包目录里做，命令见 `docs/部署与运维.md`“打包和 Linux 验证”：取标签的源码、装依赖、`CI=1` 跑 `npm test` 和 `npm run test:release`。不过就停，修好重新发。

- **整包：** 接着在那里 `npm run package -- --target linux-x64`，照“装之前验包”验一遍；Windows 包在开发机上 `npm run package -- --out <项目外的目录>`。
- **补丁：** 测试过了就行，不用打包。

## 5. GitHub 发布

- 把 `docs/CHANGELOG.md` 那一节的内容（不含标题行）存成临时文件，`gh release create v$ARGUMENTS --title "v$ARGUMENTS：一句话概括" --notes-file <这个文件>`，设为最新版本，用完删掉临时文件。附上：
  - **整包：** 两个安装包（`linux-x64.tar.gz`、`win-x64.zip`）和各自的 `.sha256`。
  - **补丁：** 先生成发布补丁，基线是服务器上解压好的上一个整包（现在是 `/home/ubuntu/build/base-v0.9.5/yongle-carton-erp-v0.9.5-linux-x64`，出了新的整包就换成新的）：`npm run patch-server -- --base <基线目录> --out <临时目录>`；附上生成的补丁、执行补丁的三个脚本（`apply-patch.mjs`、`patch-logic.mjs`、`patch-rollback.mjs`，要放在同一目录运行）和各自的 `.sha256`。

## 6. 上服务器

- **补丁：**
  1. `npm run patch-server -- --dry-run`：列出要传的文件，确认范围合理。
  2. `npm run patch-server`：正式打。脚本先做发布检查（工作区干净、当前提交有 `v` 标签且 GitHub 上一致），不满足就拒绝。
  3. `npm run patch-server -- --check`：本机、GitHub、服务器三方一致，退出码 0 才算完成。
  - SSH 断了不用慌：补丁在服务器上照常跑完，按脚本打印的办法查 `apply.log`，再跑一次 `--check`。失败或自动回滚：照日志说明处理，告诉用户发生了什么。用户没说，就不用 `--hotfix`。
- **整包：** 照 `docs/部署与运维.md`“整包”：先完整备份、停服务、换 `/opt/yongle-carton-erp`、启动，再查健康（`curl -fsS http://127.0.0.1:3001/api/health`）和版本（`/opt/yongle-carton-erp/.release-package`）。换下来的旧程序目录留到确认新版本正常再删。把新包解压一份到 `/home/ubuntu/build/base-v$ARGUMENTS/` 当以后补丁的基线，并改上面第 5 步里的基线路径。

## 7. 汇报

用简体中文说清楚：版本号、提交和标签、GitHub 发布链接、服务器核对结果，以及没做或没验证的事。同一轮把 `docs/部署与运维.md`“当前服务器”等文档对上现状。提醒用户：本机正式实例要“停止系统 / 启动系统”后才用上新版本，不要替用户重启。
