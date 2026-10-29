# AI智能数据管理：当前架构与后续计划

当前发布版本0.6.0，业务目录33，数据库迁移12。已整合目录27至33的提示词/客户复用、履约与到货更正、日期台账、人工工具覆盖、业务工作台及单据模板升级。Windows原生PowerShell7兼容修复和正常关闭/开发生命周期一起发布，旧5.1兼容调用保留；历史标签不移动。以下描述当前代码；0.5.0—0.5.2的阶段决策完整保存在[历史演进](history/AI架构演进至0.5.2.md)，不以旧阶段限制覆盖现有实现。

## 一、单一业务数据与服务

正式业务以server/db.ts及server/operations/schema.ts、server/flow/schema.ts内的有序迁移为准。现有数据库和审计不能为升级清理而重置。

- 客户、产品、客户订单：server/business/service.ts，复用shared/domain.ts的字段规则。
- 供应商、采购、原料/成品档案及库存：server/operations/service.ts。库存由不可变stock_movements派生，数量千分单位整数，单价十进制最多四位，不同数量单位不自动混算。
- 采购到货统一入口：仓库ArrivalWarehouse复用DateSchedule、FlowPage及原ReceiptRecognition；旧#arrivals跳转仓库，旧ReceiptDialog移除。OperationsService.receive委托FlowService.receivePurchase/save/preview/confirm，原投影只算一次。计划复用arrival草稿并由服务保存planSnapshot，实收/验收/实际入库分开；历史独立凭据只读兼容，不补库存、不猜实际时间。AI arrival.plans/plan.save/receive/records沿原注册表和服务。
- 到货、生产任务、领退料、完工入库及客户送货：server/flow/service.ts。真实关联、单据版本、库存非负、事务、请求幂等和审计共用原服务。
- 履约数量：server/operations/fulfillment.ts统一读取有效到货事件，arrival及其purchase_receipts.flowId投影仅算一次，旧入口独立到货仍有效；shared/fulfillment.ts共用逐行与整单计算，销售只计算有效已确认送货。API独立返回businessStatus/arrivalProgress及status/shippingProgress，不新增第二套持久化状态。
- 管理员历史到货编辑：同一OperationsService显式mode=data-edit，仅真实本机最高管理员使用。原business_audit追加receipt-data-edit，receiptEvents统一派生有效数量及待核对差异，库存流水不变；AI使用purchase.receipt.data_edit_preview/data_edit，最新真实用户模式决定持久保存，不重复失败请求。
- 日期排程：原flow_documents.document兼容plannedDate，生产与送货共用DateSchedule及FlowService.schedule；旧数据沿用date并标识，实际生产/发货独立。
- 到货数量正式更正：OperationsService.previewReceiptCorrection/correctReceipt为页面与AI的共同入口，在同一事务中追加替代和冲销流水、保留原单与更正链、刷新采购累计及库存并读回核验。purchase.receipt.preview/correct沿原business:edit与工具启停，无AI专属重复确认。迁移12只校正派生累计缓存并记录差异审计，不新增台账、不重置业务表、不修改库存流水；备份恢复同时支持12。
- 物理删除、归档、恢复与已确认记录维护：server/business/database-maintenance.ts、management.ts及server/developer-service.ts。删除和归档是不同操作，本机最高管理员通过真实会话能力直接管理；普通账号不提升。
- 明确授权的开发初始化：server/business/development-reset.ts及management.reset。保留原账号、配置与审计；AI工作区清理包含工作原件。该业务能力与项目文件清理无关，项目清理不调用它。

仓库五入口由WarehouseRecords复用DateSchedule及原FlowPage表单；WarehouseDaily统一日期汇总，旧排程链接兼容。BusinessDocuments与documents.preview/export/status共用完整模板和原operation_requests文件/交付回执；预览、生成不改采购状态，完整浏览器交付后经OperationsService.savePurchase标记已订货，失败/冲突/取消不恢复，送货仅本批且不重复出库。详见[仓库日期台账与业务单据导出验收](仓库日期台账与业务单据导出验收-2026-10-29.md)。

