# 宁波甬勒包装制品有限公司 · 管理系统

面向外购瓦楞纸板、厂内加工纸箱的本地 ERP。当前版本 **0.5.3**（Git 标签 `v0.5.3`）。

> 本机开发测试版本。正式投产前，请完成数据备份恢复、网络部署和真实业务流程验收。

## 主要功能

- 客户、供应商、产品、客户订单、采购订货与经营概览。
- 分批到货、原材料/成品库存、不可变库存流水、生产任务与登记、客户送货、订单履约。
- AI 订单/到货单识别、原件预览、可编辑草稿、人工核对后正式导入。
- 全局 AI 助手、附件阅读、业务工具、插件与页面控制、本地语音输入。
- 登录、权限、归档、物理删除、审计及本机数据管理。

## Windows 本地启动

安装 **Node.js 24.15 或更高 24.x 版本**和 Git，进入项目目录执行：

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd start
```

浏览器访问 `http://127.0.0.1:3001`。

- 首次使用在登录页创建管理员账号，系统不会生成默认密码或示例业务数据。
- 日常使用可双击“启动系统.cmd”；“停止系统.cmd”会在核验进程后停止服务。
- 源码开发执行 `npm.cmd run dev`：前端 5173，后端 3001。

## 数据与备份

业务数据、AI 原件/草稿/聊天记录、导入归档、提示词和工具设置均保存在项目下的 `data/`；AI 服务地址、模型和加密密钥保存在本机的 `%LOCALAPPDATA%\ZhixuERP\ai\settings.sqlite`。这些数据不进入 Git。

```powershell
npm.cmd run backup
npm.cmd run restore -- "备份文件绝对路径"
```

建议定期备份整个 `data/` 和 AI 配置；复制 SQLite 时先停止程序，并连同 WAL 文件一起备份。更新现有副本前先备份，再执行 `git pull --ff-only`、`npm.cmd ci`、`npm.cmd run build`。Git 只保存程序代码，不能代替业务数据备份。

## AI 与语音

在“AI 设置 → API 配置”填写服务地址、密钥并选择模型；密钥只保存在后端，由 Windows DPAPI 保护。识别和聊天会把相关单据或消息发送给已配置的 AI 服务，请在使用前确认外发范围。

本地语音模型不随 Git 上传。需要语音输入时，将完整的 `vendor/models/sensevoice` 目录放回项目；没有模型不影响文字聊天和 ERP 功能。

## 开发与验证

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

测试使用独立临时数据库，不会清空实际业务库。仓库包含本地 xlsx 依赖包，请勿删除 `vendor/xlsx-0.20.3.tgz` 后再执行安装。

## 文档与发布

- [0.5.3 发布说明](docs/发布说明-v0.5.3.md)
- [项目目录与维护](docs/项目目录与维护.md)
- [架构与开发计划](docs/AI智能数据管理架构与开发计划.md)
- [GitHub Releases](https://github.com/empitor/yongle-carton-erp/releases/tag/v0.5.3)
