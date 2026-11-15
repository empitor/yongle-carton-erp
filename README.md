# 甬勒纸箱厂 ERP

宁波甬勒包装制品有限公司自用的纸箱厂管理系统：收客户文件、接单、采购订料、到货、生产、送货、每月算账都在一个系统里，AI（DeepSeek）帮忙识别文件和办日常操作。不接 AI 也能用全部业务功能。

当前版本 **0.9.0**，支持 Windows x64 和 Ubuntu 24.04 LTS x64，数据保存在自己的电脑或服务器上。界面只有中文，金额只有人民币。

## 安装使用

到 [GitHub 发布页](https://github.com/empitor/yongle-carton-erp/releases) 下载 0.9.0 的完整安装包（Windows 用 `win-x64.zip`，Linux 用 `linux-x64.tar.gz`，各附 sha256）。从 0.8.x 升级不能用补丁，只能装这个完整包，业务数据从新库开始，步骤见[部署与运维](docs/部署与运维.md)“升级到 0.9.0”。

**Windows：**

1. 解压到一个固定的文件夹，比如 `D:\纸箱厂ERP`，不要在压缩包里直接运行。
2. 双击 `启动系统.cmd`，浏览器自动打开 `http://127.0.0.1:3001`。用完双击 `停止系统.cmd`。
3. 第一次打开时在页面上建管理员账号（没有默认密码，也没有示例数据）。
4. 要用 AI：管理员到“设置 → API 配置”填 DeepSeek 密钥。

启动不了时：提示“已保护你的电脑”点“更多信息 → 仍要运行”；缺 DLL 装微软 [VC++ 运行库](https://aka.ms/vs/17/release/vc_redist.x64.exe)；3001 端口被占用先关掉占用的程序。

**Linux 服务器：** 见[部署与运维](docs/部署与运维.md)。备份、恢复、升级（含 0.8.x 升 0.9.0 要先移走旧业务库）也在那里。

## 从源码运行

需要 Node.js 24.15 或更高的 24.x，以及 Git。

```bash
npm.cmd ci
npm.cmd run dev
```

前端在 5173 端口，后端在 3001 端口。

## 检查

| 命令 | 作用 |
|---|---|
| `npx tsc --noEmit` | 类型检查 |
| `npm.cmd test` | 全部自动测试（发布检查除外），只用虚构数据和临时目录，半分钟左右 |
| `npm.cmd test -- tests/<文件>.test.ts` | 只跑点名的测试 |
| `npm.cmd run test:ui` | 隔离实例加虚构数据，在无头 Chrome 里走主要界面流程；`-- 组名` 只跑几组，`-- --list` 列出组 |
| `npm.cmd run test:release` | 发布前检查：发布扫描、补丁和整包、备份恢复演练 |
| `npx vite build --outDir <临时目录> --emptyOutDir` | 构建检查（输出到临时目录，不覆盖正在用的 `dist`） |
| `npm.cmd run package` | 生成安装包 |

## 文档

- [文档目录](docs/README.md)：每份文档管什么。
- [使用手册](docs/使用手册.md)：怎么用。
- [部署与运维](docs/部署与运维.md)：部署、升级、备份、排查。
- [更新日志](docs/CHANGELOG.md)：最近一个版本（或还没发布）的改动。以前的版本看 Git 标签和 GitHub 发布。

## 许可

代码公开，版权归宁波甬勒包装制品有限公司所有，保留所有权利，见 [LICENSE](LICENSE)。几处移植自开源项目的代码，许可和出处见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
