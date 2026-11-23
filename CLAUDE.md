@AGENTS.md

## Claude Code 专用

项目规则只写在上面的 AGENTS.md，三家（Claude Code、Codex、Antigravity）共用 `.claude/` 这一套环境。这里只放 Claude Code 自己的配置说明。

- `.claude/settings.json` 的钩子会拦下读写真实数据（`data/`、`backups/`、`%LOCALAPPDATA%\ZhixuERP`）、密钥、`.env` 和覆盖 `dist` 的构建。被拦就换做法，不要绕过。命令行里只是文字提到 `data/` 也会被拦，这时改用 Write / Edit 工具写文件。拦哪些写法见 `.claude/子智能体须知.md`“钩子会拦什么”。
- `.claude/settings.json` 的 `permissions.ask` 让推送、打标签、GitHub 发布、打补丁、打包先弹确认；本机提交不弹确认（方便几路并行时合并），但什么时候提交仍照 AGENTS.md“用户说了才能做”。发布用 `/release 版本号`，只在用户说要发布时用。
- 界面实测用 `ui-check` 技能（`scripts/ui-check/preview.mjs`、`shot.mjs`）；内置浏览器 `preview_start` 的配置在 `.claude/launch.json`（见 `ui-check` 技能“给用户看”）。
- 改完业务代码、收尾汇报前，用 `erp-rules-reviewer` 子智能体按项目规则查一遍。
- 派子智能体时，派工说明里写“先读 `.claude/子智能体须知.md`”，项目特有的规矩和做法都在那里。
