/**
 * 服务端模块的中文名（模块表在 tests/module-map.ts，说明在 docs/架构说明.md“模块”）。
 * 各模块往基础登记删除、初始化规则和可归档的记录种类时写自己的名字，类型是这里的 ModuleName：写错编译不过。
 * tests/module-names.test.ts 核对这张清单和模块表里的服务端模块一样，加、改模块两边一起改。
 */
export const serverModuleNames = [
  '基础',
  '账号',
  'AI接入',
  '系统资料',
  '客户产品订单',
  '采购库存',
  '单据流转',
  '删除归档',
  '订单服务',
  '业务总览',
  '财务',
  '单据导出',
  '识别导入',
  '数据管理',
  '助手',
  '装配',
] as const;
export type ModuleName = (typeof serverModuleNames)[number];
