// 单据导出的表在删除、初始化时怎么处理（登记接口见 server/core/deletion-rules.ts）。由本模块的 index.ts 引入。
// 导出记录（document_exports）的 record_id 没有外键：采购单、送货单被删以后导出记录照旧留着，所以不登记删除规则，
// 只在初始化（清空业务数据）时清。单据模板设置（document_template_settings）不登记，初始化后保留。
import { registerReset } from '../core/index.js';

registerReset({
  module: '单据导出',
  // 排在采购库存（40，先清引用导出记录的订货批次）后面、基础（50）前面
  order: 45,
  statements: ['DELETE FROM document_exports'],
});