## 二、Agent与插件

人工UI能力清单维护在shared/ui-capabilities.ts并进入机器业务目录，新增工具必须通过覆盖检查。BusinessDocuments继续作为人工/AI共同导出服务；模板由shared/document-templates.ts定义、DocumentTemplateSettings经版本及审计保存到原operation_requests，业务映射与AI提示词分离。生产整批完工、批量订单导入、管理员初始化人工入口复用原业务执行器，详见[全局UI能力覆盖与交互验收](全局UI能力覆盖与交互验收-2026-10-29.md)。

只维护AssistantManager、AssistantToolRegistry、AssistantTaskLedger这一套现有执行架构，不建立第二套Agent、工具注册表或业务数据库。

模型通过自定义JSON信封选择注册工具。注册表同时控制真实Actor、最低业务权限、插件和工具启停、输入校验及执行服务可用性。模型、附件、备注和页面内容不能授予新权限；不存在SQL、Shell或源码修改工具。

管理入口统一为AI设置→AI插件与工具管理，聊天按钮指向同页；旧#ai-plugins兼容重定向。插件包含工具，清单及数量来自真实注册表，总开关保留各工具独立设置。

基础查询、创建、编辑、确认、归档、恢复和核验可以组合。management.execute通过原管理服务支持全量选择、分批执行及前序真实结果引用；flow.propose_production_completion复用原生产服务完成参数预检、库存关联、共享整张领料及成品入库。

## 三、任务状态与恢复

工作状态为working、needs_input、completed、blocked。问号或“请确认”等正文不控制停机；有可执行查询、操作或安全恢复步骤时继续后台调用。真实业务歧义、缺少必要业务事实或冲突才集中询问，内部ID和版本先自行查询。

当前任务memory保存真实用户来源的确认、推断、未知和冲突，保留文件顺序。税率不推断含税，单位和物理切割规则不猜测。独立目标自动新建任务，继续沿原任务，历史只复用业务事实，不扩散授权。

每步持久化原回执与检查点；成功业务提交、草稿修改、页面交互和已替代步骤分别记录。完成由真实结果核验，不能由模型声明替代。版本冲突只在目标字段无冲突时安全重基；未知写入和未知计费识别先核验，不盲目重放。

提示词通过现有注册表的prompts.get/propose/save复用各模块PromptPresetManager，权限与原HTTP管理接口相同。任务memory.promptEdit记录讨论、拟定、已展示和已核验保存阶段，保存绑定最新展示方案与后续真实用户同意；润色撤销旧方案的保存资格。完整文字由服务器直接展示，不能以问句或不存在的“上述文字”代替。保存后读回核验即可结束，不再额外调用模型请求重复确认。

模型/工具/写入/页面交互次数默认0为持续执行，超时默认2小时，均由服务端配置。无进展、连续失败和用户停止保留，原历史台账不因上下文压缩删除。完整配置及真实/估算Token说明见[README](../README.md)。

## 四、订单原件与Provider

客户采购订单作为本厂销售订单处理。原件、文件哈希、草稿修订、客户/产品匹配、完整预览和正式ImportExecutionService共用人工工作区，不复制第二套订单。已导入原件和正式执行回执不重放；部分成功逐份保留。

客户复用由customer-resolution共用解析：名称仅规范化空白、Unicode排版，结合真实历史订单关联确定身份；相似候选返回联系信息及归档状态，不按去掉地区或公司后缀后的短名直接合并。每份正式导入前刷新映射，首份新建后的真实ID立即供后续工作区复用；同客户的明确任务决定仅在当前批次/任务的正式回执范围内辅助匹配。归档客户明确提示恢复，不能静默恢复或重复新建。

