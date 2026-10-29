export const assistantCapabilities = [
  { module: '仓库日期台账及业务单据导出', state: '已接入并验证', operations: 'flow.daily查询生产及送货/到货日期台账、真实每日汇总；原records.propose_save(deliveries)/flow.schedule创建修改送货计划，flow.propose_confirmation沿原服务确认实发；arrival.plan.save/receive登记计划和验收实收。documents.preview/export/status查询完整模板、生成Word/Excel并交付校验；采购仅下载交付后经原服务标记已订货，计划送货显著非正式，导出不动库存。', validation: '独立虚构库、真实HTTP、文件解包读回及模型替身；未调用收费模型' },
  { module: '仓库采购到货与排程', state: '已接入并验证', operations: 'arrival.plans/arrival.plan.save查询及创建修改未来分批计划；arrival.receive按真实用户的验收事实一次登记正式到货、验收、入库和采购进度；arrival.records统一历史独立凭据及正式单据、验收与对应流水。不猜历史时间或验收，无AI专属重复确认，插件/权限/版本/事务/幂等沿原服务。', validation: '独立虚构数据库、模型替身、真实HTTP与浏览器浅色/深色验收；未调用收费模型' },
  {
    module: '采购到货数量更正与统一履约',
    state: '已接入并验证',
    operations: '读取真实销售/采购逐行及整单履约进度；purchase.receipt.preview/correct同步库存并保留原件、冲销及替代；真实本机最高管理员可按用户明确指令用purchase.receipt.data_edit_preview/data_edit仅改统计、库存不变并登记待核对差异。flow.schedule调整未完成生产任务及送货草稿的plannedDate，排程与实际生产/发货独立。均沿原服务、版本、事务、审计及启停，无AI专属确认。',
    validation: '独立临时库、模型替身、人工页面及桌面/小屏验收；未调用真实收费模型',
  },
  {
    module: '客户、供应商、产品',
    state: '已接入并验证',
    operations: '查询、汇总、单条或批量新增/编辑、停用/恢复；删除为物理删除，归档/恢复为独立操作。',
    validation: '既有工具/业务自动化通过；未逐项完成真实模型验收',
  },
  {
    module: '客户订单、采购订货',
    state: '已接入并验证',
    operations:
      '查询、日期/状态筛选、汇总、新增/编辑、物理删除、独立归档/恢复；本机最高管理员可直接维护历史或已确认记录并同步关联数据。',
    validation: '既有订单/采购自动化通过；未逐项完成真实模型验收',
  },
  {
    module: '原材料、成品、出入库流水',
    state: '已接入并验证',
    operations:
      '库存查询/按单位汇总、流水追溯、库存品编辑；本机最高管理员按明确指令经原服务直接登记出入库/盘点。',
    validation: '既有库存与工具自动化通过；未逐项完成真实模型验收',
  },
  {
    module: '采购到货、生产、客户送货',
    state: '已接入并验证',
    operations:
      '查询、新增/编辑草稿、任务下达、取消；复合生产完工支持真实参数预检、共享整张原料分配、成品档案匹配/创建及正式领料入库；本机最高管理员可直接确认和编辑已确认单据，维护原记录及关联库存；删除执行物理删除。',
    validation: '既有实物服务/事务自动化通过；未逐项完成真实模型验收',
  },
  {
    module: '聊天客户订单识别与导入',
    state: '已接入并验证',
    operations:
      '人工或聊天工作区原地关联、识别、草稿读取/编辑/撤销、档案匹配、完整预览、明确指令后多文件逐份正式导入及幂等回执。',
    validation: '本轮隔离全链路自动化及浏览器验收；真实API结果见报告',
  },
  {
    module: '页面导航、经营概览',
    state: '已接入并验证',
    operations:
      '实时经营汇总、打开业务页或记录；page.observe读取实际控件、表格、表单、弹窗和反馈；page.act执行DOM后备操作；连接独立本机ERP浏览器后browser.capture/act提供真实截图、坐标/键盘/附件上传，需模型支持视觉；业务成功须原服务核验。',
    validation: '助手查询、导航与浏览器测试',
  },
  {
    module: '聊天供应商到货识别',
    state: '尚未接入',
    operations: '现有AI工作区和采购到货页面可操作；聊天附件尚未桥接到货任务。',
    validation: '不宣称聊天已支持',
  },
  {
    module: '提示词管理与非敏感设置',
    state: '通过页面桥接支持非敏感设置',
    operations:
      'prompts.get/propose/save复用现有提示词管理器：读取真实模块、完整方案预览、用户同意后保存并读回核验。其他非敏感设置沿用页面桥接；密码、API密钥及认证区域不进入桥接。',
    validation: '隔离提示词管理器与模拟对话回归，不调用收费模型',
  },
  {
    module: '本机最高管理员数据管理',
    state: '已接入并验证',
    operations:
      'management.execute/context/workspaces与页面复用原服务。登录后直接编辑、更正、归档、恢复、明确范围永久删除及管理识别工作区；普通账号不提升。',
    validation: '临时库与传输桩验证；保留版本、真实会话、工具启停、审计和事务保护',
  },
];
