# Windows / Linux 兼容与 0.8.1 发布前验收

日期：2026-11-07。基线：`1c8e22d`（0.8.0）。已有未提交单据模板改版和复审修复完整保留。

用户在 Docker Desktop 卸载后明确改用 WSL。先执行 `wsl --list --verbose`，发行版为 `Ubuntu-24.04`（WSL 2），系统实测 Ubuntu 24.04.5 LTS x64。Linux 源码白名单复制到 `/home/administrator/erp-validation-081/source`，独立安装依赖；没有在 /mnt/c 项目里安装依赖，没有复制或访问 Windows 业务数据和凭据。

所有测试均隔离 LOCALAPPDATA、ERP_CONFIG_DIR、DB_PATH，只用内存库或临时目录及虚构数据。不运行 npm run build、不覆盖仓库 dist、不启停 3001 正式实例、不调用真实模型。

## 实现范围

- Windows CurrentUser DPAPI 兼容旧无标记密文，新密文带算法版本；Linux AES-256-GCM，主密钥随机生成，目录 0700、文件 0600、当前服务账号所有，拒绝链接和损坏文件。启动先验证密钥权限，再打开业务库。主密钥不进业务备份、日志和审计。
- 平台配置目录与 ERP_CONFIG_DIR、ERP_BACKUP_DIR；AI 原件、提示词和工具配置跟随 DB_PATH。Linux 备份路径区分大小写，保留每日备份和离机复制。
- Linux 启停及维护脚本、专用服务账号安装器、systemd、journald、Caddy 示例；维护/代理双回环端口设计保持。
- Linux Noto CJK 字体检查和保守测宽；五纸型行数固定 6/11/11/24/14。单据模板改版、老模板兼容和超长拒绝逻辑保留。
- 两个平台分别安装生产依赖，内置对应 Node.js 24.15.0，生成 ZIP/tar.gz、sha256 和文件清单。版本与文档同步 0.8.1。

## 验证结果

| 检查 | Windows | Ubuntu 24.04.5 WSL |
|---|---|---|
| `npx tsc --noEmit` | 通过 | 通过 |
| `npm test` 主测试 | 729 项，725 通过、4 跳过、0 失败 | 729 项，726 通过、3 跳过、0 失败 |
| `npm test` 串行测试 | 9/9 通过 | 8/9 通过、1 跳过 |
| `npm run test:ui` | 真实 Chrome 全流程通过 | 真实 Linux Chrome 全流程通过 |
| 原生依赖 | canvas 中文绘制、sherpa addon 加载通过 | 相同检查通过 |
| 五纸型及超长拒绝 | Word/Excel 均通过 | Word/Excel 均通过 |
| 排版边界矩阵 | 605 组基准；383 组拒绝 | 605 组逐项比较通过；386 组拒绝，无比 Windows 更宽松的情况 |
| 最终包空目录验收 | 包内 Node 启动、虚构管理员登录、静态页面、订货单 24 行和送货单 6 行各导出 Word/Excel，通过 | 同样通过，实际使用 erp.sh |
| 最终包维护命令 | 备份、停止、恢复、重置密码通过 | 同样通过 |
| 无语音模型 | 缺模型有明确错误，其他功能可用 | 同样通过 |
| 实际包条目与清单 | 14,080 个文件/链接条目，一致；禁止内容 0 | 14,056 个文件/链接条目，一致；禁止内容 0；符号链接均在包内 |
| sha256 | 重算一致 | Linux 自检及复制回 Windows 重算一致 |
| 运维配置 | Windows CMD 的实际执行测试通过 | 两脚本 `sh -n`、systemd-analyze 静态校验、Caddy validate 通过 |
| 发布扫描 | `node scripts/release-audit.mjs` 通过，findings 为空，包含历史 blob 扫描 | 使用同一源码 |

Windows 跳过 Linux 专属的主密钥权限、链接、启动前拒绝及目录大小写用例，已在 Linux 执行。Linux 跳过两项 DPAPI、一项停止 CMD 和串行的真实 CMD 用例，均已在 Windows 执行。

Linux 首轮缺浏览器，安装 Chrome 后该项通过；并行重跑出现账号测试 ECONNRESET，请求辅助函数改为先读完响应体，随后全量通过，账号用例再连续三次各 13/13 通过。字体检查曾因 canvas 只登记 TTC 首个 JP 字体族而拒绝，补足字体族识别后通过。初版安装包检查脚本缺虚构采购行的 name/unit，补齐后最终两个原始压缩包重新解压验收全部通过。这些早期失败没有用于发布放行。

## 软件与产物

WSL 安装 fonts-noto-cjk，升级 ca-certificates、xz-utils、liblzma5；fontconfig 原已有。官方 Node 24.15.0 下载并按官方 SHASUMS256.txt 校验，在验证目录使用。Google Chrome 157.0.8103.38-1 连同 apt 的 72 个依赖安装。Caddy 2.6.2 仅下载解包校验，未安装或启动服务。具体版本、安装命令和依赖名单记录在 `docs/codex/Linux兼容与0.8.1发布结果.md`。

| 文件 | 大小（字节） | sha256 |
|---|---:|---|
| yongle-carton-erp-v0.8.1-win-x64.zip | 110277655 | aac0ee897c02c618cca499017a05f58f18157f2fc622d0966b6b850150e23831 |
| yongle-carton-erp-v0.8.1-linux-x64.tar.gz | 114122700 | 6d10f2b433fad5348f7e9d392d0258fc5473494b76369094bad81c2b91880204 |

两包程序源码摘要一致：`1ebbbe8b08f0dd1b76a90b7d55c3875e08ef585e42b24b33c371a158ce42efea`。23 个前端产物逐文件摘要一致。

Windows 日志/安装包/清单位于系统临时目录 `erp-081-263504db461b418391a23a34a92d784d`；Linux 日志位于 `/home/administrator/erp-validation-081`。截图分别为 Windows 临时目录 `erp-ui-check-8S4mRz` 和 Linux `/tmp/erp-ui-check-cHCudy`。人工查看了真实 Chrome 生成的单据模板设置截图，显示正常。发布前检查拟提交的文件和示例名称，均为程序界面、公司自身品牌或虚构测试内容，没有加入真实客户/产品文件。

## 验证边界

未验证真实服务器的 systemd 首装/开机/崩溃重启、真实离机存储、SSH 和防火墙、公网 TLS、真实 Windows 数据迁移及机器人连接；未调用真实 AI 或语音模型，未做 Office/LibreOffice 和实体打印机打印。以上属于实际部署和设备验收，不冒充本次自动测试结果。

结论：双平台要求的类型检查、全量测试、界面实测、安装包运行与内容检查已通过。用户授权仅在通过检查后发布；提交、附注标签、推送、GitHub Release 的最终状态另记录于结果文件。