Responses支持的供应商使用原件直传；DeepSeek官方兼容路径仅在既有授权范围内安全提取文字或将扫描PDF转图，不执行OCR，不虚报input_file能力。普通聊天附件使用无业务工具的隔离阅读器；附件文字不能授权写入。

Provider保持独立适配，协议、流式终结、结束原因、用量、错误和重试分别校验。密钥仅服务端DPAPI加密，不能进入Git、浏览器或普通日志。完整原件外发和付费识别沿原范围授权，不外发完整业务库。

## 五、页面与浏览器后备

page.observe/act/verify控制当前ERP标签页DOM，支持概要、区域、记录、完整观察及表格分页、增量反馈。控件身份和快照有效性保留，排除密码、密钥及认证区域；点击不等于业务成功。

browser.capture/act沿当前真实会话连接独立本机ERP浏览器，使用实际Chrome/Edge和真实PNG，支持视区坐标、键盘、滚动及当前聊天附件上传。只访问本实例，拒绝旧图像、跨账号和敏感输入。它不复制原标签页未保存状态，也不控制Windows、其他网站或凭据；模型须支持图片。

## 六、扩展约定

1. 新业务模块同时维护共享Schema、服务、机器可读目录、实际权限、关联/删除检查和临时库测试；未实现的模块不得声明为可执行工具。
2. 通过registerPlugin扩展现有注册表；声明只能增加权限，不能降低系统最低权限。保留业务服务独立权限检查。
3. 原parse-worker隔离解析、旧路由、旧组件导出和语音命令仍有运行/测试/兼容用途。不能因没有普通静态import就删除。
4. 批量和复合操作只编排原服务，保证真实关联、正确数量、事务和幂等；共享领料分配不等于物理排版证明。
5. 测试只用独立临时虚构业务库及模型替身，不能修改真实data/erp.sqlite或为了验证调用收费模型。

## 七、下一阶段

- 以更多独立虚构业务样本扩展跨模块目标和模型行为评估，不绕过原服务校验。
- 补齐普通业务账号与部署场景的持续权限回归，保留当前本机管理员体验。
- 在现有工作区内完善供应商到货的聊天编排；不复制识别服务或业务数据。
- 将物理切割、跨型号共享、实际投入和废品归属作为明确业务模型研究，不能用数量除法替代排版事实。
- 继续优化上下文和视觉兼容性；真实模型成功率、部署、备份恢复及用户实际业务流程仍需单独验收。

当前工程入口、受保护数据及兼容清单见[项目目录与维护](项目目录与维护.md)。行为验收见[自主Agent验收](ERP自主Agent架构升级验收-2026-10-28.md)和[0.5.3清理与验证](项目清理与0.5.3验收-2026-10-28.md)。

本轮订单履约与到货更正的事务、兼容边界及验收见[履约与到货更正验收](订单履约与采购到货更正验收-2026-10-29.md)。

本轮管理员数据编辑、深色主题和生产/送货排程见[验收记录](管理员数据编辑与日期排程验收-2026-10-29.md)。

本轮采购到货链路、仓库UI与AI整合见[验收记录](采购到货仓库整合验收-2026-10-29.md)。


## 全面UI与模板升级（目录33）

工作台通过原FlowService、WarehouseDaily及采购/库存仓储读取实时待办；详情只读关联API连接生产、到货、完工和送货，实际写入仍走原服务。模板入口统一为AI设置第四页签，多模板、默认选择、字段显隐和顺序、字体/A4、纯虚构样张预览与导出沿原权限和审计。新确认送货在原document JSON保存客户料号、订单号、价格及本批精确金额快照；历史无价格快照不猜测。原ProductionCompletion创建成品用真实产品规格，不能把客户料号当规格。默认助手入口停靠顶栏，悬浮精灵可选，聊天拖动缩放保留。

完整设计、参考及隔离验收见[ERP全面UI优化与单据模板升级验收](ERP全面UI优化与单据模板升级验收-2026-10-29.md)。本轮未提交、推送或发布。
