@AGENTS.md

## Claude Code 专用

三家（Claude Code、Codex、Antigravity）共用 `.claude/` 这一套环境，规则只写在 AGENTS.md 和它指到的 docs。这里只放 Claude Code 自己的配置。

- 钩子配在 `.claude/settings.json`（新会话生效）。被拦就照提示换做法，不要绕过；命令行里只是文字提到 `data/` 也会被拦，这时改用 Write / Edit 写文件。
- `permissions.ask` 让推送、打标签、GitHub 发布、打补丁、打包、装依赖这类命令先弹确认；本机提交不弹确认（方便几路并行时合并），但什么时候提交仍照 AGENTS.md“碰不得的”。发布用 `/release 版本号`，只在用户说要发布时用。
- 界面实测用 `ui-check` 技能；内置浏览器 `preview_start` 的配置在 `.claude/launch.json`（见 `ui-check` 技能“给用户看”）。
- 收尾照 AGENTS.md 地图里收尾那一行（审查和更新文档派 `erp-rules-reviewer`、`docs-updater` 子智能体）。
- 派子智能体时，派工说明里写“先读 AGENTS.md 和这一块的文档”。
